import { test, expect, openApp } from './helpers/app.js';

// Baseline: the app has to reach an interactive canvas on a phone-sized
// viewport without throwing. Everything else in this suite assumes it.
//
// Asserting on #canvas alone is not enough — the interactive tour renders its
// own #canvas and #zoom-in, so a spec that landed on the tour by mistake would
// pass while testing nothing. openApp() checks for controls unique to the app.

test('the app loads on a phone viewport without console errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // Offline noise, not regressions: CDN assets and fonts are blocked by the
    // app's own CSP under test, and the feedback proxy has no cloud to reach.
    if (/favicon|cdn\.jsdelivr|cdnjs|fonts\.g|Content Security Policy|websocket|WebSocket|net::ERR|502|Bad Gateway|Failed to load resource/i.test(text)) return;
    errors.push(text);
  });

  await openApp(page);
  await expect(page.locator('#canvas-container')).toBeVisible();

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('viewport tracking publishes the usable height and keyboard inset', async ({ page }) => {
  await openApp(page);

  const vars = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return {
      appVh: s.getPropertyValue('--app-vh').trim(),
      keyboard: s.getPropertyValue('--keyboard-inset').trim(),
      safeTop: s.getPropertyValue('--safe-top').trim(),
    };
  });

  // --app-vh ships as a 100vh fallback and is replaced with a pixel
  // measurement once setupViewportTracking has published, so a pixel value
  // here is proof the tracking ran rather than the declaration alone.
  expect(vars.appVh).toMatch(/^\d+(\.\d+)?px$/);
  expect(parseFloat(vars.appVh)).toBeGreaterThan(200);
  // No keyboard is up, and the collapsing-URL-bar gap must not be mistaken
  // for one.
  expect(vars.keyboard).toBe('0px');
  // env() resolves even where the inset is zero, so the property must exist.
  expect(vars.safeTop).not.toBe('');
});

test('the safe-area inset resolves in the fixed controls', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#add-pane-btn')).toBeVisible();

  // Emulation reports no cutout, so the computed value must come out as the
  // designed gap: proof the calc() resolves rather than collapsing to nothing
  // and dropping the control into the corner.
  const btn = page.locator('#add-pane-btn');
  expect(await btn.evaluate(el => getComputedStyle(el).top)).toBe('16px');
  expect(await btn.evaluate(el => getComputedStyle(el).right)).toBe('16px');

  const settings = page.locator('#settings-btn');
  expect(await settings.evaluate(el => getComputedStyle(el).bottom)).toBe('24px');
});

test('the fit-all-panes control is present and labelled', async ({ page }) => {
  await openApp(page);
  const fit = page.locator('#zoom-fit');
  await expect(fit).toBeAttached();
  await expect(fit).toHaveAttribute('aria-label', /fit all panes/i);
});

test('the mobile pane drawer is available on a phone viewport', async ({ page }) => {
  await openApp(page);
  // setupMobileNavDrawer only builds the button below 768px, which both device
  // projects are.
  await expect(page.locator('#mobile-nav-btn')).toBeVisible();
});
