// ─── Shared Utilities ─────────────────────────────────────────────────────
// Pure helper functions used across the app.
// No side effects, no state dependencies, no DOM mutations.

export function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function formatBytes(bytes) {
  if (bytes == null) return '?';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

export function metricColorClass(pct) {
  if (pct >= 100) return 'metric-red';
  if (pct >= 65) return 'metric-yellow';
  if (pct < 30) return 'metric-green';
  return '';
}

export function formatLocationPath(name) {
  if (!name) return '';
  return name.split('/').map((part, i, arr) => {
    if (i === arr.length - 1) return part;
    return part + '<span class="path-dot"> \u00b7 </span>';
  }).join('');
}

export function isExternalInputFocused() {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  if (el.closest('.pane')) return el.classList.contains('beads-tag-input');
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function truncateUrl(url) {
  try {
    const u = new URL(url);
    const domain = u.hostname.replace(/^www\./, '');
    return domain.length > 30 ? domain.substring(0, 27) + '...' : domain;
  } catch {
    return url.substring(0, 30);
  }
}

export function isAgentVersionOutdated(current, latest) {
  if (!current || !latest) return false;
  const c = current.split('.').map(Number);
  const l = latest.split('.').map(Number);
  for (let i = 0; i < Math.max(c.length, l.length); i++) {
    const cv = c[i] || 0;
    const lv = l[i] || 0;
    if (cv < lv) return true;
    if (cv > lv) return false;
  }
  return false;
}

export function getTerminalFontFamily(fontName) {
  return `"${fontName}", "Fira Code", "SF Mono", Menlo, Monaco, monospace`;
}

/**
 * The reorderable pane-header controls, in their default left-to-right order.
 * Expand and close are deliberately not in the pool — they stay pinned to the
 * right so close never moves under the cursor by surprise.
 */
export const PANE_HEADER_CONTROLS = ['shortcut', 'beads', 'reload', 'zoom', 'newtab'];

/**
 * Reconcile a stored order with the controls this build actually has: drop
 * anything unknown, collapse duplicates, and append whatever is missing.
 *
 * A stored order outlives the build that wrote it — a control can be added or
 * removed between releases — so this is what stops an old preference from
 * dropping a button out of the header entirely.
 */
export function normalizePaneHeaderOrder(order, controls = PANE_HEADER_CONTROLS) {
  const seen = new Set();
  const clean = (Array.isArray(order) ? order : []).filter((key) => {
    if (!controls.includes(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...clean, ...controls.filter(key => !clean.includes(key))];
}
