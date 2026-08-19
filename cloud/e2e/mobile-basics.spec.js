import { test, expect, openApp, seedPanes, setView } from './helpers/app.js';
import { touchSession, readView, drag } from './helpers/touch.js';

// The mobile affordances that predate this branch: momentum, the pane drawer,
// single-column arrange, tap-to-expand, and the Safari zoom guards. All were
// written but none were covered, and the touch pan they all sit on top of was
// throwing before the container fix — so "implemented" was not the same thing
// as "working". These pin the behaviour each was meant to deliver.

let touch;

test.beforeEach(async ({ page }) => {
  await openApp(page);
  touch = await touchSession(page);
});

test.afterEach(async () => {
  await touch?.detach();
});

// A content box far wider than the viewport, so clampPan leaves room to coast.
// With a single small pane the clamp bound sits inside one flick's distance and
// absorbs the fling immediately, which looks exactly like no momentum at all.
const ROOMY = [
  { id: 'mo-tl', type: 'note', x: 0, y: 0, width: 300, height: 300 },
  { id: 'mo-br', type: 'note', x: 3700, y: 2700, width: 300, height: 300 },
];

test('a flick keeps the canvas moving after the finger leaves', async ({ page }) => {
  await seedPanes(page, ROOMY);
  await setView(page, { panX: -1500, panY: -1200, zoom: 1 });

  // Fast, short flick: the samples window is 200ms, so the gesture has to be
  // brisk to register as a fling rather than a drag that ended.
  await touch.start([{ x: 300, y: 600, id: 0 }]);
  for (let i = 1; i <= 5; i++) await touch.move([{ x: 300 - i * 24, y: 600, id: 0 }]);
  await touch.end([{ x: 180, y: 600, id: 0 }]);

  const atRelease = await readView(page);

  // It must still be travelling in the same direction a few frames later.
  await expect
    .poll(async () => (await readView(page)).panX, { timeout: 2000 })
    .toBeLessThan(atRelease.panX - 5);

  // And it must come to rest rather than coasting forever.
  await page.waitForTimeout(1500);
  const settled = await readView(page);
  await page.waitForTimeout(300);
  expect((await readView(page)).panX).toBeCloseTo(settled.panX, 1);
});

test('a finger that rests before lifting does not launch the canvas', async ({ page }) => {
  await seedPanes(page, ROOMY);
  await setView(page, { panX: -1500, panY: -1200, zoom: 1 });

  // Drag briskly, rest, then lift. A resting finger fires no touchmove, so the
  // samples still describe the movement before the pause — momentum has to be
  // judged against the release, not the sample window alone.
  await touch.start([{ x: 300, y: 600, id: 0 }]);
  for (let i = 1; i <= 5; i++) await touch.move([{ x: 300 - i * 20, y: 600, id: 0 }]);
  await page.waitForTimeout(400);
  await touch.end([{ x: 200, y: 600, id: 0 }]);

  const atRelease = await readView(page);
  await page.waitForTimeout(400);
  expect((await readView(page)).panX).toBeCloseTo(atRelease.panX, 1);
});

test('the drawer lists panes with their icon, name, device and number', async ({ page }) => {
  await seedPanes(page, [
    { id: 'mo-term', type: 'terminal', x: 0, y: 0, width: 400, height: 250, device: 'laptop', shortcutNumber: 1 },
    { id: 'mo-note', type: 'note', x: 500, y: 0, width: 400, height: 250, shortcutNumber: 2 },
  ]);

  await page.locator('#mobile-nav-btn').click();
  await expect(page.locator('.mobile-nav-sheet')).toBeVisible();

  const items = page.locator('.mobile-nav-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0).locator('.mobile-nav-icon')).toHaveText('>_');
  await expect(items.nth(0).locator('.mobile-nav-label')).toHaveText('Terminal');
  await expect(items.nth(0).locator('.mobile-nav-device')).toHaveText('laptop');
  await expect(items.nth(0).locator('.mobile-nav-shortcut')).toHaveText('1');
  await expect(items.nth(1).locator('.mobile-nav-label')).toHaveText('Note');
});

test('tapping a drawer entry jumps to that pane and expands it', async ({ page }) => {
  await seedPanes(page, [
    { id: 'mo-near', type: 'note', x: 0, y: 0, width: 400, height: 250 },
    { id: 'mo-far', type: 'note', x: 4000, y: 3000, width: 400, height: 250 },
  ]);
  await setView(page, { panX: 0, panY: 0, zoom: 1 });

  await page.locator('#mobile-nav-btn').click();
  await page.locator('.mobile-nav-item').nth(1).click();

  // The sheet closes, the pane is expanded, and the canvas has travelled to it.
  await expect(page.locator('.mobile-nav-sheet')).toHaveCount(0);
  await expect(page.locator('body')).toHaveClass(/pane-expanded/);
  await expect(page.locator('#pane-mo-far')).toHaveClass(/expanded/);
});

test('arrange stacks every pane into one column at the viewport width', async ({ page }) => {
  await seedPanes(page, [
    { id: 'ar-a', type: 'note', x: 0, y: 0, width: 400, height: 250, shortcutNumber: 1 },
    { id: 'ar-b', type: 'note', x: 2000, y: 1500, width: 700, height: 600, shortcutNumber: 2 },
    { id: 'ar-c', type: 'note', x: -900, y: 400, width: 300, height: 200, shortcutNumber: 3 },
  ]);

  await page.locator('#mobile-nav-btn').click();
  await page.locator('.mobile-nav-arrange-btn').click();

  const panes = await page.evaluate(() =>
    window.TC2_DEBUG.state.panes
      .slice()
      .sort((a, b) => a.shortcutNumber - b.shortcutNumber)
      .map(p => ({ id: p.id, x: p.x, y: p.y, width: p.width, height: p.height })));

  // One column: a shared left edge and a shared width.
  const xs = new Set(panes.map(p => p.x));
  const widths = new Set(panes.map(p => p.width));
  expect(xs.size).toBe(1);
  expect(widths.size).toBe(1);

  // Stacked in shortcut order, each below the last, none overlapping.
  for (let i = 1; i < panes.length; i++) {
    expect(panes[i].y).toBeGreaterThanOrEqual(panes[i - 1].y + panes[i - 1].height);
  }

  // Sized to the viewport rather than left at their desktop widths, and the
  // view is reset to the top of the column.
  const size = page.viewportSize();
  expect(panes[0].width).toBeLessThan(size.width);
  expect(panes[0].width).toBeGreaterThan(size.width - 80);
  const view = await readView(page);
  expect(view.zoom).toBe(1);
  expect(view.panX).toBe(0);
  expect(view.panY).toBe(0);
});

test('a tap expands any pane type, not just terminals', async ({ page }) => {
  // Mid-screen: the HUD covers the top-left, the add-pane button the top-right,
  // and the settings and zoom stacks the bottom corners. A pane at the canvas
  // origin is behind the HUD and cannot be tapped at all.
  await seedPanes(page, [
    { id: 'tap-note', type: 'note', x: 60, y: 280, width: 270, height: 160 },
  ]);
  await setView(page, { panX: 0, panY: 0, zoom: 1 });

  const box = await page.locator('#pane-tap-note').boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);

  await expect(page.locator('body')).toHaveClass(/pane-expanded/);
  await expect(page.locator('#pane-tap-note')).toHaveClass(/expanded/);
});

test('a drag across a pane does not count as a tap', async ({ page }) => {
  await seedPanes(page, [
    { id: 'tap-drag', type: 'note', x: 40, y: 260, width: 300, height: 200 },
  ]);
  await setView(page, { panX: 0, panY: 0, zoom: 1 });

  const box = await page.locator('#pane-tap-drag').boundingBox();
  // Well past the 15px tap threshold, so this is a drag.
  await drag(touch,
    { x: box.x + 30, y: box.y + box.height / 2 },
    { x: box.x + 230, y: box.y + box.height / 2 });

  await expect(page.locator('body')).not.toHaveClass(/pane-expanded/);
});

test('the page itself cannot be zoomed or rubber-banded', async ({ page }) => {
  // Canvas pinch has to be the only zoom. Browser page zoom on top of it
  // produces a double-zoom that neither handler can undo.
  const meta = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(meta).toContain('user-scalable=no');
  expect(meta).toContain('maximum-scale=1.0');
  // Needed for env() safe-area insets to report anything but zero.
  expect(meta).toContain('viewport-fit=cover');

  // touch-action stops the browser claiming a gesture before the handlers see
  // it. It is not an inherited property, but a gesture is resolved against the
  // hit element's ancestors, so the rule belongs on body and descendants
  // legitimately compute to 'auto'. The behavioural proof is the spec below.
  const touchAction = await page.locator('body')
    .evaluate(el => getComputedStyle(el).touchAction);
  expect(touchAction).toBe('none');
});

test('the canvas does not scroll the document', async ({ page }) => {
  await seedPanes(page, [{ id: 'sc-a', x: 0, y: 0, width: 300, height: 300 }]);
  await setView(page, { panX: 0, panY: 0, zoom: 1 });

  // A pan that moves the canvas must not also scroll the page underneath it,
  // which on iOS shows up as the whole view sliding and the URL bar animating.
  await drag(touch, { x: 200, y: 600 }, { x: 260, y: 400 });

  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  expect(scroll).toEqual({ x: 0, y: 0 });
});
