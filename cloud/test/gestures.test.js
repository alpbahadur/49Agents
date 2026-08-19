import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_ZOOM, MAX_ZOOM, clampZoom, pinchDistance, pinchCenter, applyZoomAt,
  pinchStart, applyPinch, panStart, applyPan, clampPan, fitToBounds,
  computeMomentum,
} from '../src-client/modules/gestures.js';

/**
 * Touch pan and pinch used to be arithmetic inlined in handleTouchStart, where
 * two defects went unnoticed: a pinch could only scale about its midpoint and
 * never translate with it, and a pinch that degraded to one finger left the
 * canvas frozen because the pan baseline was never re-anchored. These tests
 * pin both behaviours, plus the pan clamping and fit-to-content maths that
 * give the user a way back from an empty region of the canvas.
 */

const touch = (x, y) => ({ clientX: x, clientY: y });
const view = (panX, panY, zoom) => ({ panX, panY, zoom });

// Where a world point lands on screen for a given view.
const project = (v, wx, wy) => ({ x: wx * v.zoom + v.panX, y: wy * v.zoom + v.panY });

test('clampZoom holds the zoom inside the supported range', () => {
  assert.equal(clampZoom(1), 1);
  assert.equal(clampZoom(0), MIN_ZOOM);
  assert.equal(clampZoom(-5), MIN_ZOOM);
  assert.equal(clampZoom(1000), MAX_ZOOM);
  assert.equal(clampZoom(NaN), 1);
  assert.equal(clampZoom(Infinity), MAX_ZOOM);
});

test('pinchDistance and pinchCenter describe the finger pair', () => {
  assert.equal(pinchDistance(touch(0, 0), touch(30, 40)), 50);
  assert.deepEqual(pinchCenter(touch(0, 0), touch(30, 40)), { x: 15, y: 20 });
});

test('applyZoomAt keeps the world point under the cursor fixed', () => {
  const before = view(-100, -50, 1);
  const anchor = { x: 300, y: 200 };
  // World point currently under the anchor.
  const wx = (anchor.x - before.panX) / before.zoom;
  const wy = (anchor.y - before.panY) / before.zoom;

  const after = applyZoomAt(before, 2, anchor.x, anchor.y);

  assert.equal(after.zoom, 2);
  const landed = project(after, wx, wy);
  assert.ok(Math.abs(landed.x - anchor.x) < 1e-9);
  assert.ok(Math.abs(landed.y - anchor.y) < 1e-9);
});

test('applyZoomAt clamps without drifting the anchor', () => {
  const after = applyZoomAt(view(0, 0, 1), 99, 100, 100);
  assert.equal(after.zoom, MAX_ZOOM);
  // The anchor sat on world origin offset; check it still maps to itself.
  const wx = 100, wy = 100;
  const landed = project(after, wx / 1, wy / 1);
  assert.ok(Math.abs(landed.x - 100) < 1e-9);
  assert.ok(Math.abs(landed.y - 100) < 1e-9);
});

test('a pinch that only spreads zooms about the midpoint and does not drift', () => {
  const before = view(0, 0, 1);
  const start = pinchStart(before, [touch(100, 100), touch(200, 100)]);
  // Same midpoint (150, 100), fingers twice as far apart.
  const after = applyPinch(start, [touch(50, 100), touch(250, 100)]);

  assert.equal(after.zoom, 2);
  const landed = project(after, 150, 100);
  assert.ok(Math.abs(landed.x - 150) < 1e-9);
  assert.ok(Math.abs(landed.y - 100) < 1e-9);
});

test('a two-finger drag at constant spread pans without changing zoom', () => {
  const before = view(0, 0, 1);
  const start = pinchStart(before, [touch(100, 100), touch(200, 100)]);
  // Spread unchanged, midpoint moved right 50 and down 30.
  const after = applyPinch(start, [touch(150, 130), touch(250, 130)]);

  assert.equal(after.zoom, 1);
  assert.equal(after.panX, 50);
  assert.equal(after.panY, 30);
});

test('a pinch that spreads and travels does both at once', () => {
  const before = view(0, 0, 1);
  const start = pinchStart(before, [touch(100, 100), touch(200, 100)]);
  // Spread doubled and midpoint moved from (150, 100) to (400, 300).
  const after = applyPinch(start, [touch(300, 300), touch(500, 300)]);

  assert.equal(after.zoom, 2);
  // The world point that was under the old midpoint follows to the new one.
  const landed = project(after, 150, 100);
  assert.ok(Math.abs(landed.x - 400) < 1e-9);
  assert.ok(Math.abs(landed.y - 300) < 1e-9);
});

test('applyPinch respects the zoom ceiling while still tracking the midpoint', () => {
  const before = view(0, 0, 1);
  const start = pinchStart(before, [touch(100, 100), touch(200, 100)]);
  // Spread x10 would exceed MAX_ZOOM; midpoint also moves.
  const after = applyPinch(start, [touch(0, 200), touch(1000, 200)]);

  assert.equal(after.zoom, MAX_ZOOM);
  const landed = project(after, 150, 100);
  assert.ok(Math.abs(landed.x - 500) < 1e-9);
  assert.ok(Math.abs(landed.y - 200) < 1e-9);
});

test('pinchStart captures the view it began from, not the live view', () => {
  const start = pinchStart(view(-30, -40, 0.5), [touch(0, 0), touch(10, 0)]);
  assert.equal(start.zoom, 0.5);
  assert.equal(start.panX, -30);
  assert.equal(start.panY, -40);
  assert.equal(start.distance, 10);
});

test('panStart re-anchors so a degraded pinch continues from where it is', () => {
  // A pinch has left the canvas at this view; one finger lifts at (400, 300).
  const mid = view(120, 80, 2);
  const start = panStart(mid, touch(400, 300));

  // The remaining finger has not moved yet, so the view must not jump.
  assert.deepEqual(applyPan(start, touch(400, 300)), { panX: 120, panY: 80 });

  // Then it drags 25 left and 10 down.
  assert.deepEqual(applyPan(start, touch(375, 310)), { panX: 95, panY: 90 });
});

test('applyPan translates one-for-one with the finger regardless of zoom', () => {
  const start = panStart(view(0, 0, 0.25), touch(200, 200));
  assert.deepEqual(applyPan(start, touch(260, 150)), { panX: 60, panY: -50 });
});

const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 800 };
const viewport = { x: 0, y: 0, width: 400, height: 700 };

test('clampPan leaves an in-range view untouched', () => {
  const v = view(-100, -50, 1);
  assert.deepEqual(clampPan(v, bounds, viewport, 80), { panX: -100, panY: -50 });
});

test('clampPan keeps content on screen when flung far off to one side', () => {
  const v = view(100000, 100000, 1);
  const clamped = clampPan(v, bounds, viewport, 80);

  // Content's left edge must not be pushed past the viewport's right margin.
  const contentLeft = bounds.minX * v.zoom + clamped.panX;
  assert.ok(contentLeft <= viewport.width - 80 + 1e-9);
});

test('clampPan keeps content on screen when flung far off the other side', () => {
  const v = view(-100000, -100000, 1);
  const clamped = clampPan(v, bounds, viewport, 80);

  // Content's right edge must stay at least the margin inside the viewport.
  const contentRight = bounds.maxX * v.zoom + clamped.panX;
  assert.ok(contentRight >= 80 - 1e-9);
});

test('clampPan respects a viewport inset by safe areas', () => {
  const inset = { x: 0, y: 60, width: 400, height: 600 };
  const clamped = clampPan(view(0, -100000, 1), bounds, inset, 80);
  const contentBottom = bounds.maxY + clamped.panY;
  assert.ok(contentBottom >= inset.y + 80 - 1e-9);
});

test('clampPan is a no-op without bounds', () => {
  assert.deepEqual(clampPan(view(9, 9, 1), null, viewport), { panX: 9, panY: 9 });
});

test('fitToBounds frames the whole content box and centres it', () => {
  const fit = fitToBounds(bounds, viewport, 24);

  // Tightest axis wins: (400-48)/1000 = 0.352 vs (700-48)/800 = 0.815.
  assert.ok(Math.abs(fit.zoom - 0.352) < 1e-9);

  // Content centre lands on the viewport centre.
  const landed = project(fit, 500, 400);
  assert.ok(Math.abs(landed.x - 200) < 1e-9);
  assert.ok(Math.abs(landed.y - 350) < 1e-9);

  // Both extremes are inside the viewport.
  const tl = project(fit, bounds.minX, bounds.minY);
  const br = project(fit, bounds.maxX, bounds.maxY);
  assert.ok(tl.x >= -1e-9 && tl.y >= -1e-9);
  assert.ok(br.x <= viewport.width + 1e-9 && br.y <= viewport.height + 1e-9);
});

test('fitToBounds honours a viewport offset by safe areas', () => {
  const inset = { x: 20, y: 60, width: 360, height: 600 };
  const fit = fitToBounds(bounds, inset, 24);
  const landed = project(fit, 500, 400);
  assert.ok(Math.abs(landed.x - (20 + 180)) < 1e-9);
  assert.ok(Math.abs(landed.y - (60 + 300)) < 1e-9);
});

test('fitToBounds does not zoom past the ceiling for a single small pane', () => {
  const tiny = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const fit = fitToBounds(tiny, viewport, 24);
  assert.equal(fit.zoom, MAX_ZOOM);
  // Still centred despite the clamp.
  const landed = project(fit, 5, 5);
  assert.ok(Math.abs(landed.x - 200) < 1e-9);
  assert.ok(Math.abs(landed.y - 350) < 1e-9);
});

test('fitToBounds tolerates a zero-area content box', () => {
  const degenerate = { minX: 100, minY: 100, maxX: 100, maxY: 100 };
  const fit = fitToBounds(degenerate, viewport, 24);
  assert.ok(Number.isFinite(fit.zoom) && fit.zoom > 0);
  assert.ok(Number.isFinite(fit.panX) && Number.isFinite(fit.panY));
});

test('fitToBounds returns null without bounds', () => {
  assert.equal(fitToBounds(null, viewport), null);
});

test('computeMomentum derives per-frame velocity from recent samples', () => {
  const samples = [{ x: 0, y: 0, t: 1000 }, { x: 32, y: -16, t: 1032 }];
  const m = computeMomentum(samples);
  assert.ok(Math.abs(m.vx - 16) < 1e-9);
  assert.ok(Math.abs(m.vy - -8) < 1e-9);
});

test('computeMomentum ignores a finger that rested before lifting', () => {
  const stale = [{ x: 0, y: 0, t: 1000 }, { x: 50, y: 0, t: 1500 }];
  assert.equal(computeMomentum(stale), null);
});

test('computeMomentum needs at least two samples and a forward interval', () => {
  assert.equal(computeMomentum(null), null);
  assert.equal(computeMomentum([]), null);
  assert.equal(computeMomentum([{ x: 0, y: 0, t: 1 }]), null);
  assert.equal(computeMomentum([{ x: 0, y: 0, t: 5 }, { x: 9, y: 9, t: 5 }]), null);
});

test('a finger that rested before lifting yields no momentum', () => {
  // A resting finger fires no touchmove, so the samples keep describing the
  // movement before the pause. Judged on the window alone this looks like a
  // brisk flick, and the canvas would fly off just as the user stopped it.
  const samples = [{ x: 0, y: 0, t: 1000 }, { x: 40, y: 0, t: 1030 }];
  assert.ok(computeMomentum(samples, 200, 1035), 'a prompt release still flings');
  assert.equal(computeMomentum(samples, 200, 1400), null);
});

test('the release time is optional and does not change the window rule', () => {
  const samples = [{ x: 0, y: 0, t: 1000 }, { x: 40, y: 0, t: 1030 }];
  assert.ok(computeMomentum(samples, 200, null));
  assert.ok(computeMomentum(samples));
  // A window that is already too long stays refused whatever the release says.
  const slow = [{ x: 0, y: 0, t: 1000 }, { x: 40, y: 0, t: 1500 }];
  assert.equal(computeMomentum(slow, 200, 1505), null);
});
