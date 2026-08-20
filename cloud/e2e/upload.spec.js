import { test, expect, openApp } from './helpers/app.js';

// Upload cannot be exercised end to end here: every file operation goes through
// a connected agent and the harness has none. What is testable is the UI
// surface and the drag bookkeeping, which is where the subtle bug lives —
// dragenter fires again for every child element the cursor crosses, so a naive
// handler drops the overlay on the first dragleave inside the pane.

async function seedFolderPane(page, id = 'up-folder') {
  await page.evaluate((paneId) => {
    const D = window.TC2_DEBUG;
    const pane = {
      id: paneId, type: 'folder', x: 40, y: 260, width: 320, height: 260,
      folderPath: '/tmp', zIndex: 10,
    };
    D.state.panes.push(pane);
    D.renderFolderPane(pane);
  }, id);
  await expect(page.locator(`#pane-${id}`)).toBeAttached();
}

// Synthetic drag events carrying a Files type, which is all the handler checks.
async function fireDrag(page, selector, type) {
  await page.evaluate(({ selector, type }) => {
    const el = document.querySelector(selector);
    const dt = new DataTransfer();
    const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
    // DataTransfer.types is read-only and empty without real files attached.
    Object.defineProperty(ev.dataTransfer, 'types', { value: ['Files'] });
    el.dispatchEvent(ev);
  }, { selector, type });
}

test('a folder pane offers an upload button', async ({ page }) => {
  await openApp(page);
  await seedFolderPane(page);

  const btn = page.locator('#pane-up-folder .folder-upload-btn');
  await expect(btn).toBeAttached();
  await expect(btn).toHaveAttribute('data-tooltip', /upload/i);
});

test('the upload button opens a multi-file picker', async ({ page }) => {
  await openApp(page);
  await seedFolderPane(page);

  const chooser = page.waitForEvent('filechooser');
  await page.locator('#pane-up-folder .folder-upload-btn').click();
  const fc = await chooser;
  expect(fc.isMultiple()).toBe(true);
});

test('dragging files over the pane shows a drop target', async ({ page }) => {
  await openApp(page);
  await seedFolderPane(page);

  const pane = page.locator('#pane-up-folder');
  await expect(pane).not.toHaveClass(/folder-drop-active/);

  await fireDrag(page, '#pane-up-folder', 'dragenter');
  await expect(pane).toHaveClass(/folder-drop-active/);

  await fireDrag(page, '#pane-up-folder', 'dragleave');
  await expect(pane).not.toHaveClass(/folder-drop-active/);
});

test('crossing child elements does not drop the target early', async ({ page }) => {
  await openApp(page);
  await seedFolderPane(page);
  const pane = page.locator('#pane-up-folder');

  // Enter the pane, then enter a child: two enters, one leave. The overlay has
  // to survive, which a boolean flag would not manage.
  await fireDrag(page, '#pane-up-folder', 'dragenter');
  await fireDrag(page, '#pane-up-folder .pane-header', 'dragenter');
  await expect(pane).toHaveClass(/folder-drop-active/);

  await fireDrag(page, '#pane-up-folder .pane-header', 'dragleave');
  await expect(pane).toHaveClass(/folder-drop-active/, { timeout: 2000 });

  await fireDrag(page, '#pane-up-folder', 'dragleave');
  await expect(pane).not.toHaveClass(/folder-drop-active/);
});

test('a drag with no files is ignored', async ({ page }) => {
  await openApp(page);
  await seedFolderPane(page);

  // Dragging a pane around the canvas must not light up an upload target.
  await page.evaluate(() => {
    const el = document.querySelector('#pane-up-folder');
    const ev = new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
    el.dispatchEvent(ev);
  });

  await expect(page.locator('#pane-up-folder')).not.toHaveClass(/folder-drop-active/);
});
