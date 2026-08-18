import test from 'node:test';
import assert from 'node:assert/strict';
import { PANE_HEADER_CONTROLS, normalizePaneHeaderOrder } from '../src-client/modules/utils.js';

/**
 * A stored header order outlives the build that wrote it: controls get added
 * and removed between releases, and the value round trips through JSON in a
 * preferences column where nothing validates its shape. Normalizing on the
 * way in is what stops any of that from dropping a button out of the header.
 */

test('an empty or missing order falls back to the built-in one', () => {
  assert.deepEqual(normalizePaneHeaderOrder([]), PANE_HEADER_CONTROLS);
  assert.deepEqual(normalizePaneHeaderOrder(undefined), PANE_HEADER_CONTROLS);
  assert.deepEqual(normalizePaneHeaderOrder(null), PANE_HEADER_CONTROLS);
});

test('a non-array is treated as no preference at all', () => {
  // The column is free-form JSON, so an object or a string can reach this.
  assert.deepEqual(normalizePaneHeaderOrder('zoom,reload'), PANE_HEADER_CONTROLS);
  assert.deepEqual(normalizePaneHeaderOrder({ 0: 'zoom' }), PANE_HEADER_CONTROLS);
});

test('a full custom order is preserved exactly', () => {
  const order = ['zoom', 'newtab', 'shortcut', 'beads', 'reload'];
  assert.deepEqual(normalizePaneHeaderOrder(order), order);
});

test('a control missing from a stored order is appended, not lost', () => {
  // What a preference written by a build that predates a new control looks like.
  const result = normalizePaneHeaderOrder(['zoom', 'reload']);
  assert.deepEqual(result.slice(0, 2), ['zoom', 'reload']);
  assert.equal(result.length, PANE_HEADER_CONTROLS.length);
  for (const key of PANE_HEADER_CONTROLS) {
    assert.ok(result.includes(key), `${key} should survive normalization`);
  }
});

test('a control this build no longer has is dropped', () => {
  const result = normalizePaneHeaderOrder(['zoom', 'retired-control', 'reload']);
  assert.ok(!result.includes('retired-control'));
  assert.equal(result.length, PANE_HEADER_CONTROLS.length);
});

test('duplicates collapse to the first occurrence', () => {
  const result = normalizePaneHeaderOrder(['zoom', 'zoom', 'reload', 'zoom']);
  assert.equal(result.filter(k => k === 'zoom').length, 1);
  assert.deepEqual(result.slice(0, 2), ['zoom', 'reload']);
  assert.equal(result.length, PANE_HEADER_CONTROLS.length);
});

test('every result is a permutation of the control set', () => {
  const inputs = [[], ['newtab'], ['bogus'], ['zoom', 'zoom'], PANE_HEADER_CONTROLS];
  for (const input of inputs) {
    const result = normalizePaneHeaderOrder(input);
    assert.deepEqual([...result].sort(), [...PANE_HEADER_CONTROLS].sort(),
      `normalizing ${JSON.stringify(input)} should yield every control exactly once`);
  }
});
