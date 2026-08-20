import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The client half of the chunked upload. What matters here is the sequencing
 * and the cleanup: chunks strictly in order because the agent refuses anything
 * else rather than writing at the wrong offset, and an abort request on every
 * failure path so a dead upload does not leave a temp file sitting in the
 * user's directory until the idle sweep.
 *
 * The transport is injected. That is the codebase's existing idiom for module
 * dependencies, and it avoids a loader hook just to intercept one import.
 */

// --- Browser shims. The module reads File slices through FileReader. ---
class FakeBlob {
  constructor(bytes) { this.bytes = Buffer.from(bytes); }
  get size() { return this.bytes.length; }
  slice(start, end) { return new FakeBlob(this.bytes.subarray(start, end)); }
}

class FakeFile extends FakeBlob {
  constructor(name, bytes) { super(bytes); this.name = name; }
}

class FakeFileReader {
  readAsDataURL(blob) {
    // Matching the real shape, prefix and all, since the module strips it.
    this.result = `data:application/octet-stream;base64,${blob.bytes.toString('base64')}`;
    queueMicrotask(() => this.onload?.());
  }
}

globalThis.FileReader = FakeFileReader;

// --- Transport stub. Records every call so ordering can be asserted. ---
const calls = [];
let handler = null;

const request = (method, path, body, agentId) => {
  calls.push({ method, path, body, agentId });
  return handler(path, body);
};

const { uploadFile, uploadFiles, isCollision, UploadCancelled } =
  await import('../src-client/modules/file-upload.js');

function reset(h) {
  calls.length = 0;
  handler = h;
}

// A cooperative agent: hands out a chunk size, accepts everything, commits.
function happyAgent({ chunkSize = 4, path = '/home/u/dir/f.txt' } = {}) {
  let received = 0;
  return (p, body) => {
    if (p.endsWith('/begin')) return Promise.resolve({ id: 'up1', path, chunkSize });
    if (p.endsWith('/chunk')) {
      received += Buffer.from(body.data, 'base64').length;
      return Promise.resolve({ received, total: body.total });
    }
    if (p.endsWith('/commit')) return Promise.resolve({ success: true, path, fileName: 'f.txt', size: received });
    if (p.endsWith('/abort')) return Promise.resolve({ success: true });
    return Promise.reject(new Error(`unexpected ${p}`));
  };
}

const chunkCalls = () => calls.filter(c => c.path.endsWith('/chunk'));

test('a file is sent as ordered chunks and committed', async () => {
  reset(happyAgent({ chunkSize: 4 }));
  const file = new FakeFile('f.txt', 'abcdefghij'); // 10 bytes, chunk 4 -> 3 chunks

  const result = await uploadFile({ file, dir: '/home/u/dir', agentId: 'a1', request });

  assert.equal(result.success, true);
  const chunks = chunkCalls();
  assert.equal(chunks.length, 3);
  // Sequence numbers must be consecutive from zero: the agent rejects any gap.
  assert.deepEqual(chunks.map(c => c.body.seq), [0, 1, 2]);
  // And the bytes must reassemble to the original.
  const joined = Buffer.concat(chunks.map(c => Buffer.from(c.body.data, 'base64'))).toString();
  assert.equal(joined, 'abcdefghij');
  assert.equal(calls.at(-1).path, '/api/files/upload/commit');
});

test('the chunk size comes from the agent, not from the client', async () => {
  // Hardcoding it either side would let an agent update desync the two.
  reset(happyAgent({ chunkSize: 2 }));
  await uploadFile({ file: new FakeFile('f.txt', 'abcdef'), dir: '/home/u/dir', request });
  assert.equal(chunkCalls().length, 3);

  reset(happyAgent({ chunkSize: 6 }));
  await uploadFile({ file: new FakeFile('f.txt', 'abcdef'), dir: '/home/u/dir', request });
  assert.equal(chunkCalls().length, 1);
});

test('begin declares the joined destination path and the size', async () => {
  reset(happyAgent());
  await uploadFile({ file: new FakeFile('report.pdf', 'xyz'), dir: '/home/u/docs/', request });

  const begin = calls[0];
  assert.equal(begin.path, '/api/files/upload/begin');
  // The trailing slash on the directory must not double up.
  assert.equal(begin.body.path, '/home/u/docs/report.pdf');
  assert.equal(begin.body.size, 3);
  assert.equal(begin.body.collision, 'error');
});

test('an empty file still begins and commits', async () => {
  reset(happyAgent());
  const result = await uploadFile({ file: new FakeFile('empty.txt', ''), dir: '/home/u', request });
  assert.equal(result.success, true);
  assert.equal(chunkCalls().length, 0, 'no chunks to send');
});

test('progress is reported from zero through to the full size', async () => {
  reset(happyAgent({ chunkSize: 4 }));
  const seen = [];
  await uploadFile({
    file: new FakeFile('f.txt', 'abcdefghij'),
    dir: '/home/u',
    request,
    onProgress: (p) => seen.push(p.sent),
  });
  assert.deepEqual(seen, [0, 4, 8, 10]);
});

test('a failed chunk aborts the upload on the agent', async () => {
  // Otherwise the temp file lingers until the idle sweep.
  reset((p) => {
    if (p.endsWith('/begin')) return Promise.resolve({ id: 'up1', chunkSize: 4 });
    if (p.endsWith('/chunk')) return Promise.reject(new Error('relay went away'));
    if (p.endsWith('/abort')) return Promise.resolve({ success: true });
    return Promise.reject(new Error('unexpected'));
  });

  await assert.rejects(
    () => uploadFile({ file: new FakeFile('f.txt', 'abcdefgh'), dir: '/home/u', request }),
    /relay went away/,
  );
  assert.ok(calls.some(c => c.path.endsWith('/abort')), 'the agent must be told to clean up');
});

test('a failed commit also aborts', async () => {
  reset((p) => {
    if (p.endsWith('/begin')) return Promise.resolve({ id: 'up1', chunkSize: 4 });
    if (p.endsWith('/chunk')) return Promise.resolve({});
    if (p.endsWith('/commit')) return Promise.reject(new Error('Incomplete upload'));
    if (p.endsWith('/abort')) return Promise.resolve({ success: true });
    return Promise.reject(new Error('unexpected'));
  });

  await assert.rejects(() => uploadFile({ file: new FakeFile('f.txt', 'abcd'), dir: '/home/u', request }), /Incomplete/);
  assert.ok(calls.some(c => c.path.endsWith('/abort')));
});

test('a failed begin sends no chunks and needs no abort', async () => {
  // Nothing was opened, so there is nothing to clean up.
  reset((p) => p.endsWith('/begin')
    ? Promise.reject(new Error('File exceeds the 100MB upload limit'))
    : Promise.reject(new Error('should not be reached')));

  await assert.rejects(() => uploadFile({ file: new FakeFile('big.bin', 'x'), dir: '/home/u', request }), /100MB/);
  assert.equal(chunkCalls().length, 0);
  assert.equal(calls.filter(c => c.path.endsWith('/abort')).length, 0);
});

test('cancelling stops between chunks and aborts', async () => {
  const controller = new AbortController();
  reset((p, body) => {
    if (p.endsWith('/begin')) return Promise.resolve({ id: 'up1', chunkSize: 4 });
    if (p.endsWith('/chunk')) {
      // Cancel after the first chunk lands.
      if (body.seq === 0) controller.abort();
      return Promise.resolve({});
    }
    if (p.endsWith('/abort')) return Promise.resolve({ success: true });
    return Promise.reject(new Error('unexpected'));
  });

  await assert.rejects(
    () => uploadFile({
      file: new FakeFile('f.txt', 'abcdefghijkl'),
      dir: '/home/u',
      request,
      signal: controller.signal,
    }),
    (e) => e instanceof UploadCancelled,
  );

  assert.equal(chunkCalls().length, 1, 'no further chunks after the cancel');
  assert.ok(calls.some(c => c.path.endsWith('/abort')));
  assert.ok(!calls.some(c => c.path.endsWith('/commit')), 'a cancelled upload must not commit');
});

test('a batch reports per-file outcomes instead of failing whole', async () => {
  // One unwritable file should not discard the rest of a drop.
  reset((p, body) => {
    if (p.endsWith('/begin')) {
      return body.path.endsWith('bad.txt')
        ? Promise.reject(new Error('Destination directory does not exist'))
        : Promise.resolve({ id: 'u', chunkSize: 8 });
    }
    if (p.endsWith('/chunk')) return Promise.resolve({});
    if (p.endsWith('/commit')) return Promise.resolve({ success: true });
    if (p.endsWith('/abort')) return Promise.resolve({ success: true });
    return Promise.reject(new Error('unexpected'));
  });

  const results = await uploadFiles({
    files: [new FakeFile('a.txt', 'aa'), new FakeFile('bad.txt', 'bb'), new FakeFile('c.txt', 'cc')],
    dir: '/home/u',
    request,
  });

  assert.deepEqual(results.map(r => r.status), ['done', 'failed', 'done']);
});

test('a collision asks, and the answer is applied on the retry', async () => {
  let attempts = 0;
  reset((p, body) => {
    if (p.endsWith('/begin')) {
      attempts += 1;
      if (body.collision === 'error') return Promise.reject(new Error('File already exists: /home/u/x.txt'));
      return Promise.resolve({ id: 'u', chunkSize: 8 });
    }
    if (p.endsWith('/chunk')) return Promise.resolve({});
    if (p.endsWith('/commit')) return Promise.resolve({ success: true });
    return Promise.reject(new Error('unexpected'));
  });

  const asked = [];
  const results = await uploadFiles({
    files: [new FakeFile('x.txt', 'hi')],
    dir: '/home/u',
    request,
    onCollision: (f) => { asked.push(f.name); return 'overwrite'; },
  });

  assert.deepEqual(asked, ['x.txt']);
  assert.equal(attempts, 2, 'begin is retried with the chosen policy');
  assert.equal(results[0].status, 'done');
  assert.equal(calls.filter(c => c.path.endsWith('/begin')).at(-1).body.collision, 'overwrite');
});

test('skipping a collision sends no bytes for that file', async () => {
  reset((p, body) => {
    if (p.endsWith('/begin')) {
      if (body.collision === 'error') return Promise.reject(new Error('File already exists'));
      return Promise.resolve({ id: 'u', chunkSize: 8 });
    }
    return Promise.reject(new Error('unexpected'));
  });

  const results = await uploadFiles({
    files: [new FakeFile('x.txt', 'hi')],
    dir: '/home/u',
    request,
    onCollision: () => 'skip',
  });

  assert.equal(results[0].status, 'skipped');
  assert.equal(chunkCalls().length, 0);
});

test('with no collision handler a clash is skipped rather than guessed at', async () => {
  reset((p) => p.endsWith('/begin')
    ? Promise.reject(new Error('File already exists'))
    : Promise.reject(new Error('unexpected')));

  const results = await uploadFiles({ files: [new FakeFile('x.txt', 'hi')], dir: '/home/u', request });
  assert.equal(results[0].status, 'skipped');
});

test('a cancelled batch stops starting new files', async () => {
  const controller = new AbortController();
  controller.abort();

  reset(happyAgent());
  const results = await uploadFiles({
    files: [new FakeFile('a.txt', 'a'), new FakeFile('b.txt', 'b')],
    dir: '/home/u',
    request,
    signal: controller.signal,
  });

  assert.deepEqual(results.map(r => r.status), ['cancelled', 'cancelled']);
  assert.equal(calls.length, 0, 'an already-cancelled batch touches the agent not at all');
});

test('isCollision recognises the agent message across shapes', () => {
  // The relay rebuilds the error from its message, so the EEXIST code does not
  // survive the trip and the text is all there is to go on.
  assert.ok(isCollision(new Error('File already exists: /home/u/x.txt')));
  assert.ok(isCollision(Object.assign(new Error('nope'), { code: 'EEXIST' })));
  assert.ok(isCollision(new Error('EEXIST: file already exists')));
  assert.equal(isCollision(new Error('Destination is a directory')), false);
  assert.equal(isCollision(new Error('Agent request timeout')), false);
  assert.equal(isCollision(undefined), false);
});
