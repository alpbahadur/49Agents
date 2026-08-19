import { test, expect, openApp, seedPanes } from './helpers/app.js';

// Monaco, marked and DOMPurify used to be script tags in index.html, with
// Monaco's core eagerly required on top. That is over a megabyte fetched
// before the canvas paints, every load, for panes most sessions never open.
// These specs pin that the fetches do not happen until something needs them.

function trackCdnRequests(page) {
  const requested = [];
  page.on('request', (req) => {
    const url = req.url();
    if (/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/.test(url)) requested.push(url);
  });
  return requested;
}

const isMonaco = (url) => /monaco-editor/.test(url);
const isMarkdown = (url) => /marked|dompurify|purify/.test(url);

test('a plain canvas load fetches no editor or markdown libraries', async ({ page }) => {
  const requested = trackCdnRequests(page);

  await openApp(page);
  // Give anything eager a chance to fire before concluding it did not.
  await page.waitForTimeout(1500);

  expect(requested.filter(isMonaco), `monaco fetched eagerly:\n${requested.join('\n')}`).toEqual([]);
  expect(requested.filter(isMarkdown), `markdown libs fetched eagerly:\n${requested.join('\n')}`).toEqual([]);
});

test('the eager loader is gone from the page itself', async ({ page }) => {
  await openApp(page);

  // No declared script tag may point at either CDN, and the promise the old
  // preload published must no longer exist.
  const declared = await page.evaluate(() =>
    [...document.querySelectorAll('script[src]')]
      .map(s => s.src)
      .filter(src => /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/.test(src)));
  expect(declared).toEqual([]);
  expect(await page.evaluate(() => 'monacoReady' in window)).toBe(false);
});

test('list view does not pull in the editor either', async ({ page }) => {
  const requested = trackCdnRequests(page);

  await openApp(page);
  await seedPanes(page, [
    { id: 'lazy-note', type: 'note', x: 0, y: 0, width: 400, height: 250 },
  ]);
  await page.locator('#view-mode-btn').click();
  await expect(page.locator('.pane-list-item')).toHaveCount(1);
  await page.waitForTimeout(500);

  // Listing a note describes it; it does not open an editor on it.
  expect(requested.filter(isMonaco)).toEqual([]);
});

// Notes are the real Monaco path: renderNotePane calls initNoteMonaco, which
// awaits loadMonaco. Driven through TC2_DEBUG because creating a note for real
// goes through agentRequest, and no agent is connected here.
async function renderNote(page, id, content = '# hi') {
  await page.evaluate(({ id, content }) => {
    const D = window.TC2_DEBUG;
    const pane = {
      id, type: 'note', x: 0, y: 0, width: 400, height: 250,
      content, zIndex: 10, fontSize: 14,
    };
    D.state.panes.push(pane);
    D.renderNotePane(pane);
  }, { id, content });
  await expect(page.locator(`#pane-${id}`)).toBeAttached();
}

test('opening a note is what pulls the editor in', async ({ page }) => {
  const requested = trackCdnRequests(page);
  await openApp(page);

  expect(requested.filter(isMonaco)).toEqual([]);

  await renderNote(page, 'lazy-monaco');

  // Now it should arrive, and the editor should actually come up.
  await expect.poll(() => requested.filter(isMonaco).length, { timeout: 15000 }).toBeGreaterThan(0);
  await expect(page.locator('#pane-lazy-monaco .monaco-editor')).toBeAttached({ timeout: 15000 });
});

test('a second note shares the first fetch of the loader', async ({ page }) => {
  const requested = trackCdnRequests(page);
  await openApp(page);

  await renderNote(page, 'lazy-one');
  await expect(page.locator('#pane-lazy-one .monaco-editor')).toBeAttached({ timeout: 15000 });
  const afterFirst = requested.filter(u => /loader\.min\.js/.test(u)).length;
  expect(afterFirst).toBe(1);

  await renderNote(page, 'lazy-two');
  await expect(page.locator('#pane-lazy-two .monaco-editor')).toBeAttached({ timeout: 15000 });

  // The loader is fetched once for the session, not once per editor.
  expect(requested.filter(u => /loader\.min\.js/.test(u)).length).toBe(1);
});

test('markdown preview refuses to emit HTML without a sanitiser', async ({ page }) => {
  await openApp(page);

  // Block the sanitiser only. marked would still parse, and the old code
  // returned its unsanitised output whenever DOMPurify was missing, which
  // turns note content into an XSS vector. loadMarkdown now fails as a pair.
  await page.route('**/purify.min.js', (route) => route.abort());

  await renderNote(page, 'lazy-xss', '# hi\n<img src=x onerror="window.__xss=1">');
  await page.locator('#pane-lazy-xss .note-text-only-btn').click();

  const preview = page.locator('#pane-lazy-xss .note-markdown-preview');
  await expect(preview).toBeVisible();

  // No live element, however the escaped text happens to read: the substring
  // "onerror=" survives inside escaped source, and that is harmless.
  await expect(preview.locator('img')).toHaveCount(0);
  await expect(preview.locator('h1')).toHaveCount(0);
  // Escaped source instead, so the content stays readable.
  await expect(preview).toContainText('<img src=x');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('markdown preview renders sanitised HTML when the libraries load', async ({ page }) => {
  await openApp(page);

  await renderNote(page, 'lazy-md', '# Title\n\nsome **bold** text');
  await page.locator('#pane-lazy-md .note-text-only-btn').click();

  const preview = page.locator('#pane-lazy-md .note-markdown-preview');
  await expect(preview.locator('h1')).toHaveText('Title');
  await expect(preview.locator('strong')).toHaveText('bold');
});
