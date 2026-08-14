// ─── Move Mode ────────────────────────────────────────────────────────────
// WASD navigation between panes. Entering zooms to fit the focused pane and
// dims the rest; the direction keys hop to the nearest pane in that
// direction, and leaving restores the previous zoom.

import { findPaneInDirection, calcMoveModeZoom } from './menus.js';
import { CLAUDE_LOGO_SVG, ICON_BEADS } from './constants.js';
import { escapeHtml } from './utils.js';

let _ctx = null;

export function initMoveModeDeps(ctx) { _ctx = ctx; }


export function enterMoveMode() {
  if (_ctx.getMoveModeActive()) return;
  _ctx.setMoveModeActive(true);
  // Hide cursor and kill pointer-events on panes — prevents hover focus stealing
  document.body.classList.add('cursor-suppressed');
  // Clear all focused outlines — move mode has its own visual system
  document.querySelectorAll('.pane.focused').forEach(p => p.classList.remove('focused'));
  _ctx.setMoveModeOriginalZoom(_ctx.state.zoom);

  // Determine starting pane: last focused, or nearest to screen center
  let startPane = _ctx.getLastFocusedPaneId() && _ctx.state.panes.find(p => p.id === _ctx.getLastFocusedPaneId());
  if (!startPane && _ctx.state.panes.length > 0) {
    const vcx = (window.innerWidth / 2 - _ctx.state.panX) / _ctx.state.zoom;
    const vcy = (window.innerHeight / 2 - _ctx.state.panY) / _ctx.state.zoom;
    let bestDist = Infinity;
    for (const p of _ctx.state.panes) {
      const cx = p.x + p.width / 2;
      const cy = p.y + p.height / 2;
      const d = Math.sqrt((cx - vcx) ** 2 + (cy - vcy) ** 2);
      if (d < bestDist) { bestDist = d; startPane = p; }
    }
  }
  if (!startPane) { _ctx.setMoveModeActive(false); return; }

  _ctx.setMoveModePaneId(startPane.id);

  // Zoom to fit starting pane at ~70% of viewport
  const targetZoom = calcMoveModeZoom(startPane);
  _ctx.state.zoom = targetZoom;
  const paneCenterX = startPane.x + startPane.width / 2;
  const paneCenterY = startPane.y + startPane.height / 2;
  _ctx.state.panX = window.innerWidth / 2 - paneCenterX * _ctx.state.zoom;
  _ctx.state.panY = window.innerHeight / 2 - paneCenterY * _ctx.state.zoom;

  // Animate the transition
  _ctx.getCanvas().style.transition = 'transform 100ms ease';
  _ctx.updateCanvasTransform();
  setTimeout(() => { _ctx.getCanvas().style.transition = ''; }, 120);

  // Blur ALL terminals so no xterm holds focus during move mode
  _ctx.terminals.forEach(({ xterm }) => { if (xterm) xterm.blur(); });

  // Apply visual classes
  applyMoveModeVisuals();

  // Add indicator (same style as broadcast/mention indicators)
  let indicator = document.getElementById('move-mode-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'move-mode-indicator';
    indicator.className = 'move-mode-indicator';
    document.body.appendChild(indicator);
  }
  indicator.innerHTML = `<span class="move-mode-indicator-icon">⇄</span> MOVE — WASD to navigate, Enter to select, Esc to cancel`;
  indicator.style.display = 'flex';
}

export function exitMoveMode(confirm = true) {
  if (!_ctx.getMoveModeActive()) return;
  _ctx.setMoveModeActive(false);

  // Esc (cancel): restore original zoom, centered on current pane
  if (!confirm) {
    _ctx.state.zoom = _ctx.getMoveModeOriginalZoom();
    if (_ctx.getMoveModePaneId()) {
      const pd = _ctx.state.panes.find(p => p.id === _ctx.getMoveModePaneId());
      if (pd) {
        const cx = pd.x + pd.width / 2;
        const cy = pd.y + pd.height / 2;
        _ctx.state.panX = window.innerWidth / 2 - cx * _ctx.state.zoom;
        _ctx.state.panY = window.innerHeight / 2 - cy * _ctx.state.zoom;
      }
    }
  }
  // Enter/Tab (confirm): keep current zoom and pan as-is

  // Animate transition
  _ctx.getCanvas().style.transition = 'transform 100ms ease';
  _ctx.updateCanvasTransform();
  setTimeout(() => { _ctx.getCanvas().style.transition = ''; }, 120);

  // Remove visual classes and overlays
  document.querySelectorAll('.pane.move-mode-active').forEach(p => p.classList.remove('move-mode-active'));
  document.querySelectorAll('.pane.move-mode-dimmed').forEach(p => p.classList.remove('move-mode-dimmed'));
  document.querySelectorAll('.pane .pane-hover-overlay').forEach(o => o.remove());

  // Hide indicator
  const indicator = document.getElementById('move-mode-indicator');
  if (indicator) indicator.style.display = 'none';

  // Blur ALL terminals to ensure clean slate — prevents stale xterm focus
  _ctx.terminals.forEach(({ xterm }) => { if (xterm) xterm.blur(); });

  // Focus the highlighted pane (delay terminal focus so browser settles DOM changes)
  if (_ctx.getMoveModePaneId()) {
    const paneData = _ctx.state.panes.find(p => p.id === _ctx.getMoveModePaneId());
    const focusPaneId = _ctx.getMoveModePaneId();
    if (paneData) {
      _ctx.focusPane(paneData);
      setTimeout(() => { _ctx.focusTerminalInput(focusPaneId); }, 50);
    }
  }
  _ctx.setMoveModePaneId(null);
  _ctx.saveViewState();

  // Keep cursor/pointer suppressed until actual mouse movement
  // (prevents browser-fired mouseenter from stealing focus when overlays are removed)
  const reEnableMouse = () => {
    document.body.classList.remove('cursor-suppressed');
    document.removeEventListener('mousemove', reEnableMouse);
  };
  document.addEventListener('mousemove', reEnableMouse);
}

export function applyMoveModeVisuals() {
  document.querySelectorAll('.pane.move-mode-active').forEach(p => p.classList.remove('move-mode-active'));
  document.querySelectorAll('.pane.move-mode-dimmed').forEach(p => p.classList.remove('move-mode-dimmed'));
  document.querySelectorAll('.pane .pane-hover-overlay').forEach(o => o.remove());

  document.querySelectorAll('.pane').forEach(paneEl => {
    const id = paneEl.dataset.paneId || paneEl.id.replace('pane-', '');
    if (id === _ctx.getMoveModePaneId()) {
      paneEl.classList.add('move-mode-active');
    } else {
      paneEl.classList.add('move-mode-dimmed');
    }
    const paneData = _ctx.state.panes.find(p => p.id === id);
    if (paneData && id !== _ctx.getMoveModePaneId()) {
      const hasBeads = !!paneData.beadsTag;
      const hasSession = !!paneData.claudeSessionId;
      if (hasBeads || hasSession) {
        const overlay = document.createElement('div');
        overlay.className = 'pane-hover-overlay';
        let html = '';
        if (hasSession) {
          const nameText = paneData.claudeSessionName ? escapeHtml(paneData.claudeSessionName.slice(0, 50)) : '';
          html += `<div class="claude-session-card">
            <div class="claude-session-card-id">${CLAUDE_LOGO_SVG.replace('class="claude-logo"', 'class="claude-session-card-logo"')}${escapeHtml(paneData.claudeSessionId)}</div>
            ${nameText ? `<div class="claude-session-card-name">${nameText}</div>` : ''}
          </div>`;
        }
        if (hasBeads) {
          html += `<div class="beads-hover-card">
            <div class="beads-hover-id"><svg viewBox="0 0 24 24" width="14" height="14">${ICON_BEADS}</svg>${escapeHtml(paneData.beadsTag.id)}</div>
            <div class="beads-hover-title">${escapeHtml((paneData.beadsTag.title || '').slice(0, 100))}</div>
          </div>`;
        }
        overlay.innerHTML = html;
        paneEl.appendChild(overlay);
      }
    }
  });
}

export function moveModeNavigate(direction) {
  if (!_ctx.getMoveModeActive() || !_ctx.getMoveModePaneId()) return;
  const target = findPaneInDirection(_ctx.getMoveModePaneId(), direction);
  if (!target) return;

  _ctx.setMoveModePaneId(target.id);

  // Zoom to fit target pane at ~70% viewport and center
  const targetZoom = calcMoveModeZoom(target);
  _ctx.state.zoom = targetZoom;
  const cx = target.x + target.width / 2;
  const cy = target.y + target.height / 2;
  _ctx.state.panX = window.innerWidth / 2 - cx * _ctx.state.zoom;
  _ctx.state.panY = window.innerHeight / 2 - cy * _ctx.state.zoom;

  _ctx.getCanvas().style.transition = 'transform 100ms ease';
  _ctx.updateCanvasTransform();
  setTimeout(() => { _ctx.getCanvas().style.transition = ''; }, 120);

  // Re-blur terminal so keys stay in move mode
  const termInfo = _ctx.terminals.get(target.id);
  if (termInfo && termInfo.xterm) termInfo.xterm.blur();

  applyMoveModeVisuals();
}

