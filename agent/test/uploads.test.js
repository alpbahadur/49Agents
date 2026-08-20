import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  beginUpload, appendChunk, commitUpload, abortUpload, nextAvailablePath,
  CHUNK_SIZE, MAX_UPLOAD_BYTES, _activeUploadCount,
} from '../services/uploads.js';

/**
 * Uploads are chunked because the relay caps a message at 1MB and chunks
 * arrive base64-encoded, inflating them by a third. That makes the interesting
 * cases the ones between chunks: a lost chunk, a reordered chunk, a client that
 * vanishes half way.
 *
 * The invariant these tests defend is that the destination path only ever holds
 * a complete file. Bytes land in a temp file and are renamed in on commit, so
 * an interrupted upload must leave nothing at the destination — not a
 * truncated file that later reads as real.
 *
 * Temp dirs are created under /tmp rather than os.tmpdir(): the permitted roots
 * are $HOME and the literal /tmp, and on macOS os.tmpdir() is
 * /var/folders/... which is under neither. Using it made every test fail on
 * path validation before reaching what it was actually checking.
 */

// Async-aware on purpose: awaiting fn before the finally runs. A synchronous
// version returns the callback's promise and tears the directory down while the
// test is still using it, which surfaces as ENOENT on the temp file rather than
// as anything resembling the real cause.
async function withDir(fn) {
  // Canonical, because validateWorkingDirectory now follows symlinks and
  // returns the resolved path — and on macOS /tmp is a symlink to /private/tmp,
  // so an uncanonicalised dir would not match what the paths come back as.
  const dir = realpathSync(mkdtempSync(join('/tmp', 'upload-test-')));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const b64 = (s) => Buffer.from(s).toString('base64');

// Anything left behind by an interrupted upload, so a test can assert the
// directory is genuinely clean rather than just missing the destination.
const leftovers = (dir) => readdirSync(dir);

test('a single-chunk upload writes the file', async () => {
  await withDir(async (dir) => {
    const dest = join(dir, 'hello.txt');
    const { id } = beginUpload({ path: dest, size: 5 });
    appendChunk({ id, seq: 0, data: b64('hello') });
    const result = await commitUpload({ id });

    assert.equal(result.success, true);
    assert.equal(result.path, dest);
    assert.equal(result.fileName, 'hello.txt');
    assert.equal(readFileSync(dest, 'utf-8'), 'hello');
  });
});

test('chunks are concatenated in order', async () => {
  await withDir(async (dir) => {
    const dest = join(dir, 'multi.txt');
    const parts = ['alpha', 'beta', 'gamma'];
    const total = parts.join('').length;

    const { id } = beginUpload({ path: dest, size: total });
    parts.forEach((p, i) => appendChunk({ id, seq: i, data: b64(p) }));
    await commitUpload({ id });

    assert.equal(readFileSync(dest, 'utf-8'), 'alphabetagamma');
  });
});

test('binary content survives the base64 round trip', async () => {
  await withDir(async (dir) => {
    const dest = join(dir, 'blob.bin');
    // Every byte value, so a latin1/utf8 confusion anywhere would corrupt it.
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const { id } = beginUpload({ path: dest, size: bytes.length });
    appendChunk({ id, seq: 0, data: bytes.toString('base64') });
    await commitUpload({ id });

    assert.deepEqual(readFileSync(dest), bytes);
  });
});

test('an empty file is a legitimate upload', async () => {
  await withDir(async (dir) => {
    const dest = join(dir, 'empty.txt');
    const { id } = beginUpload({ path: dest, size: 0 });
    const result = await commitUpload({ id });

    assert.equal(result.size, 0);
    assert.equal(readFileSync(dest, 'utf-8'), '');
  });
});

test('the destination holds nothing until commit', async () => {
  await withDir(async (dir) => {
    const dest = join(dir, 'pending.txt');
    const { id } = beginUpload({ path: dest, size: 5 });
    appendChunk({ id, seq: 0, data: b64('hello') });

    // The whole point of the temp-file-then-rename design.
    assert.equal(existsSync(dest), false, 'destination must not exist before commit');

    await commitUpload({ id });
    assert.equal(existsSync(dest), true);
  });
});

test('an out-of-order chunk is refused rather than written at the wrong offset', async () => {
  await withDir(async (dir) => {
    const dest = join(dir, 'ordered.txt');
    const { id } = beginUpload({ path: dest, size: 10 });
    appendChunk({ id, seq: 0, data: b64('aaaaa') });

    // Skipping seq 1 would append seq 2's bytes at seq 1's offset, producing a
    // file that is the right length and silently wrong.
    assert.throws(() => appendChunk({ id, seq: 2, data: b64('ccccc') }), /Out-of-order/);
    // A replay of an already-written chunk is equally refused.
    assert.throws(() => appendChunk({ id, seq: 0, data: b64('aaaaa') }), /Out-of-order/);
  });
});

test('an incomplete upload is refused at commit and leaves nothing behind', async () => {
  await withDir(async (dir) => {
    const dest = join(dir, 'short.txt');
    const { id } = beginUpload({ path: dest, size: 10 });
    appendChunk({ id, seq: 0, data: b64('aaaaa') });

    await assert.rejects(() => commitUpload({ id }), /Incomplete upload/);
    assert.equal(existsSync(dest), false);
    assert.deepEqual(leftovers(dir), [], 'the temp file must be cleaned up too');
  });
});

test('a chunk overrunning the declared size aborts the upload', async () => {
  await withDir(async (dir) => {
    const dest = join(dir, 'overrun.txt');
    const { id } = beginUpload({ path: dest, size: 4 });

    assert.throws(() => appendChunk({ id, seq: 0, data: b64('much longer than four') }), /exceeded its declared size/);
    assert.equal(existsSync(dest), false);
    assert.deepEqual(leftovers(dir), []);
    // The upload is gone, so further chunks have nothing to attach to.
    assert.throws(() => appendChunk({ id, seq: 1, data: b64('x') }), /Unknown upload id/);
  });
});

test('cancelling removes the temp file and forgets the upload', async () => {
  await withDir(async (dir) => {
    const dest = join(dir, 'cancelled.txt');
    const { id } = beginUpload({ path: dest, size: 100 });
    appendChunk({ id, seq: 0, data: b64('partial') });

    abortUpload(id);

    assert.equal(existsSync(dest), false);
    assert.deepEqual(leftovers(dir), []);
    assert.throws(() => appendChunk({ id, seq: 1, data: b64('x') }), /Unknown upload id/);
  });
});

test('cancelling twice is not an error', async () => {
  await withDir(async (dir) => {
    const { id } = beginUpload({ path: join(dir, 'x.txt'), size: 1 });
    assert.deepEqual(abortUpload(id), { success: true });
    assert.deepEqual(abortUpload(id), { success: true });
    assert.deepEqual(abortUpload('never-existed'), { success: true });
  });
});

test('an unknown id is refused on every operation', async () => {
  assert.throws(() => appendChunk({ id: 'nope', seq: 0, data: b64('x') }), /Unknown upload id/);
  await assert.rejects(() => commitUpload({ id: 'nope' }), /Unknown upload id/);
});

test('a collision is refused by default', async () => {
  await withDir(async (dir) => {
    const dest = join(dir, 'taken.txt');
    writeFileSync(dest, 'original');

    // Refused before any bytes are accepted, so the user is asked immediately
    // rather than after waiting for a large transfer.
    assert.throws(() => beginUpload({ path: dest, size: 5 }), /already exists/);
    try {
      beginUpload({ path: dest, size: 5 });
    } catch (e) {
      assert.equal(e.code, 'EEXIST', 'the client needs to distinguish this from a hard failure');
    }
    assert.equal(readFileSync(dest, 'utf-8'), 'original');
  });
});

test('overwrite replaces the file only once the upload completes', async () => {
  await withDir(async (dir) => {
    const dest = join(dir, 'replace.txt');
    writeFileSync(dest, 'original');

    const { id } = beginUpload({ path: dest, size: 3, collision: 'overwrite' });
    appendChunk({ id, seq: 0, data: b64('new') });

    // Still the old content: an overwrite that dies half way must not have
    // destroyed the original.
    assert.equal(readFileSync(dest, 'utf-8'), 'original');

    await commitUpload({ id });
    assert.equal(readFileSync(dest, 'utf-8'), 'new');
  });
});

test('an abandoned overwrite leaves the original intact', async () => {
  await withDir(async (dir) => {
    const dest = join(dir, 'survivor.txt');
    writeFileSync(dest, 'original');

    const { id } = beginUpload({ path: dest, size: 50, collision: 'overwrite' });
    appendChunk({ id, seq: 0, data: b64('partial') });
    abortUpload(id);

    assert.equal(readFileSync(dest, 'utf-8'), 'original');
    assert.deepEqual(leftovers(dir), ['survivor.txt']);
  });
});

test('keep-both suffixes before the extension', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'notes.md'), 'first');

    const { id, path: chosen } = beginUpload({ path: join(dir, 'notes.md'), size: 6, collision: 'keep-both' });
    assert.equal(chosen, join(dir, 'notes-1.md'), 'notes.md-1 would break the file type');
    appendChunk({ id, seq: 0, data: b64('second') });
    await commitUpload({ id });

    assert.equal(readFileSync(join(dir, 'notes.md'), 'utf-8'), 'first');
    assert.equal(readFileSync(join(dir, 'notes-1.md'), 'utf-8'), 'second');
  });
});

test('keep-both keeps counting past the first suffix', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'a.txt'), '');
    writeFileSync(join(dir, 'a-1.txt'), '');
    assert.equal(nextAvailablePath(join(dir, 'a.txt')), join(dir, 'a-2.txt'));
  });
});

test('nextAvailablePath handles a name with no extension', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'Makefile'), '');
    assert.equal(nextAvailablePath(join(dir, 'Makefile')), join(dir, 'Makefile-1'));
    // A free name is returned unchanged.
    assert.equal(nextAvailablePath(join(dir, 'free.txt')), join(dir, 'free.txt'));
  });
});

test('a path outside the permitted roots is refused', () => {
  // Upload is the one operation that puts caller-chosen bytes on disk, so it
  // gets no wider reach than the existing file operations.
  assert.throws(() => beginUpload({ path: '/etc/passwd', size: 1 }), /not allowed/);
  assert.throws(() => beginUpload({ path: '/usr/local/bin/x', size: 1 }), /not allowed/);
});

test('traversal out of a permitted root is refused', () => {
  // The path has to start inside a permitted root for this to mean anything.
  // validateWorkingDirectory prefix-matches without normalising, so
  // '/tmp/../etc/shadow' satisfies its check on its own — beginUpload resolves
  // first, which is what actually refuses this.
  assert.throws(() => beginUpload({ path: '/tmp/../etc/shadow', size: 1 }), /not allowed/);
  assert.throws(() => beginUpload({ path: '/tmp/./../etc/hosts', size: 1 }), /not allowed/);
  assert.throws(() => beginUpload({ path: `${process.env.HOME}/../../etc/passwd`, size: 1 }), /not allowed/);
});

test('a tilde path is expanded and stays inside home', () => {
  // ~ has to expand before validation or it fails as a literal directory name.
  assert.throws(() => beginUpload({ path: '~/../../etc/passwd', size: 1 }), /not allowed/);
  // And a legitimate tilde path resolves into home rather than being rejected.
  assert.throws(
    () => beginUpload({ path: '~/definitely-no-such-dir-49a/f.txt', size: 1 }),
    /Destination directory does not exist/,
  );
});

test('a missing destination directory is refused', async () => {
  await withDir(async (dir) => {
    assert.throws(
      () => beginUpload({ path: join(dir, 'no-such-dir', 'f.txt'), size: 1 }),
      /Destination directory does not exist/,
    );
  });
});

test('a destination that is a directory is refused', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, 'adir'));
    assert.throws(() => beginUpload({ path: join(dir, 'adir'), size: 1 }), /is a directory/);
  });
});

test('the size ceiling is enforced before any bytes are accepted', async () => {
  await withDir(async (dir) => {
    assert.throws(
      () => beginUpload({ path: join(dir, 'huge.bin'), size: MAX_UPLOAD_BYTES + 1 }),
      /exceeds the 100MB upload limit/,
    );
    assert.deepEqual(leftovers(dir), [], 'a refused upload must not create a temp file');
  });
});

test('a nonsensical size is refused', async () => {
  await withDir(async (dir) => {
    const dest = join(dir, 'bad.txt');
    assert.throws(() => beginUpload({ path: dest, size: -1 }), /non-negative/);
    assert.throws(() => beginUpload({ path: dest, size: 'lots' }), /non-negative/);
    assert.throws(() => beginUpload({ path: dest }), /non-negative/);
  });
});

test('a missing path is refused', () => {
  assert.throws(() => beginUpload({ size: 1 }), /path is required/);
  assert.throws(() => beginUpload({}), /path is required/);
});

test('a non-string chunk is refused', async () => {
  await withDir(async (dir) => {
    const { id } = beginUpload({ path: join(dir, 'x.txt'), size: 10 });
    assert.throws(() => appendChunk({ id, seq: 0, data: Buffer.from('raw') }), /base64 string/);
    assert.throws(() => appendChunk({ id, seq: 0, data: null }), /base64 string/);
  });
});

test('concurrent uploads of the same name do not collide on their temp files', async () => {
  await withDir(async (dir) => {
    // Both target the same name; the second is told to keep both. Their temp
    // paths must differ or one would clobber the other mid-flight.
    const a = beginUpload({ path: join(dir, 'same.txt'), size: 1, collision: 'overwrite' });
    const b = beginUpload({ path: join(dir, 'same.txt'), size: 1, collision: 'overwrite' });
    assert.notEqual(a.id, b.id);

    appendChunk({ id: a.id, seq: 0, data: b64('a') });
    appendChunk({ id: b.id, seq: 0, data: b64('b') });
    await commitUpload({ id: a.id });
    await commitUpload({ id: b.id });

    // Last commit wins, and nothing is left over.
    assert.equal(readFileSync(join(dir, 'same.txt'), 'utf-8'), 'b');
    assert.deepEqual(leftovers(dir), ['same.txt']);
  });
});

test('a completed upload is forgotten', async () => {
  await withDir(async (dir) => {
    const before = _activeUploadCount();
    const { id } = beginUpload({ path: join(dir, 'once.txt'), size: 2 });
    assert.equal(_activeUploadCount(), before + 1);

    appendChunk({ id, seq: 0, data: b64('hi') });
    await commitUpload({ id });

    assert.equal(_activeUploadCount(), before, 'finished uploads must not accumulate');
    await assert.rejects(() => commitUpload({ id }), /Unknown upload id/);
  });
});

test('the chunk size leaves headroom under the relay payload cap', () => {
  // The constraint the whole design exists for. Base64 is 4 bytes per 3, so a
  // chunk plus JSON framing has to stay under the 1MB maxPayload in
  // cloud/src/ws/relay.js.
  const encoded = Math.ceil(CHUNK_SIZE / 3) * 4;
  assert.ok(encoded < 1024 * 1024, `a base64 chunk is ${encoded} bytes, which must stay under 1MB`);
  // And enough headroom that ids, paths and the envelope cannot push it over.
  assert.ok(1024 * 1024 - encoded > 100 * 1024, 'too little headroom for the request envelope');
});
