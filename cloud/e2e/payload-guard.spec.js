import { test, expect, openApp } from './helpers/app.js';

// Exceeding the relay's 1MB maxPayload closes the socket rather than failing the
// request, so an oversized paste used to take down every pane. Verified against
// the running server during investigation: an unguarded 2MB send comes back to
// the browser as a 1006 close.
//
// The live path for pasting images is the canvas one: Ctrl+V with nothing
// focused arms 'note' mode, and the next paste creates a note from the
// clipboard images. (The note-editor paste handler in modules/editors.js is
// unreachable — setupNoteEditorListeners is never called and .note-editor is
// never rendered.)

// Arm note paste mode, then deliver the clipboard. Both steps are required:
// the mode is only set by a Ctrl+V keydown with nothing focused.
async function canvasPasteImages(page, sizes) {
  await page.evaluate(() => {
    document.activeElement?.blur?.();
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'v', ctrlKey: true, bubbles: true, cancelable: true,
    }));
  });

  return page.evaluate((byteSizes) => {
    const dt = new DataTransfer();
    byteSizes.forEach((bytes, i) => {
      dt.items.add(new File([new Uint8Array(bytes)], `shot-${i}.png`, { type: 'image/png' }));
    });
    document.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true, cancelable: true, clipboardData: dt,
    }));
  }, sizes);
}

const noteCount = (page) =>
  page.evaluate(() => window.TC2_DEBUG.state.panes.filter(p => p.type === 'note').length);

const socketOpen = (page) =>
  page.evaluate(() => window.TC2_DEBUG.ws?.readyState === 1);

test('an oversized pasted image is refused with an explanation', async ({ page }) => {
  await openApp(page);
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });

  // 2MB raw, which base64 inflates well past the budget — an ordinary
  // full-screen screenshot.
  await canvasPasteImages(page, [2 * 1024 * 1024]);

  await expect.poll(() => dialogs.length).toBeGreaterThan(0);
  // Phrased around what the user did, with somewhere to go instead.
  expect(dialogs[0]).toMatch(/over the .* limit for a note/);
  expect(dialogs[0]).toMatch(/file pane/);

  // No note is created, so nothing exists whose first save cannot go out.
  expect(await noteCount(page)).toBe(0);
});

test('the relay connection survives the refusal', async ({ page }) => {
  await openApp(page);
  await expect.poll(() => socketOpen(page)).toBe(true);

  page.on('dialog', (d) => d.dismiss());
  await canvasPasteImages(page, [2 * 1024 * 1024]);
  await page.waitForTimeout(1000);

  // The regression that matters: this paste used to close the socket, and
  // every pane went with it.
  expect(await socketOpen(page)).toBe(true);
});

test('images that individually fit are refused once they collectively do not', async ({ page }) => {
  await openApp(page);
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });

  // Neither is close to the budget alone. A note sends every image in one
  // request, so what matters is the total — the case a per-image check waves
  // straight through.
  const each = 400 * 1024;
  await canvasPasteImages(page, [each, each]);

  await expect.poll(() => dialogs.length).toBeGreaterThan(0);
  expect(dialogs[0]).toMatch(/Remove an image first/);
  expect(await noteCount(page)).toBe(0);
  expect(await socketOpen(page)).toBe(true);
});

test('a small pasted image is not questioned', async ({ page }) => {
  await openApp(page);
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });

  await canvasPasteImages(page, [8 * 1024]);
  await page.waitForTimeout(600);

  // The paste gets past the budget check and on to creating the note, which
  // needs an agent the harness does not have — so it fails with a 404. That
  // failure is the proof: the flow reached note creation instead of stopping at
  // the guard. What must not appear is a size complaint.
  expect(dialogs.some(d => /limit/i.test(d)), `dialogs: ${JSON.stringify(dialogs)}`).toBe(false);
  expect(dialogs.some(d => /api\/notes/.test(d)), 'expected to reach note creation').toBe(true);
});
