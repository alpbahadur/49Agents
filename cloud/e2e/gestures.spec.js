import { test, expect, openApp, seedPanes, setView } from './helpers/app.js';
import { touchSession, readView, pinch, drag } from './helpers/touch.js';

// The gesture arithmetic is unit-tested in test/gestures.test.js. What only a
// real engine can show is whether those functions are reached at all: whether a
// pinch over a pane survives the stopPropagation that pane content installs,
// whether a gesture that changes finger count keeps moving, and whether an
// interrupted gesture leaves the canvas stuck.

let touch;

test.beforeEach(async ({ page }) => {
  await openApp(page);
  touch = await touchSession(page);
});

test.afterEach(async () => {
  await touch?.detach();
});

test('a pinch starting over a pane zooms the canvas', async ({ page }) => {
  // A pane large enough that both fingers land inside it. Pane content stops
  // touchstart from bubbling, so before the capture-phase listener this pinch
  // reached nothing at all — and panes cover most of a phone screen.
  await seedPanes(page, [{ id: 'e2e-big', x: 0, y: 0, width: 360, height: 500 }]);
  await setView(page, { panX: 0, panY: 0, zoom: 1 });

  const box = await page.locator('.pane').first().boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await pinch(touch,
    { a: { x: cx - 40, y: cy }, b: { x: cx + 40, y: cy } },
    { a: { x: cx - 100, y: cy }, b: { x: cx + 100, y: cy } });

  await expect.poll(async () => (await readView(page)).zoom).toBeGreaterThan(1.5);
});

test('a two-finger drag pans the canvas without changing zoom', async ({ page }) => {
  await seedPanes(page, [{ id: 'e2e-pan', x: 0, y: 0, width: 300, height: 300 }]);
  await setView(page, { panX: 0, panY: 0, zoom: 1 });

  const before = await readView(page);

  // Spread held constant, both fingers travelling together.
  await pinch(touch,
    { a: { x: 120, y: 400 }, b: { x: 220, y: 400 } },
    { a: { x: 170, y: 460 }, b: { x: 270, y: 460 } });

  const after = await readView(page);
  expect(after.zoom).toBeCloseTo(before.zoom, 2);
  expect(after.panX).toBeGreaterThan(before.panX + 20);
  expect(after.panY).toBeGreaterThan(before.panY + 20);
});

test('lifting one finger from a pinch continues as a pan instead of freezing', async ({ page }) => {
  await seedPanes(page, [{ id: 'e2e-degrade', x: 0, y: 0, width: 300, height: 300 }]);
  await setView(page, { panX: 0, panY: 0, zoom: 1 });

  // Pinch out, then lift finger 1 and keep dragging with finger 0. Previously
  // touchend tore down every listener here, so the canvas stopped responding
  // until both fingers had left the glass.
  await touch.start([{ x: 140, y: 400, id: 0 }, { x: 240, y: 400, id: 1 }]);
  for (let i = 1; i <= 6; i++) {
    await touch.move([{ x: 140 - i * 5, y: 400, id: 0 }, { x: 240 + i * 5, y: 400, id: 1 }]);
  }
  await touch.end([{ x: 270, y: 400, id: 1 }]);

  const afterPinch = await readView(page);
  expect(afterPinch.zoom).toBeGreaterThan(1.1);

  // The remaining finger now drags. This must move the canvas.
  for (let i = 1; i <= 6; i++) {
    await touch.move([{ x: 110 + i * 12, y: 400 + i * 8, id: 0 }]);
  }
  const mid = await readView(page);
  await touch.end([{ x: 182, y: 448, id: 0 }]);

  expect(mid.panX).toBeGreaterThan(afterPinch.panX + 20);
  expect(mid.panY).toBeGreaterThan(afterPinch.panY + 10);
  // The pan must not have re-anchored to the stale pinch origin, which would
  // have made the view jump rather than follow the finger.
  expect(mid.zoom).toBeCloseTo(afterPinch.zoom, 2);
});

test('adding a second finger mid-pan switches to a pinch without a jump', async ({ page }) => {
  await seedPanes(page, [{ id: 'e2e-upgrade', x: 0, y: 0, width: 300, height: 300 }]);
  await setView(page, { panX: 0, panY: 0, zoom: 1 });

  // Start a one-finger pan on bare canvas, below and right of the pane.
  await touch.start([{ x: 200, y: 600, id: 0 }]);
  for (let i = 1; i <= 4; i++) await touch.move([{ x: 200 + i * 8, y: 600, id: 0 }]);
  const duringPan = await readView(page);

  // Second finger arrives. CDP takes only the changed point on touchStart, the
  // same way the DOM reports changedTouches.
  await touch.start([{ x: 300, y: 600, id: 1 }]);
  const atUpgrade = await readView(page);
  expect(atUpgrade.panX).toBeCloseTo(duringPan.panX, 1);
  expect(atUpgrade.panY).toBeCloseTo(duringPan.panY, 1);

  await touch.move([{ x: 212, y: 600, id: 0 }, { x: 320, y: 600, id: 1 }]);
  await touch.end([{ x: 212, y: 600, id: 0 }, { x: 320, y: 600, id: 1 }]);

  await expect.poll(async () => (await readView(page)).zoom).toBeGreaterThan(1.1);
});

test('a cancelled gesture releases the canvas rather than sticking', async ({ page }) => {
  await seedPanes(page, [{ id: 'e2e-cancel', x: 0, y: 0, width: 300, height: 300 }]);
  await setView(page, { panX: 0, panY: 0, zoom: 1 });

  // A call or system swipe cancels mid-drag. This used to leave isPanning true
  // and a touchmove listener attached for the rest of the session.
  await touch.start([{ x: 200, y: 600, id: 0 }]);
  await touch.move([{ x: 240, y: 620, id: 0 }]);
  await touch.cancel();

  const afterCancel = await readView(page);

  // A cancel is the system taking the gesture away, not the user flicking, so
  // the canvas must come to rest rather than fling on.
  await page.waitForTimeout(400);
  const settled = await readView(page);
  expect(settled.panX).toBeCloseTo(afterCancel.panX, 1);
  expect(settled.panY).toBeCloseTo(afterCancel.panY, 1);

  // And a fresh gesture still works, which it could not if the cancelled
  // session had left its listeners and isPanning flag behind.
  await drag(touch, { x: 200, y: 600 }, { x: 280, y: 660 });
  await expect.poll(async () => (await readView(page)).panX).toBeGreaterThan(settled.panX + 20);
});

test('a fling cannot strand the viewport away from every pane', async ({ page }) => {
  await seedPanes(page, [{ id: 'e2e-clamp', x: 0, y: 0, width: 300, height: 300 }]);
  await setView(page, { panX: 0, panY: 0, zoom: 1 });

  // Drag hard toward one corner, repeatedly, then let momentum run out.
  for (let i = 0; i < 4; i++) {
    await drag(touch, { x: 80, y: 200 }, { x: 340, y: 700 }, 4);
  }
  await page.waitForTimeout(1200);

  const view = await readView(page);
  const size = page.viewportSize();

  // Some part of the content box must still be on screen.
  const left = 0 * view.zoom + view.panX;
  const top = 0 * view.zoom + view.panY;
  expect(left).toBeLessThan(size.width);
  expect(top).toBeLessThan(size.height);
});

test('fit-all-panes brings a lost viewport back to the content', async ({ page }) => {
  await seedPanes(page, [
    { id: 'e2e-fit-a', x: 0, y: 0, width: 400, height: 250 },
    { id: 'e2e-fit-b', x: 900, y: 700, width: 400, height: 250 },
  ]);

  // Somewhere far away at a zoom where nothing is legible: the state the
  // control exists to recover from.
  await setView(page, { panX: -40000, panY: -40000, zoom: 0.06 });

  await page.locator('#zoom-fit').click();

  const view = await readView(page);
  const size = page.viewportSize();

  // Both extremes of the content box are on screen after fitting.
  for (const [wx, wy] of [[0, 0], [1300, 950]]) {
    const x = wx * view.zoom + view.panX;
    const y = wy * view.zoom + view.panY;
    expect(x).toBeGreaterThanOrEqual(-1);
    expect(y).toBeGreaterThanOrEqual(-1);
    expect(x).toBeLessThanOrEqual(size.width + 1);
    expect(y).toBeLessThanOrEqual(size.height + 1);
  }
  expect(view.zoom).toBeGreaterThan(0.06);
});

test('zoom stays within range however hard a pinch is pushed', async ({ page }) => {
  await seedPanes(page, [{ id: 'e2e-range', x: 0, y: 0, width: 300, height: 300 }]);
  await setView(page, { panX: 0, panY: 0, zoom: 1 });

  // Far past the ceiling.
  await pinch(touch, { a: { x: 190, y: 500 }, b: { x: 200, y: 500 } },
                     { a: { x: 10, y: 500 }, b: { x: 380, y: 500 } });
  let view = await readView(page);
  expect(view.zoom).toBeLessThanOrEqual(4.001);

  // Then far past the floor.
  for (let i = 0; i < 3; i++) {
    await pinch(touch, { a: { x: 20, y: 500 }, b: { x: 370, y: 500 } },
                       { a: { x: 194, y: 500 }, b: { x: 196, y: 500 } });
  }
  view = await readView(page);
  expect(view.zoom).toBeGreaterThanOrEqual(0.0499);
});
