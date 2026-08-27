import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { createJsonStore } from '../services/jsonStore.js';

/**
 * The seven pane services (notes, iframes, folder/file panes, git graphs,
 * beads, conversations) all persist through this store, and the agent shares
 * its data directory with anything else reading those files. So the on-disk
 * shape and the failure behaviour are both part of the contract, not just the
 * happy path.
 */

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), '49agents-store-'));
  const file = join(dir, 'nested', 'things.json');
  try {
    fn(createJsonStore({
      file,
      key: 'things',
      loadError: '[Test] load failed:',
      saveError: '[Test] save failed:',
    }), file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an absent file loads as an empty list', () => {
  withStore((store, file) => {
    assert.deepEqual(store.load(), []);
    assert.equal(existsSync(file), false);
  });
});

test('saving creates the data directory and round-trips', () => {
  withStore((store) => {
    store.save([{ id: 'a' }, { id: 'b' }]);
    assert.deepEqual(store.load(), [{ id: 'a' }, { id: 'b' }]);
  });
});

test('the file keeps the { key, version } shape the services shipped with', () => {
  withStore((store, file) => {
    store.save([{ id: 'a' }]);
    const raw = readFileSync(file, 'utf-8');
    assert.deepEqual(JSON.parse(raw), { things: [{ id: 'a' }], version: 1 });
    // Key order and indentation are observable to anything else reading the
    // file, so pin the exact bytes rather than just the parsed value.
    assert.equal(raw, JSON.stringify({ things: [{ id: 'a' }], version: 1 }, null, 2));
  });
});

test('a corrupt file loads as an empty list instead of throwing', () => {
  withStore((store, file) => {
    store.save([]);
    writeFileSync(file, '{ not json');
    assert.deepEqual(store.load(), []);
  });
});

test('a file missing the key loads as an empty list', () => {
  withStore((store, file) => {
    store.save([]);
    writeFileSync(file, JSON.stringify({ version: 1 }));
    assert.deepEqual(store.load(), []);
  });
});
