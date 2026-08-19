import { test as base, expect } from '@playwright/test';

// A first-time visitor is redirected straight to /tutorial (app.js:1607), and
// every e2e run starts against a fresh per-port database, so without seeding
// the flag every spec would silently assert against the tour's mock canvas
// instead of the app. The tour has its own #canvas and #zoom-in, so this fails
// as a false pass rather than an error — worth guarding explicitly.
export const test = base.extend({
  page: async ({ page, baseURL }, use) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('tc_tutorial', 'completed');
        // Suppress the consent modal, which is time-triggered but would cover
        // the canvas if a run ever crossed its threshold.
        localStorage.setItem('tc_onboarding_seen', '1');
        // The first-run hotkey card is a 300px-wide overlay pinned to
        // bottom-centre, outside #canvas-container, so every touch that lands
        // on it is invisible to the canvas listeners. Left in place it silently
        // swallows gestures aimed at the lower half of a phone screen.
        localStorage.setItem('tc_hotkey_tip', 'dismissed');
      } catch (e) {}
    });
    await use(page);
  },
});

export { expect };

// Load the app and wait until it is genuinely interactive: the real page is
// the one that carries the pane menu and the zoom-fit control, neither of
// which exists on the tour.
export async function openApp(page) {
  await page.goto('/');
  await expect(page.locator('#add-pane-menu')).toBeAttached();
  await expect(page.locator('#zoom-fit')).toBeAttached();
  expect(page.url()).not.toContain('/tutorial');
  // setupViewportTracking publishes once on startup; its output is the signal
  // that module wiring has run.
  await expect.poll(() => page.evaluate(
    () => getComputedStyle(document.documentElement).getPropertyValue('--app-vh').trim(),
  )).toMatch(/px$/);
}

// Put panes on the canvas so there is content to pan, clamp and fit against.
//
// Seeded through window.TC2_DEBUG rather than the add-pane flow: placement mode
// is driven by mousemove, which a touch device never produces, so the real
// flow cannot create a pane under emulation. TC2_DEBUG already exists for
// console debugging, so no production hook is added for the tests.
export async function seedPanes(page, panes) {
  await page.evaluate((specs) => {
    const D = window.TC2_DEBUG;
    for (const spec of specs) {
      const pane = { type: 'note', width: 400, height: 250, content: '', ...spec };
      D.state.panes.push(pane);
      D.renderPane(pane);
    }
  }, panes);
  await expect(page.locator('.pane')).toHaveCount(panes.length);
}

// Put the view somewhere known before a gesture, so assertions measure the
// gesture rather than wherever startup left things.
export async function setView(page, view) {
  await page.evaluate((v) => {
    const D = window.TC2_DEBUG;
    Object.assign(D.state, v);
    D.updateCanvasTransform();
  }, view);
}
