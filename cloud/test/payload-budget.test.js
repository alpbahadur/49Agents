import test from 'node:test';
import assert from 'node:assert/strict';
import {
  jsonByteLength, fitsInRelay, formatBytes, checkImageBudget, describeImageRejection,
  RELAY_MAX_BYTES, RELAY_BUDGET_BYTES,
} from '../src-client/modules/payload-budget.js';

/**
 * Exceeding the relay's 1MB maxPayload is not a failed request: the receiving
 * socket closes, so the connection goes down and every pane with it. Confirmed
 * against the running server — an oversized send arrives back at the browser as
 * a 1006 close.
 *
 * Nothing checked this, so pasting a phone photo into a note dropped the relay.
 * The subtle part is that the budget belongs to the whole images array, because
 * saving a note sends all of them in one request: three 400KB images breach a
 * cap that none of them approaches individually.
 */

const dataUrl = (bytes) => `data:image/png;base64,${'A'.repeat(bytes)}`;

test('the budget leaves room under the relay cap for the envelope', () => {
  assert.ok(RELAY_BUDGET_BYTES < RELAY_MAX_BYTES, 'the budget must sit under the cap');
  const headroom = RELAY_MAX_BYTES - RELAY_BUDGET_BYTES;
  assert.ok(headroom >= 64 * 1024, `only ${headroom} bytes for the request envelope`);
});

test('byte length is measured in bytes, not characters', () => {
  // A cap on bytes cannot be checked with String.length: these two strings are
  // the same length and very different sizes on the wire.
  const ascii = jsonByteLength({ s: 'aaaa' });
  const wide = jsonByteLength({ s: '喂喂喂喂' });
  assert.ok(wide > ascii, 'multi-byte characters must count for more');
  // Three bytes each in UTF-8.
  assert.equal(wide - ascii, 8);
});

test('byte length accounts for JSON structure, not just content', () => {
  assert.equal(jsonByteLength('ab'), 4); // quotes included
  assert.equal(jsonByteLength([]), 2);
  assert.equal(jsonByteLength(null), 4);
  assert.equal(jsonByteLength(undefined), 0);
});

test('an unserialisable payload is treated as oversized', () => {
  // It cannot be sent regardless, and calling it oversized fails safely rather
  // than letting it through to close the socket.
  const circular = {};
  circular.self = circular;
  assert.equal(jsonByteLength(circular), Infinity);
  assert.equal(fitsInRelay(circular), false);
});

test('fitsInRelay draws the line at the budget', () => {
  assert.equal(fitsInRelay({ small: 'x' }), true);
  assert.equal(fitsInRelay({ big: 'x'.repeat(RELAY_BUDGET_BYTES) }), false);
  // Exactly at the budget is allowed; one byte over is not.
  const atLimit = 'x'.repeat(RELAY_BUDGET_BYTES - 2); // minus the quotes
  assert.equal(fitsInRelay(atLimit), true);
  assert.equal(fitsInRelay(`${atLimit}xx`), false);
});

test('a small image is accepted', () => {
  const check = checkImageBudget([], [dataUrl(1024)]);
  assert.equal(check.ok, true);
});

test('a single oversized image is refused as too large', () => {
  const check = checkImageBudget([], [dataUrl(RELAY_BUDGET_BYTES)]);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'image-too-large');
  // The message has to say what to do instead, not quote a relay limit.
  assert.match(describeImageRejection(check), /over the .* limit for a note/);
  assert.match(describeImageRejection(check), /file pane/);
});

test('images that individually fit but collectively do not are refused', () => {
  // The case a per-image check would wave through. Each is well under the
  // budget; together they exceed it, and they travel in one request.
  const third = Math.floor(RELAY_BUDGET_BYTES / 2.5);
  const existing = [dataUrl(third), dataUrl(third)];
  assert.equal(checkImageBudget([], existing).ok, true, 'two of these must fit');

  const check = checkImageBudget(existing, [dataUrl(third)]);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'note-full', 'the new image is not itself the problem');
  assert.match(describeImageRejection(check), /Remove an image first/);
});

test('the existing images count toward the budget', () => {
  const big = dataUrl(RELAY_BUDGET_BYTES - 2048);
  // The same small addition succeeds on an empty note and fails on a full one.
  assert.equal(checkImageBudget([], [dataUrl(512)]).ok, true);
  assert.equal(checkImageBudget([big], [dataUrl(512 * 1024)]).ok, false);
});

test('several images added at once are judged together', () => {
  // A multi-file paste must not slip through by being checked one at a time.
  const half = Math.floor(RELAY_BUDGET_BYTES / 1.5);
  const check = checkImageBudget([], [dataUrl(half), dataUrl(half)]);
  assert.equal(check.ok, false);
  // Two images arriving together is not one image being too large.
  assert.equal(check.reason, 'note-full');
});

test('checkImageBudget copes with missing arguments', () => {
  assert.equal(checkImageBudget().ok, true);
  assert.equal(checkImageBudget([]).ok, true);
  assert.equal(checkImageBudget(undefined, []).ok, true);
});

test('checkImageBudget reports the numbers behind its verdict', () => {
  const check = checkImageBudget([dataUrl(64)], [dataUrl(RELAY_BUDGET_BYTES)]);
  assert.equal(check.ok, false);
  assert.ok(check.totalBytes > check.budget);
  assert.ok(check.existingBytes > 0);
  assert.ok(check.incomingBytes > check.budget);
  assert.equal(check.budget, RELAY_BUDGET_BYTES);
});

test('formatBytes reads as a size a person would recognise', () => {
  assert.equal(formatBytes(512), '512 bytes');
  assert.equal(formatBytes(2048), '2KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0MB');
  assert.equal(formatBytes(Infinity), 'an unknown size');
});
