import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, realpathSync, openSync, ftruncateSync, closeSync, statSync } from 'fs';
import { join } from 'path';
import {
  readTextFileForTransport, jsonByteLength, FileTooLargeError,
  CONTENT_BUDGET_BYTES, STAT_LIMIT_BYTES,
} from '../services/fileRead.js';

/**
 * A response travels the same relay as a request and hits the same 1MB
 * maxPayload. Reading a whole file into one message therefore did not merely
 * fail for a large file — it overran the cap on the agent's own socket, and the
 * cloud closes a socket that overruns it. Opening a log file took the agent
 * offline.
 *
 * The limit is on the JSON encoding rather than the file's size on disk,
 * because that is what actually travels. Escaping and multi-byte characters
 * both inflate it, so a file can sit under the limit on disk and over it on the
 * wire — the case a naive size check waves through and the socket then pays
 * for.
 */

function withDir(fn) {
  const dir = realpathSync(mkdtempSync(join('/tmp', 'file-read-')));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an ordinary file is returned unchanged', () => {
  withDir((dir) => {
    const p = join(dir, 'small.txt');
    writeFileSync(p, 'hello\nworld\n');
    assert.equal(readTextFileForTransport(p), 'hello\nworld\n');
  });
});

test('an empty file reads as an empty string', () => {
  withDir((dir) => {
    const p = join(dir, 'empty.txt');
    writeFileSync(p, '');
    assert.equal(readTextFileForTransport(p), '');
  });
});

test('a file just under the budget is allowed', () => {
  withDir((dir) => {
    const p = join(dir, 'nearly.txt');
    // Plain ASCII with nothing to escape, so encoded length is content + quotes.
    writeFileSync(p, 'a'.repeat(CONTENT_BUDGET_BYTES - 16));
    const content = readTextFileForTransport(p);
    assert.ok(jsonByteLength(content) <= CONTENT_BUDGET_BYTES);
  });
});

test('a file over the budget is refused rather than returned', () => {
  withDir((dir) => {
    const p = join(dir, 'big.txt');
    writeFileSync(p, 'a'.repeat(CONTENT_BUDGET_BYTES + 1024));
    assert.throws(() => readTextFileForTransport(p), FileTooLargeError);
  });
});

test('the refusal says what to do instead', () => {
  withDir((dir) => {
    const p = join(dir, 'big.txt');
    writeFileSync(p, 'a'.repeat(CONTENT_BUDGET_BYTES + 1024));
    try {
      readTextFileForTransport(p);
      assert.fail('should have thrown');
    } catch (e) {
      assert.equal(e.code, 'EFBIG', 'the router needs this to answer 413');
      assert.match(e.message, /too large to open/);
      assert.match(e.message, /terminal/, 'a size limit with no alternative is not much help');
    }
  });
});

test('a file under the limit on disk but over it once encoded is refused', () => {
  withDir((dir) => {
    // Every character escapes to two bytes in JSON, so this roughly doubles on
    // the wire. Checking the file's size alone would let it through, and the
    // socket would close on the way out.
    const raw = '"'.repeat(Math.floor(CONTENT_BUDGET_BYTES * 0.75));
    const p = join(dir, 'quotes.txt');
    writeFileSync(p, raw);

    assert.ok(raw.length < CONTENT_BUDGET_BYTES, 'must be under the limit on disk');
    assert.ok(jsonByteLength(raw) > CONTENT_BUDGET_BYTES, 'and over it once encoded');
    assert.throws(() => readTextFileForTransport(p), FileTooLargeError);
  });
});

test('multi-byte text is measured in bytes, not characters', () => {
  withDir((dir) => {
    // Three bytes per character in UTF-8, so a third as many characters fit.
    const chars = Math.floor(CONTENT_BUDGET_BYTES / 2);
    const raw = '喂'.repeat(chars);
    const p = join(dir, 'cjk.txt');
    writeFileSync(p, raw);

    assert.ok(raw.length < CONTENT_BUDGET_BYTES, 'fewer characters than the byte limit');
    assert.throws(() => readTextFileForTransport(p), FileTooLargeError);
  });
});

test('an enormous file is declined without being read into memory', () => {
  withDir((dir) => {
    const p = join(dir, 'huge.bin');
    // Sparse, so the test does not actually write the bytes it claims.
    const fd = openSync(p, 'w');
    ftruncateSync(fd, STAT_LIMIT_BYTES + 1024);
    closeSync(fd);
    assert.ok(statSync(p).size > STAT_LIMIT_BYTES);

    // Declined on the stat alone, so the file is never allocated in memory.
    assert.throws(() => readTextFileForTransport(p), FileTooLargeError);
  });
});

test('the content budget leaves room under the relay cap for the envelope', () => {
  // The response carries fileName, filePath and device alongside the content.
  const RELAY_MAX = 1024 * 1024;
  assert.ok(CONTENT_BUDGET_BYTES < RELAY_MAX);
  assert.ok(RELAY_MAX - CONTENT_BUDGET_BYTES >= 64 * 1024,
    'too little headroom for the rest of the response');
});

test('reading and writing share the same ceiling', () => {
  // Saving a file pane sends its whole content in one request, bounded by the
  // client's relay budget. If reads were allowed to exceed that, a file could
  // be opened and never saved — which is why this is a symmetric limit rather
  // than a streamed read.
  const CLIENT_BUDGET = 900 * 1024; // src-client/modules/payload-budget.js
  assert.ok(CONTENT_BUDGET_BYTES <= CLIENT_BUDGET,
    'a readable file must also be writable');
});

test('jsonByteLength handles absent values', () => {
  assert.equal(jsonByteLength(''), 2);
  assert.equal(jsonByteLength(null), 4);
  assert.equal(jsonByteLength(undefined), 4);
});
