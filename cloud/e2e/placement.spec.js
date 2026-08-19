import { test, expect, openApp } from './helpers/app.js';

// Placement mode positions its ghost from mousemove and commits on a click,
// neither of which a touch device produces natively. Browsers synthesise both
// from a tap, and handlePlacementClick has a fallback that reads the tap
// position directly when no hover has set a snapped position, so the flow does
// work by touch — but nothing pinned that, and it is easy to break by
// preventDefault-ing touchstart on the canvas.
//
// These specs assert the placement path completes. They deliberately do not
// assert that a pane appears: every pane type is created through agentRequest
// (createNotePane posts to /api/notes), and no agent is connected here.

async function beginPlacement(page, type = 'note') {
  await page.locator('#add-pane-btn').click();
  await page.locator(`#add-pane-menu .menu-item[data-type="${type}"]`).click();
  await expect(page.locator('.placement-ghost')).toBeAttached();
}

test('tapping the canvas commits a placement', async ({ page }) => {
  await openApp(page);
  await beginPlacement(page);

  await page.touchscreen.tap(150, 300);

  // The ghost going away is the observable proof that handlePlacementClick ran
  // and called through to the create function.
  await expect(page.locator('.placement-ghost')).toHaveCount(0);
  await expect(page.locator('#canvas-container')).not.toHaveClass(/placement-active/);
});

test('the canvas pan handler does not swallow the placement tap', async ({ page }) => {
  await openApp(page);

  // handleTouchStart preventDefaults single-finger canvas touches, which would
  // suppress the synthesised click that placement depends on. It bails out
  // while a placement is in flight for exactly this reason.
  const defaultPrevented = [];
  await page.exposeFunction('__recordTouch', (v) => defaultPrevented.push(v));
  await page.evaluate(() => {
    document.addEventListener('touchend', (e) => window.__recordTouch(e.defaultPrevented));
  });

  await beginPlacement(page);
  await page.touchscreen.tap(150, 300);

  await expect(page.locator('.placement-ghost')).toHaveCount(0);
  expect(defaultPrevented).not.toContain(true);
});

test('a placement can still be abandoned on a phone', async ({ page }) => {
  await openApp(page);
  await beginPlacement(page);

  // Escape is the documented cancel and there is no Escape key on a phone, so
  // the tap-to-place route above is the only exit a touch user has. This pins
  // that a second placement does not stack ghosts if one is left open.
  await beginPlacement(page, 'terminal');
  await expect(page.locator('.placement-ghost')).toHaveCount(1);
});
