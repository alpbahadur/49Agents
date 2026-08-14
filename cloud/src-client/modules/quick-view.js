// ─── Quick View & Mention Mode ────────────────────────────────────────────
// Quick view overlays a compact summary badge on every pane at once.
// Mention mode is the two-stage picker for referencing one pane from
// another: stage one chooses the source, stage two the destination.

import { escapeHtml } from './utils.js';
import { sendWs } from './ws-transport.js';
import { CLAUDE_LOGO_SVG, ICON_BEADS, ICON_GIT_GRAPH, ICON_FOLDER, ICON_CONVERSATIONS } from './constants.js';
import { getDeviceColor, beadsTagHtml } from './terminal-lifecycle.js';
import { showIframeOverlays, hideIframeOverlays } from './pane-renderers.js';
import { syncTabGroupGeometry } from './tab-groups.js';
import { cloudSaveLayout } from './cloud.js';
import { setHoveredDeviceName, clearDeviceHighlight } from './hud.js';

let _ctx = null;

export function initQuickViewDeps(ctx) { _ctx = ctx; }


export function addQuickViewOverlay(paneEl, paneData) {
  if (paneEl.querySelector('.quick-view-overlay')) return;

  const info = _ctx.getQuickViewInfo(paneData, paneEl);
  const overlay = document.createElement('div');
  overlay.className = 'quick-view-overlay';

  const typeIcons = {
    Terminal: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v12h16V6H4zm2 2l4 4-4 4 1.5 1.5L9 12l-5.5-5.5L2 8zm6 8h6v2h-6v-2z"/></svg>',
    Claude: CLAUDE_LOGO_SVG,
    File: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>',
    Note: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h4l2-2 2 2h4a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H6zm0 2h12v16h-3l-3-3-3 3H6V4z"/></svg>',
    'Git Graph': `<svg viewBox="0 0 24 24">${ICON_GIT_GRAPH}</svg>`,
    Iframe: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><line x1="3" y1="12" x2="8" y2="12" stroke="currentColor" stroke-width="2"/><line x1="16" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="2"/><path d="M12 3c-2 3-2 6 0 9s2 6 0 9" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    Beads: `<svg viewBox="0 0 24 24">${ICON_BEADS}</svg>`
  };

  // Top-left: device name + path (colored per device)
  const qvColor = getDeviceColor(info.device);
  const qvStyle = qvColor ? ` style="background:${qvColor.bg}; border-color:${qvColor.border}; color:${qvColor.text}"` : '';
  let topLeft = `<div class="quick-view-device"${qvStyle}>${escapeHtml(info.device)}</div>`;
  if (info.path) {
    topLeft += `<div class="quick-view-path">${escapeHtml(info.path)}</div>`;
  }

  // Center: pane type icon + claude state below
  let center = `<div class="quick-view-type">${typeIcons[info.type] || ''}</div>`;
  if (info.claudeState) {
    center += `<div class="quick-view-claude-state">${info.claudeState}</div>`;
  }

  // Scale down content proportionally if pane is too small
  // Use paneData dimensions (not offsetWidth which includes canvas zoom)
  const paneW = paneData.width || 400;
  const paneH = paneData.height || 350;
  const scaleX = Math.min(1, paneW / 400);
  const scaleY = Math.min(1, paneH / 350);
  const scale = Math.min(scaleX, scaleY);
  const scaleStyle = scale < 1 ? ` style="transform:scale(${scale});transform-origin:center"` : '';

  overlay.innerHTML = `<div class="quick-view-content"${scaleStyle}>
    <div class="quick-view-top-left">${topLeft}</div>
    <div class="quick-view-center">${center}</div>
  </div>`;

  // Overlay click handler for Quick View interactions
  overlay.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const isSelected = _ctx.selectedPaneIds.has(paneData.id);

    if (e.shiftKey && !isSelected) {
      // Shift+Click unselected pane: select it
      _ctx.togglePaneSelection(paneData.id);
      _ctx.updateBroadcastIndicator();
      return;
    }

    if (e.shiftKey && isSelected) {
      // Already selected: distinguish click (deselect) vs drag
      const DRAG_THRESHOLD = 5;
      const mouseDownX = e.clientX;
      const mouseDownY = e.clientY;
      let dragging = false;

      // Prepare group drag state up front
      const rect = paneEl.getBoundingClientRect();
      const offsetX = (e.clientX - rect.left) / _ctx.state.zoom;
      const offsetY = (e.clientY - rect.top) / _ctx.state.zoom;
      const groupPanes = [];
      _ctx.selectedPaneIds.forEach(id => {
        const p = _ctx.state.panes.find(x => x.id === id);
        const el = document.getElementById(`pane-${id}`);
        if (p && el) groupPanes.push({ paneData: p, paneEl: el, startX: p.x, startY: p.y });
      });
      const anchorStartX = paneData.x;
      const anchorStartY = paneData.y;

      const onMove = (moveE) => {
        const dx = moveE.clientX - mouseDownX;
        const dy = moveE.clientY - mouseDownY;

        if (!dragging) {
          if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
          // Threshold exceeded — start dragging
          dragging = true;
          _ctx.dragState.isDragging = true;
          document.body.classList.add('no-select');
          groupPanes.forEach(({ paneEl: el }) => el.classList.add('dragging'));
          showIframeOverlays();
        }

        // Move anchor pane
        const newX = (moveE.clientX - _ctx.state.panX) / _ctx.state.zoom - offsetX;
        const newY = (moveE.clientY - _ctx.state.panY) / _ctx.state.zoom - offsetY;
        paneEl.style.left = `${newX}px`;
        paneEl.style.top = `${newY}px`;
        paneData.x = newX;
        paneData.y = newY;
        syncTabGroupGeometry(paneData);

        // Move rest of group by same delta
        const groupDx = newX - anchorStartX;
        const groupDy = newY - anchorStartY;
        groupPanes.forEach(({ paneData: p, paneEl: el, startX: sx, startY: sy }) => {
          if (p.id === paneData.id) return;
          p.x = sx + groupDx;
          p.y = sy + groupDy;
          el.style.left = `${p.x}px`;
          el.style.top = `${p.y}px`;
        });
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (dragging) {
          _ctx.dragState.isDragging = false;
          document.body.classList.remove('no-select');
          groupPanes.forEach(({ paneEl: el }) => el.classList.remove('dragging'));
          hideIframeOverlays();
          // Save all positions (cloud-only)
          groupPanes.forEach(({ paneData: p }) => {
            cloudSaveLayout(p);
          });
        } else {
          // Quick click — deselect
          _ctx.togglePaneSelection(paneData.id);
          _ctx.updateBroadcastIndicator();
        }
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      return;
    }

    // Click without Shift on unselected pane: exit overlay mode, focus
    if (_ctx.getQuickViewActive()) {
      toggleQuickView();
    } else if (_ctx.getDeviceHoverActive()) {
      setHoveredDeviceName(null);
      clearDeviceHighlight();
    }
    _ctx.focusPane(paneData);
    _ctx.focusTerminalInput(paneData.id);
  });

  paneEl.appendChild(overlay);
}

export function removeQuickViewOverlay(paneEl) {
  const overlay = paneEl.querySelector('.quick-view-overlay');
  if (overlay) overlay.remove();
}

export function toggleQuickView() {
  if (_ctx.getMentionModeActive()) exitMentionMode();
  _ctx.setQuickViewActive(!_ctx.getQuickViewActive());

  if (_ctx.getQuickViewActive()) {
    // Clear any broadcast selection from normal mode
    _ctx.clearMultiSelect();
    // Overlay ALL panes — no interaction allowed in Quick View
    document.querySelectorAll('.pane').forEach(paneEl => {
      const paneId = paneEl.dataset.paneId;
      const paneData = _ctx.state.panes.find(p => p.id === paneId);
      if (!paneData) return;
      addQuickViewOverlay(paneEl, paneData);
    });
    // Remove focused state from all panes
    document.querySelectorAll('.pane.focused').forEach(p => p.classList.remove('focused'));
  } else {
    document.querySelectorAll('.quick-view-overlay').forEach(o => o.remove());
    document.querySelectorAll('.pane.qv-hover').forEach(p => p.classList.remove('qv-hover'));
    _ctx.clearMultiSelect();
  }
}

// === Mention Mode (two-stage) ===
// Stage 1: pick what to mention (file, iframe, beads issue)
// Stage 2: pick which Claude Code terminal to paste into
export function enterMentionMode(payload) {
  if (_ctx.getMoveModeActive()) _ctx.exitMoveMode();
  if (_ctx.getMentionModeActive()) clearMentionOverlays();
  if (_ctx.getQuickViewActive()) toggleQuickView();
  if (_ctx.getDeviceHoverActive()) { setHoveredDeviceName(null); clearDeviceHighlight(); }
  _ctx.setMentionModeActive(true);

  if (payload) {
    // Direct to stage 2 (called from @ buttons)
    _ctx.setMentionStage(2);
    _ctx.setMentionPayload(payload);
    addMentionStage2Overlays();
    const label = payload.type === 'beads'
      ? payload.text.replace('work on this beads issue: ', '').replace(', abide claude.md rules!!!', '')
      : payload.text;
    showMentionIndicator(`@ ${escapeHtml(label)}`);
  } else {
    // Stage 1: pick source
    _ctx.setMentionStage(1);
    _ctx.setMentionPayload(null);
    addMentionStage1Overlays();
    showMentionIndicator('Select a file, URL, or issue');
  }
}

export function addMentionStage1Overlays() {
  document.querySelectorAll('.pane').forEach(paneEl => {
    const paneId = paneEl.dataset.paneId;
    const paneData = _ctx.state.panes.find(p => p.id === paneId);
    if (!paneData) return;
    if (paneEl.querySelector('.mention-overlay')) return;

    if (paneData.type === 'file') {
      paneEl.classList.add('mention-target-pane');
      const overlay = document.createElement('div');
      overlay.className = 'mention-overlay mention-source';
      overlay.innerHTML = `<div class="mention-overlay-content">
        <div class="mention-label"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align:middle; margin-right:4px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>${escapeHtml(paneData.fileName || paneData.filePath || 'File')}</div>
        <div class="mention-path">${escapeHtml(paneData.filePath || '')}</div>
      </div>`;
      overlay.addEventListener('click', (e) => {
        e.stopPropagation();
        enterMentionMode({
          type: 'file',
          text: paneData.filePath || paneData.fileName || 'untitled',
          sourceAgentId: paneData.agentId
        });
      });
      paneEl.appendChild(overlay);
    } else if (paneData.type === 'iframe') {
      paneEl.classList.add('mention-target-pane');
      const overlay = document.createElement('div');
      overlay.className = 'mention-overlay mention-source';
      overlay.innerHTML = `<div class="mention-overlay-content">
        <div class="mention-label"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle; margin-right:4px;"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="4"/><line x1="3" y1="12" x2="8" y2="12"/><line x1="16" y1="12" x2="21" y2="12"/><path d="M12 3c-2 3-2 6 0 9s2 6 0 9" stroke-width="1.5"/></svg>URL</div>
        <div class="mention-path">${escapeHtml(paneData.url || '')}</div>
      </div>`;
      overlay.addEventListener('click', (e) => {
        e.stopPropagation();
        enterMentionMode({
          type: 'iframe',
          text: paneData.url,
          sourceAgentId: paneData.agentId
        });
      });
      paneEl.appendChild(overlay);
    } else if (paneData.type === 'beads') {
      paneEl.classList.add('mention-target-pane');
      const overlay = document.createElement('div');
      overlay.className = 'mention-overlay mention-source';
      overlay.innerHTML = `<div class="mention-overlay-content">
        <div class="mention-label"><svg viewBox="0 0 24 24" width="16" height="16" style="vertical-align:middle; margin-right:4px;">${ICON_BEADS}</svg>Beads Issues</div>
        <div class="mention-path">Click to choose an issue</div>
      </div>`;
      overlay.addEventListener('click', (e) => {
        e.stopPropagation();
        // Remove overlay to reveal beads rows for issue selection
        overlay.remove();
        paneEl.classList.add('mention-beads-picking');
      });
      paneEl.appendChild(overlay);
    } else {
      // Dark overlay for non-mentionable panes (terminals)
      const overlay = document.createElement('div');
      overlay.className = 'mention-overlay ' + (paneData.beadsTag ? 'mention-dark-beads' : 'mention-dark');
      if (paneData.beadsTag) {
        const shortId = paneData.beadsTag.id.replace(/^.*-/, '');
        overlay.innerHTML = `<div class="mention-overlay-content">
          <div class="mention-label"><svg viewBox="0 0 24 24" width="16" height="16" style="vertical-align:middle; margin-right:4px;">${ICON_BEADS}</svg>${escapeHtml(shortId)}</div>
          <div class="mention-path">${escapeHtml((paneData.beadsTag.title || '').slice(0, 80))}</div>
        </div>`;
      }
      overlay.addEventListener('click', (e) => {
        e.stopPropagation();
        exitMentionMode();
      });
      paneEl.appendChild(overlay);
    }
  });
}

export function addMentionStage2Overlays() {
  document.querySelectorAll('.pane').forEach(paneEl => {
    const paneId = paneEl.dataset.paneId;
    const paneData = _ctx.state.panes.find(p => p.id === paneId);
    if (!paneData) return;
    if (paneEl.querySelector('.mention-overlay')) return;

    const info = _ctx.getQuickViewInfo(paneData, paneEl);
    const isClaude = info.type === 'Claude';
    const sameDevice = paneData.agentId === _ctx.getMentionPayload().sourceAgentId
      || (!paneData.agentId && !_ctx.getMentionPayload().sourceAgentId);
    const isTarget = isClaude && sameDevice;

    const hasBeadsTag = !!paneData.beadsTag;
    const overlay = document.createElement('div');
    if (isTarget) {
      overlay.className = 'mention-overlay mention-target' + (hasBeadsTag ? ' mention-target-beads' : '');
    } else {
      overlay.className = 'mention-overlay ' + (hasBeadsTag ? 'mention-dark-beads' : 'mention-dark');
    }

    if (isTarget) {
      paneEl.classList.add('mention-target-pane');
      const beadsInfo = hasBeadsTag ? `<div class="mention-beads-info"><svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:middle; margin-right:3px;">${ICON_BEADS}</svg>${escapeHtml(paneData.beadsTag.id.replace(/^.*-/, ''))} — ${escapeHtml((paneData.beadsTag.title || '').slice(0, 60))}</div>` : '';
      overlay.innerHTML = `<div class="mention-overlay-content">
        <div class="mention-label">@ Mention here</div>
        <div class="mention-device">${escapeHtml(info.device)}</div>
        <div class="mention-path">${escapeHtml(info.path)}</div>
        ${beadsInfo}
      </div>`;
      overlay.addEventListener('click', (e) => {
        e.stopPropagation();
        sendWs('terminal:input', {
          terminalId: paneData.id,
          data: btoa(_ctx.getMentionPayload().text)
        }, paneData.agentId);
        // Auto-set beads tag when mentioning a beads issue to a terminal
        if (_ctx.getMentionPayload().type === 'beads' && _ctx.getMentionPayload().issueId) {
          paneData.beadsTag = { id: _ctx.getMentionPayload().issueId, title: _ctx.getMentionPayload().issueTitle || '', status: _ctx.getMentionPayload().issueStatus || 'open', blocked: !!_ctx.getMentionPayload().issueBlocked };
          cloudSaveLayout(paneData);
          // Update the badge in the header
          const titleEl = paneEl.querySelector('.pane-title');
          if (titleEl) {
            const existing = titleEl.querySelector('.beads-tag-badge');
            if (existing) existing.remove();
            const temp = document.createElement('span');
            temp.innerHTML = beadsTagHtml(paneData.beadsTag);
            const badge = temp.firstChild;
            const insertBefore = titleEl.querySelector('span[style*="opacity"]') || titleEl.querySelector('.claude-header');
            if (insertBefore) titleEl.insertBefore(badge, insertBefore);
            else titleEl.appendChild(badge);
          }
        }
        exitMentionMode();
        _ctx.focusPane(paneData);
        _ctx.focusTerminalInput(paneData.id);
      });
    } else {
      if (hasBeadsTag) {
        const shortId = paneData.beadsTag.id.replace(/^.*-/, '');
        overlay.innerHTML = `<div class="mention-overlay-content">
          <div class="mention-label"><svg viewBox="0 0 24 24" width="16" height="16" style="vertical-align:middle; margin-right:4px;">${ICON_BEADS}</svg>${escapeHtml(shortId)}</div>
          <div class="mention-path">${escapeHtml((paneData.beadsTag.title || '').slice(0, 80))}</div>
        </div>`;
      }
      overlay.addEventListener('click', (e) => {
        e.stopPropagation();
        exitMentionMode();
      });
    }

    paneEl.appendChild(overlay);
  });
}

export function showMentionIndicator(html) {
  let indicator = document.getElementById('mention-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'mention-indicator';
    indicator.className = 'mention-indicator';
    document.body.appendChild(indicator);
  }
  indicator.innerHTML = `<span class="mention-indicator-icon">@</span> MENTION — ${html}`;
  indicator.style.display = 'flex';
}

export function clearMentionOverlays() {
  document.querySelectorAll('.mention-overlay').forEach(o => o.remove());
  document.querySelectorAll('.pane.mention-target-pane').forEach(p => p.classList.remove('mention-target-pane'));
  document.querySelectorAll('.pane.mention-beads-picking').forEach(p => p.classList.remove('mention-beads-picking'));
}

export function exitMentionMode() {
  _ctx.setMentionModeActive(false);
  _ctx.setMentionStage(0);
  _ctx.setMentionPayload(null);
  clearMentionOverlays();
  const indicator = document.getElementById('mention-indicator');
  if (indicator) indicator.style.display = 'none';
}

// === Placement Mode ===
// Placement ghost sizes derived from PANE_DEFAULTS
// placementSizes, placementLabels -> modules/placement.js

// Enter placement mode with all picker data already resolved
// createFn(placementPos) will be called on click
