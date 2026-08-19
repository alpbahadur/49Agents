import { test, expect, openApp, seedPanes, setView } from './helpers/app.js';

// List view replaces the canvas rather than layering over it, and is reachable
// three ways: the corner button, Settings, and Tab+X. These specs cover the
// switching itself, that the canvas is genuinely out of the way, and that the
// preference survives a reload.

const PANES = [
  { id: 'vm-a', type: 'terminal', x: 0, y: 0, width: 400, height: 250, shortcutNumber: 1, device: 'laptop' },
  { id: 'vm-b', type: 'note', x: 500, y: 0, width: 400, height: 250 },
];

test('the corner button switches to the list and back', async ({ page }) => {
  await openApp(page);
  await seedPanes(page, PANES);

  const btn = page.locator('#view-mode-btn');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('aria-pressed', 'false');

  await btn.click();

  await expect(page.locator('body')).toHaveClass(/view-list/);
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#pane-list')).toBeVisible();
  // The canvas must be out of the layout entirely, not merely covered.
  await expect(page.locator('#canvas-container')).toBeHidden();

  await btn.click();
  await expect(page.locator('body')).not.toHaveClass(/view-list/);
  await expect(page.locator('#canvas-container')).toBeVisible();
  await expect(page.locator('#pane-list')).toBeHidden();
});

test('the list names each pane and follows its number, not its position', async ({ page }) => {
  await openApp(page);
  // Pane 1 sits far down-right of pane 2 on the canvas. Rendering assigns a
  // shortcut number to any pane without one, so in practice every pane is
  // numbered and the number is what decides the order; the unnumbered
  // fallback is covered in test/pane-summary.test.js.
  await seedPanes(page, [
    { id: 'vm-second', type: 'note', x: 0, y: 0, width: 400, height: 250, shortcutNumber: 2 },
    { id: 'vm-first', type: 'terminal', x: 900, y: 900, width: 400, height: 250, shortcutNumber: 1 },
  ]);
  await page.locator('#view-mode-btn').click();

  const rows = page.locator('.pane-list-item');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-pane-id', 'vm-first');
  await expect(rows.nth(0).locator('.pane-list-shortcut')).toHaveText('1');
  await expect(rows.nth(1)).toHaveAttribute('data-pane-id', 'vm-second');
  await expect(rows.nth(1).locator('.pane-list-label')).toHaveText('Note');
});

test('the list shows the device a pane belongs to', async ({ page }) => {
  await openApp(page);
  await seedPanes(page, PANES);
  await page.locator('#view-mode-btn').click();

  await expect(page.locator('.pane-list-item[data-pane-id="vm-a"] .pane-list-meta')).toContainText('laptop');
});

test('an empty canvas says so rather than showing a blank list', async ({ page }) => {
  await openApp(page);
  await page.locator('#view-mode-btn').click();

  await expect(page.locator('.pane-list-empty')).toBeVisible();
  await expect(page.locator('.pane-list-item')).toHaveCount(0);
});

test('tapping a row opens that pane full screen', async ({ page }) => {
  await openApp(page);
  await seedPanes(page, PANES);
  await page.locator('#view-mode-btn').click();

  await page.locator('.pane-list-item[data-pane-id="vm-b"]').click();

  await expect(page.locator('body')).toHaveClass(/pane-expanded/);
  await expect(page.locator('#pane-vm-b')).toHaveClass(/expanded/);
});

test('Tab+X switches view mode, and can be turned off', async ({ page }) => {
  await openApp(page);
  await seedPanes(page, PANES);

  // The chord is held, not pressed: Tab down, X, Tab up.
  const chord = async () => {
    await page.keyboard.down('Tab');
    await page.keyboard.press('x');
    await page.keyboard.up('Tab');
  };

  await chord();
  await expect(page.locator('body')).toHaveClass(/view-list/);
  await chord();
  await expect(page.locator('body')).not.toHaveClass(/view-list/);

  // With the preference off the chord must do nothing at all.
  await page.evaluate(() => window.TC2_DEBUG.showSettingsModal());
  await page.locator('#settings-view-mode-hotkey-toggle').evaluate(el => el.click());
  await page.keyboard.press('Escape');

  await chord();
  await expect(page.locator('body')).not.toHaveClass(/view-list/);
});

test('the view mode preference survives a reload', async ({ page }) => {
  await openApp(page);
  await seedPanes(page, PANES);

  await page.locator('#view-mode-btn').click();
  await expect(page.locator('body')).toHaveClass(/view-list/);

  // Give the debounced save a chance to reach the server before reloading.
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator('#zoom-fit')).toBeAttached();

  await expect(page.locator('body')).toHaveClass(/view-list/);
});

test('Settings can hide the corner button without losing the list', async ({ page }) => {
  await openApp(page);

  await page.evaluate(() => window.TC2_DEBUG.showSettingsModal());
  await page.locator('#settings-view-mode-btn-toggle').evaluate(el => el.click());
  await page.keyboard.press('Escape');

  await expect(page.locator('body')).toHaveClass(/hide-view-mode-btn/);
  await expect(page.locator('#view-mode-btn')).toBeHidden();

  // Tab+X is still the way in, which is what makes hiding the button safe.
  await page.keyboard.down('Tab');
  await page.keyboard.press('x');
  await page.keyboard.up('Tab');
  await expect(page.locator('body')).toHaveClass(/view-list/);
});

test('zoom controls are hidden while the canvas is not on screen', async ({ page }) => {
  await openApp(page);
  await page.locator('#view-mode-btn').click();

  await expect(page.locator('#zoom-in')).toBeHidden();
  await expect(page.locator('#zoom-out')).toBeHidden();
  await expect(page.locator('#zoom-fit')).toBeHidden();
  // The switch itself has to stay: it is the way back.
  await expect(page.locator('#view-mode-btn')).toBeVisible();
});

test('starting a new pane returns to the canvas to place it', async ({ page }) => {
  await openApp(page);
  await seedPanes(page, PANES);
  await page.locator('#view-mode-btn').click();
  await expect(page.locator('body')).toHaveClass(/view-list/);

  // Placement puts a ghost on the canvas, so the list has to step aside rather
  // than leave the user aiming at a surface they cannot see.
  await page.locator('#add-pane-btn').click();
  await page.locator('#add-pane-menu .menu-item[data-type="note"]').click();

  await expect(page.locator('body')).not.toHaveClass(/view-list/);
  await expect(page.locator('#canvas-container')).toBeVisible();
  await expect(page.locator('.placement-ghost')).toBeAttached();
});

test('switching to the list closes an expanded pane', async ({ page }) => {
  await openApp(page);
  await seedPanes(page, PANES);
  await setView(page, { panX: 0, panY: 0, zoom: 1 });

  // An expanded pane is reparented to <body> and positioned fixed, so it would
  // otherwise float over the list.
  await page.evaluate(() => window.TC2_DEBUG.expandPane('vm-a'));
  await expect(page.locator('body')).toHaveClass(/pane-expanded/);

  await page.locator('#view-mode-btn').click();

  await expect(page.locator('body')).not.toHaveClass(/pane-expanded/);
  await expect(page.locator('#pane-list')).toBeVisible();
});
