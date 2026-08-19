// ─── View Mode ────────────────────────────────────────────────────────────
// Two ways to look at the same panes: the canvas, and a flat list.
//
// The canvas is the app's model and stays the authority on where a pane lives;
// list view never moves anything. It exists because pan-and-zoom is a poor way
// to find one pane among many on a screen a few inches across — you have to
// know where you left it. A list needs no spatial memory.
//
// This is deliberately not the bottom-sheet drawer. The sheet is a peek that
// closes the moment you pick something; list view is where you stay, and it
// carries the agent state that makes a phone worth looking at in the first
// place.

import { paneIcon, paneLabel, sortPanesForList, claudeStateOf } from './pane-summary.js';

let _ctx = null;
let listEl = null;
let refreshTimer = null;

export function initViewModeDeps(ctx) { _ctx = ctx; }

export function getViewMode() {
  return _ctx?.getViewMode?.() === 'list' ? 'list' : 'canvas';
}

export function setViewMode(mode) {
  const next = mode === 'list' ? 'list' : 'canvas';
  if (getViewMode() === next) return;

  _ctx.setViewModePref(next);
  applyViewMode();
}

export function toggleViewMode() {
  setViewMode(getViewMode() === 'list' ? 'canvas' : 'list');
}

// Reflect the current mode into the DOM. Called on startup once preferences
// have loaded, and on every change after that.
export function applyViewMode() {
  const list = getViewMode() === 'list';
  document.body.classList.toggle('view-list', list);

  const btn = document.getElementById('view-mode-btn');
  if (btn) {
    btn.setAttribute('aria-pressed', String(list));
    btn.setAttribute('data-tooltip', list ? 'Back to canvas' : 'Show pane list');
  }

  if (list) {
    // An expanded pane is parented to <body> and positioned fixed, so it would
    // float over the list.
    if (_ctx.getExpandedPaneId()) _ctx.collapsePane();
    renderPaneList();
    startRefresh();
  } else {
    stopRefresh();
  }
}

function ensureListEl() {
  if (listEl && listEl.isConnected) return listEl;
  listEl = document.createElement('div');
  listEl.id = 'pane-list';
  listEl.setAttribute('role', 'list');
  document.body.appendChild(listEl);
  return listEl;
}

export function renderPaneList() {
  const root = ensureListEl();
  const panes = sortPanesForList(_ctx.state.panes);

  if (panes.length === 0) {
    root.innerHTML = '<div class="pane-list-empty">No panes yet. Add one with the button above.</div>';
    return;
  }

  // Rebuilt wholesale rather than diffed: a phone-sized list is a handful of
  // rows, and the refresh only runs while the list is the visible view.
  root.innerHTML = '';

  for (const pane of panes) {
    const paneEl = document.getElementById(`pane-${pane.id}`);
    const claude = claudeStateOf(paneEl);

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pane-list-item';
    row.setAttribute('role', 'listitem');
    row.dataset.paneId = pane.id;
    if (claude) row.dataset.claudeState = claude.state;

    const icon = document.createElement('span');
    icon.className = 'pane-list-icon';
    icon.textContent = paneIcon(pane);
    icon.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.className = 'pane-list-text';

    const label = document.createElement('span');
    label.className = 'pane-list-label';
    label.textContent = paneLabel(pane);
    text.appendChild(label);

    const meta = [];
    if (pane.device) meta.push(pane.device);
    if (claude) meta.push(claude.label);
    if (meta.length) {
      const metaEl = document.createElement('span');
      metaEl.className = 'pane-list-meta';
      metaEl.textContent = meta.join(' · ');
      text.appendChild(metaEl);
    }

    row.appendChild(icon);
    row.appendChild(text);

    if (claude) {
      const dot = document.createElement('span');
      dot.className = 'pane-list-state';
      dot.setAttribute('aria-label', claude.label);
      row.appendChild(dot);
    }

    if (pane.shortcutNumber) {
      const num = document.createElement('span');
      num.className = 'pane-list-shortcut';
      num.textContent = pane.shortcutNumber;
      row.appendChild(num);
    }

    row.addEventListener('click', () => openFromList(pane.id));
    root.appendChild(row);
  }
}

// Opening from the list expands the pane over the top rather than returning to
// the canvas: the point of list view is that the canvas is not where you are.
function openFromList(paneId) {
  const pane = _ctx.state.panes.find(p => p.id === paneId);
  if (!pane) return;
  _ctx.jumpToPane(pane);
  _ctx.expandPane(paneId);
}

// Agent state changes without any pane being added or removed, and it is the
// column people are watching, so the list re-reads it on a timer while it is
// the visible view. Stopped in canvas mode so nothing runs for a hidden list.
function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(() => {
    if (getViewMode() !== 'list') return;
    if (_ctx.getExpandedPaneId()) return; // Nothing to see behind a full-screen pane.
    renderPaneList();
  }, 2000);
}

function stopRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// Panes appearing or disappearing has to show immediately rather than waiting
// for the next tick.
export function refreshPaneListIfVisible() {
  if (getViewMode() === 'list') renderPaneList();
}

export function setupViewModeToggle() {
  const controls = document.getElementById('controls');
  if (!controls || document.getElementById('view-mode-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'view-mode-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Toggle pane list view');
  btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';
  btn.addEventListener('click', () => toggleViewMode());

  controls.appendChild(btn);
  applyViewMode();
}
