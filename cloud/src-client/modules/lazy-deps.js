// ─── Lazy Dependencies ────────────────────────────────────────────────────
// Third-party libraries fetched on first use rather than on page load.
//
// Monaco, marked and DOMPurify were three CDN script tags in index.html, and
// Monaco's core was eagerly required into a window.monacoReady promise. That
// is well over a megabyte before the canvas paints, on behalf of panes most
// sessions never open, and it is paid on every load — worst over cellular,
// which is exactly where the app is least able to afford it.
//
// Each loader caches its promise, so concurrent callers share one fetch and
// later callers resolve immediately.

const MONACO_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min';
const MARKED_URL = 'https://cdn.jsdelivr.net/npm/marked@15/marked.min.js';
const DOMPURIFY_URL = 'https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js';

const scriptPromises = new Map();

function loadScript(url) {
  if (scriptPromises.has(url)) return scriptPromises.get(url);

  const promise = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = url;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      // Drop the rejected promise so a later attempt can retry rather than
      // inheriting this failure for the rest of the session.
      scriptPromises.delete(url);
      reject(new Error(`Failed to load ${url}`));
    };
    document.head.appendChild(el);
  });

  scriptPromises.set(url, promise);
  return promise;
}

// The editor theme, defined once against whichever monaco instance loads.
function defineTheme(monaco) {
  monaco.editor.defineTheme('49agents-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6A9955' },
      { token: 'keyword', foreground: 'C586C0' },
      { token: 'string', foreground: 'CE9178' },
      { token: 'number', foreground: 'B5CEA8' },
      { token: 'type', foreground: '4EC9B0' },
    ],
    colors: {
      'editor.background': '#00000000',
      'editor.foreground': '#e0e0e0',
      'editor.lineHighlightBackground': '#ffffff08',
      'editor.selectionBackground': '#264f78',
      'editorCursor.foreground': '#aeafad',
      'editorLineNumber.foreground': '#ffffff30',
      'editorLineNumber.activeForeground': '#ffffff60',
      'editorWidget.background': '#1a1a2ecc',
      'editorWidget.border': '#ffffff15',
      'input.background': '#ffffff10',
      'input.border': '#ffffff15',
      'scrollbarSlider.background': '#ffffff20',
      'scrollbarSlider.hoverBackground': '#ffffff30',
      'scrollbarSlider.activeBackground': '#ffffff40',
      'minimap.background': '#00000000',
      'focusBorder': '#00000000',
      'editor.border': '#00000000',
    },
  });
  monaco.editor.setTheme('49agents-dark');
}

let monacoPromise = null;

// Resolves to the monaco namespace. Also assigns window.monaco, which the
// dev panel and console debugging still reach for.
export function loadMonaco() {
  if (window.monaco) return Promise.resolve(window.monaco);
  if (monacoPromise) return monacoPromise;

  monacoPromise = loadScript(`${MONACO_BASE}/vs/loader.min.js`)
    .then(() => new Promise((resolve, reject) => {
      if (typeof window.require !== 'function') {
        reject(new Error('Monaco AMD loader did not define require'));
        return;
      }
      // Monaco ships as AMD modules and needs its loader pointed at the CDN
      // before anything can be required from it.
      window.require.config({ paths: { vs: `${MONACO_BASE}/vs` } });
      window.require(['vs/editor/editor.main'], (monaco) => {
        const ns = monaco || window.monaco;
        try {
          defineTheme(ns);
        } catch (e) {
          console.error('[LazyDeps] Monaco theme setup failed:', e);
        }
        window.monaco = ns;
        resolve(ns);
      }, reject);
    }))
    .catch((e) => {
      monacoPromise = null;
      throw e;
    });

  return monacoPromise;
}

// marked and DOMPurify are UMD bundles. Their first branch is
// `typeof define === 'function' && define.amd`, and Monaco's loader defines
// exactly that — so with Monaco present they register as anonymous AMD modules
// and never assign window.marked or window.DOMPurify.
//
// This is why note markdown preview never actually rendered: index.html loaded
// Monaco's loader first, so the `if (window.marked)` guard in
// renderMarkdownPreview was always false and every preview silently fell back
// to escaped plain text. Hiding define for the duration of the fetch pushes
// each library onto its browser-global branch instead.
async function loadUmdScript(url) {
  // Monaco is mid-flight only if something opened an editor moments ago, but
  // taking define away underneath its module loader would break it, so wait
  // for it to settle first. Its failure is not this load's concern.
  if (monacoPromise) await monacoPromise.catch(() => {});

  const savedDefine = window.define;
  if (savedDefine !== undefined) window.define = undefined;
  try {
    await loadScript(url);
  } finally {
    if (savedDefine !== undefined) window.define = savedDefine;
  }
}

let markdownPromise = null;

// Resolves to { marked, DOMPurify }. Both or neither: rendering markdown
// without a sanitiser would turn note content into an XSS vector, so a
// missing DOMPurify has to fail the whole load rather than degrade quietly.
export function loadMarkdown() {
  if (markdownPromise) return markdownPromise;

  // Sequential rather than concurrent: both need define hidden while they
  // evaluate, and two overlapping loads would restore it out from under each
  // other.
  markdownPromise = (async () => {
    await loadUmdScript(MARKED_URL);
    await loadUmdScript(DOMPURIFY_URL);
    if (!window.marked || !window.DOMPurify) {
      throw new Error('Markdown libraries loaded without defining their globals');
    }
    return { marked: window.marked, DOMPurify: window.DOMPurify };
  })().catch((e) => {
    markdownPromise = null;
    throw e;
  });

  return markdownPromise;
}
