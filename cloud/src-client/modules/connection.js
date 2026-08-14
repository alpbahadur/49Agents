// ─── Connection Status ────────────────────────────────────────────────────
// The relay connection indicator, and what a pane shows when the agent
// behind it goes away: a disconnect overlay on live panes, and a
// placeholder for panes restored from the layout whose device is offline.

import { escapeHtml, formatLocationPath, truncateUrl } from './utils.js';
import { WIFI_OFF_SVG } from './constants.js';
import { setupPaneListeners } from './pane-interaction.js';

let _ctx = null;

export function initConnectionDeps(ctx) { _ctx = ctx; }


// pendingRequests, pendingScanCallbacks and agentRequest — moved to
// modules/ws-transport.js

// Update connection status indicator
export function updateConnectionStatus(paneId, status) {
  const indicator = document.querySelector(`#pane-${paneId} .connection-status`);
  if (indicator) {
    indicator.className = `connection-status ${status}`;
    indicator.setAttribute('data-tooltip', status.charAt(0).toUpperCase() + status.slice(1));
  }
}

// Wifi-off SVG icon for disconnect overlay
// WIFI_OFF_SVG — imported from modules/constants.js

// Find an online agent that matches a pane's device (hostname).
// Used when the pane's original agent is dead but the same physical machine
// may have re-registered under a new agent ID.
export function findOnlineAgentForDevice(pane) {
  // First check if the pane's own agent is online
  const ownAgent = _ctx.agents.find(a => a.agentId === pane.agentId && a.online);
  if (ownAgent) return ownAgent;
  // Match by device name → agent hostname
  if (pane.device) {
    return _ctx.agents.find(a => a.online && a.hostname === pane.device);
  }
  return null;
}

// Show or hide disconnect overlay on a pane element
// mode: 'offline' (device offline), 'resume' (claude terminal, device online), 'reconnect' (plain terminal, device online), or false to hide
export function setDisconnectOverlay(paneEl, mode) {
  let overlay = paneEl.querySelector('.disconnect-overlay');
  if (mode) {
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.className = 'disconnect-overlay';
    const paneId = paneEl.id.replace('pane-', '');

    if (mode === 'resume') {
      overlay.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
        </svg>
        <span class="disconnect-label">Session ended</span>
        <button class="disconnect-action-btn resume-btn" data-pane-id="${paneId}">Resume Conversation</button>`;
    } else if (mode === 'reconnect') {
      overlay.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
        </svg>
        <span class="disconnect-label">Terminal closed</span>
        <button class="disconnect-action-btn reconnect-btn" data-pane-id="${paneId}">Reconnect</button>`;
    } else {
      // 'offline' — original behavior
      overlay.innerHTML = `${WIFI_OFF_SVG}<span class="disconnect-label">Disconnected</span>`;
    }

    paneEl.appendChild(overlay);
    overlay.offsetHeight; // Force reflow
    overlay.classList.add('visible');
  } else if (overlay) {
    overlay.classList.remove('visible');
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
  }
}

// Render a lightweight placeholder pane for an offline agent's pane.
// Shows the correct pane type header + disconnect overlay.
// Tagged with _offlinePlaceholder so agent:online can replace them.
export function renderOfflinePlaceholder(paneData) {
  const existingPane = document.getElementById(`pane-${paneData.id}`);
  if (existingPane) return; // already rendered

  const pane = document.createElement('div');
  const typeClass = {
    file: 'file-pane', note: 'note-pane', 'git-graph': 'git-graph-pane',
    iframe: 'iframe-pane', beads: 'beads-pane', folder: 'folder-pane'
  }[paneData.type] || '';
  pane.className = `pane ${typeClass} agent-offline`.trim();
  pane.id = `pane-${paneData.id}`;
  pane.style.left = `${paneData.x}px`;
  pane.style.top = `${paneData.y}px`;
  pane.style.width = `${paneData.width}px`;
  pane.style.height = `${paneData.height}px`;
  pane.style.zIndex = paneData.zIndex;
  pane.dataset.paneId = paneData.id;

  const deviceTag = paneData.device ? _ctx.deviceLabelHtml(paneData.device) : '';
  const beadsTag = _ctx.beadsTagHtml(paneData.beadsTag);

  // Build title based on pane type
  let titleHtml = '';
  switch (paneData.type) {
    case 'terminal':
      titleHtml = `${deviceTag}${beadsTag}<span style="opacity:0.7;">Terminal</span>`;
      break;
    case 'file':
      titleHtml = `${deviceTag}📄 ${escapeHtml(paneData.fileName || 'Untitled')}`;
      break;
    case 'folder': {
      const shortPath = (paneData.folderPath || '').replace(/^\/home\/[^/]+/, '~');
      titleHtml = `${deviceTag}<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align: middle; margin-right: 4px;">${ICON_FOLDER}</svg> ${escapeHtml(shortPath)}`;
      break;
    }
    case 'beads':
      titleHtml = `${deviceTag}<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align: middle; margin-right: 4px;">${ICON_BEADS}</svg> Beads Issues`;
      break;
    case 'conversations': {
      const shortDir = (paneData.dirPath || '').replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~');
      titleHtml = `${deviceTag}<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align: middle; margin-right: 4px;">${ICON_CONVERSATIONS}</svg> ${escapeHtml(shortDir)}`;
      break;
    }
    case 'git-graph':
      titleHtml = `${deviceTag}<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align: middle; margin-right: 4px;">${ICON_GIT_GRAPH}</svg> ${escapeHtml(paneData.repoName || 'Git Graph')}`;
      break;
    case 'iframe':
      titleHtml = `🌐 ${escapeHtml(paneData.url ? truncateUrl(paneData.url) : 'Web')}`;
      break;
    case 'note':
      titleHtml = `${deviceTag}📝 Note`;
      break;
    default:
      titleHtml = `${deviceTag}${paneData.type}`;
  }

  if (!paneData.shortcutNumber) paneData.shortcutNumber = _ctx.getNextShortcutNumber();
  pane.innerHTML = `
    <div class="pane-header">
      <span class="pane-title">${titleHtml}</span>
      ${_ctx.paneNameHtml(paneData)}
      <div class="pane-header-right">
        ${_ctx.shortcutBadgeHtml(paneData)}
        <span class="connection-status disconnected" data-tooltip="Disconnected"></span>
        <button class="pane-close" aria-label="Close pane"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    </div>
    <div class="pane-content"></div>
    <div class="pane-resize-handle"></div>
  `;

  setupPaneListeners(pane, paneData);
  _ctx.getCanvas().appendChild(pane);
  // Check if another online agent can handle this pane's device
  const altAgent = findOnlineAgentForDevice(paneData);
  if (altAgent && paneData.type === 'terminal') {
    setDisconnectOverlay(pane, paneData.claudeSessionId ? 'resume' : 'reconnect');
  } else {
    setDisconnectOverlay(pane, 'offline');
  }
}

