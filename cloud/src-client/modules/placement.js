// ─── Placement Mode ───────────────────────────────────────────────────────
// The "click to place" flow for new panes: a ghost follows the cursor until
// a click drops the pane, Escape or right-click cancels. Also the pickers
// that run before placement (device, git repo, beads repo, folder,
// conversations directory) and the conversations pane itself.
//
// placementMode is owned here. app.js reads it to suppress canvas clicks
// while a placement is in flight, through the exported accessor.

import { escapeHtml, formatBytes, formatLocationPath } from './utils.js';
import { PANE_DEFAULTS, ICON_CONVERSATIONS } from './constants.js';
import { agentRequest, sendWs } from './ws-transport.js';
import { calcPlacementPos } from './minimap.js';
import { setupPaneListeners, findSnapTargets, showSnapGuides, removeSnapGuides } from './pane-interaction.js';
import { createPane, createNotePane, createIframePane, createIframePaneWithUrl, createGitGraphPane, createFilePaneFromRemote, createCustomSelect, showDevicePickerGeneric, showFileBrowser, showFolderScanPicker, showGitRepoPicker, showGitRepoPickerWithDevice, showDevicePicker, createBrowserOverlay, attachPickerKeyboardNav } from './pane-creation.js';
import { createBeadsPane, createFolderPane } from './pane-renderers.js';

const placementSizes = {
  ...PANE_DEFAULTS,
};

const placementLabels = {
  'terminal': 'Terminal',
  'file': 'File',
  'note': 'Note',
  'git-graph': 'Git Graph',
  'iframe': 'Web Page',
  'beads': 'Beads Issues',
  'folder': 'Folder',
  'conversations': 'Conversations',
};

let placementMode = null; // { type, cursorEl, createFn }

let _ctx = null;

export function initPlacementDeps(ctx) { _ctx = ctx; }

// app.js suppresses canvas click handling while a placement is in flight.
export function isPlacementActive() { return placementMode !== null; }


export function enterPlacementMode(type, createFn) {
  if (_ctx.getMoveModeActive()) _ctx.exitMoveMode();
  cancelPlacementMode();

  const size = placementSizes[type];
  const ghost = document.createElement('div');
  ghost.className = 'placement-ghost';
  ghost.style.width = `${size.width * _ctx.state.zoom}px`;
  ghost.style.height = `${size.height * _ctx.state.zoom}px`;
  ghost.innerHTML = `<div class="placement-ghost-label">${placementLabels[type]}</div>`;
  document.body.appendChild(ghost);

  placementMode = { type, cursorEl: ghost, createFn };
  _ctx.getCanvasContainer().classList.add('placement-active');

  document.addEventListener('mousemove', handlePlacementMouseMove);
  document.addEventListener('keydown', handlePlacementKeyDown);
  document.addEventListener('contextmenu', handlePlacementRightClick);
  _ctx.getCanvasContainer().addEventListener('click', handlePlacementClick);
}

export function cancelPlacementMode() {
  if (!placementMode) return;
  placementMode.cursorEl.remove();
  removeSnapGuides();
  _ctx.getCanvasContainer().classList.remove('placement-active');
  document.removeEventListener('mousemove', handlePlacementMouseMove);
  document.removeEventListener('keydown', handlePlacementKeyDown);
  document.removeEventListener('contextmenu', handlePlacementRightClick);
  _ctx.getCanvasContainer().removeEventListener('click', handlePlacementClick);
  placementMode = null;
}

function handlePlacementMouseMove(e) {
  if (!placementMode) return;
  const size = placementSizes[placementMode.type];

  // Convert cursor to _ctx.getCanvas() coords (cursor = center of ghost)
  let canvasX = (e.clientX - _ctx.state.panX) / _ctx.state.zoom - size.width / 2;
  let canvasY = (e.clientY - _ctx.state.panY) / _ctx.state.zoom - size.height / 2;

  // Snap-to-edge (reuse drag snap system)
  const fakePaneData = { id: '__placement__', width: size.width, height: size.height };
  if (!e.ctrlKey) {
    const snaps = findSnapTargets(fakePaneData, canvasX, canvasY, null);
    if (snaps) {
      if (snaps.x) canvasX = snaps.x.adjustX;
      if (snaps.y) canvasY = snaps.y.adjustY;
      showSnapGuides(snaps);
    } else {
      removeSnapGuides();
    }
  } else {
    removeSnapGuides();
  }

  // Store snapped position for click handler
  placementMode.snappedX = canvasX;
  placementMode.snappedY = canvasY;

  // Convert back to screen coords for ghost positioning (update size for current zoom)
  placementMode.cursorEl.style.width = `${size.width * _ctx.state.zoom}px`;
  placementMode.cursorEl.style.height = `${size.height * _ctx.state.zoom}px`;
  placementMode.cursorEl.style.left = `${_ctx.state.panX + canvasX * _ctx.state.zoom}px`;
  placementMode.cursorEl.style.top = `${_ctx.state.panY + canvasY * _ctx.state.zoom}px`;
}

function handlePlacementKeyDown(e) {
  if (e.key === 'Escape') {
    cancelPlacementMode();
  }
}

function handlePlacementRightClick(e) {
  if (!placementMode) return;
  e.preventDefault();
  cancelPlacementMode();
}

function handlePlacementClick(e) {
  if (!placementMode) return;
  // Don't place if clicking on UI elements
  if (e.target.closest('#add-pane-btn, #add-pane-menu, #controls, .pane-menu')) return;

  // Use snapped position from mousemove, fall back to raw conversion
  const size = placementSizes[placementMode.type];
  const canvasX = placementMode.snappedX != null ? placementMode.snappedX + size.width / 2 : (e.clientX - _ctx.state.panX) / _ctx.state.zoom;
  const canvasY = placementMode.snappedY != null ? placementMode.snappedY + size.height / 2 : (e.clientY - _ctx.state.panY) / _ctx.state.zoom;

  const createFn = placementMode.createFn;
  removeSnapGuides();
  if (e.shiftKey) {
    // Shift+Click: place pane but stay in placement mode for multi-placement
    createFn({ x: canvasX, y: canvasY });
  } else {
    cancelPlacementMode();
    createFn({ x: canvasX, y: canvasY });
  }
}

// === Picker-then-Place wrappers ===
// These run the device/file/repo pickers first, then enter placement mode

export async function showDevicePickerThenPlace() {
  showDevicePickerGeneric(
    (d) => enterPlacementMode('terminal', (pos) => createPane(d.name, pos, d.ip)),
    () => enterPlacementMode('terminal', (pos) => createPane(undefined, pos))
  );
}

export async function openFileWithDevicePickerThenPlace() {
  showDevicePickerGeneric(
    (d) => _ctx.showRecentsOrBrowse('file', d.ip,
      (filePath, fileName) => enterPlacementMode('file', (pos) => createFilePaneFromRemote(d.name, filePath, pos, d.ip)),
      () => showFileBrowser(d.name, '~', null, true, d.ip)
    ),
    (e) => alert('Failed to list devices: ' + e.message)
  );
}

export async function showGitRepoPickerWithDeviceThenPlace() {
  showDevicePickerGeneric(
    (d) => _ctx.showRecentsOrBrowse('git-graph', d.ip,
      (repoPath) => enterPlacementMode('git-graph', (pos) => createGitGraphPane(repoPath, d.name, pos, d.ip)),
      () => showGitRepoPicker(d.name, null, true, d.ip)
    ),
    () => _ctx.showRecentsOrBrowse('git-graph', _ctx.getActiveAgentId(),
      (repoPath) => enterPlacementMode('git-graph', (pos) => createGitGraphPane(repoPath, undefined, pos)),
      () => showGitRepoPicker(undefined, null, true)
    )
  );
}

// ── Conversations Pane ──

export async function createConversationsPane(dirPath, placementPos, targetAgentId, device) {
  const resolvedAgentId = targetAgentId || _ctx.getActiveAgentId();
  const position = calcPlacementPos(placementPos, 260, 250);

  try {
    const reqBody = { dirPath, position, size: PANE_DEFAULTS['conversations'] };
    if (device) reqBody.device = device;
    const cpData = await agentRequest('POST', '/api/conversations-panes', reqBody, resolvedAgentId);

    const pane = {
      id: cpData.id,
      type: 'conversations',
      x: cpData.position.x,
      y: cpData.position.y,
      width: cpData.size.width,
      height: cpData.size.height,
      zIndex: _ctx.state.nextZIndex++,
      dirPath: cpData.dirPath,
      device: device || cpData.device || null,
      agentId: resolvedAgentId,
      includeSubdirs: false,
    };

    _ctx.state.panes.push(pane); _ctx.telemetry.trackPaneOpen(pane);
    renderConversationsPane(pane);
    _ctx.cloudSaveLayout(pane);
    _ctx.saveRecentContext('conversations', pane.dirPath, pane.dirPath.split('/').filter(Boolean).pop() || pane.dirPath, resolvedAgentId);
  } catch (e) {
    console.error('[App] Failed to create conversations pane:', e);
    alert('Failed to create conversations pane: ' + e.message);
  }
}

export function renderConversationsPane(paneData) {
  const existingPane = document.getElementById(`pane-${paneData.id}`);
  if (existingPane) existingPane.remove();

  const pane = document.createElement('div');
  pane.className = 'pane conversations-pane';
  pane.id = `pane-${paneData.id}`;
  pane.style.left = `${paneData.x}px`;
  pane.style.top = `${paneData.y}px`;
  pane.style.width = `${paneData.width}px`;
  pane.style.height = `${paneData.height}px`;
  pane.style.zIndex = paneData.zIndex;
  pane.dataset.paneId = paneData.id;

  if (!paneData.shortcutNumber) paneData.shortcutNumber = _ctx.getNextShortcutNumber();
  const deviceTag = paneData.device ? _ctx.deviceLabelHtml(paneData.device) : '';
  const shortDir = (paneData.dirPath || '').replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~');
  pane.innerHTML = `
    <div class="pane-header">
      <span class="pane-title convos-title">
        ${deviceTag}<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align: middle; margin-right: 4px;">${ICON_CONVERSATIONS}</svg>
        Claude Sessions
      </span>
      ${_ctx.paneNameHtml(paneData)}
      <div class="pane-header-right">
        ${_ctx.shortcutBadgeHtml(paneData)}
        <button class="pane-close" aria-label="Close pane"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    </div>
    <div class="convos-toolbar">
      <span class="convos-dir-label" title="${escapeHtml(paneData.dirPath)}">${escapeHtml(shortDir)}</span>
      <label class="convos-toggle-label">
        <input type="checkbox" class="convos-subdirs-toggle" ${paneData.includeSubdirs ? 'checked' : ''}>
        <span class="convos-toggle-text">Subdirs</span>
      </label>
      <button class="convos-refresh-btn" title="Refresh"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>
    </div>
    <div class="convos-list"></div>
    <div class="pane-resize-handle"></div>
  `;

  setupPaneListeners(pane, paneData);

  // Subdirs toggle
  const subdirToggle = pane.querySelector('.convos-subdirs-toggle');
  subdirToggle.addEventListener('change', () => {
    paneData.includeSubdirs = subdirToggle.checked;
    fetchConversationsData(pane, paneData);
  });

  // Refresh button
  const refreshBtn = pane.querySelector('.convos-refresh-btn');
  refreshBtn.addEventListener('click', () => fetchConversationsData(pane, paneData));

  _ctx.getCanvas().appendChild(pane);

  // Initial data fetch
  fetchConversationsData(pane, paneData);
}

export async function fetchConversationsData(pane, paneData) {
  const listEl = pane.querySelector('.convos-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="convos-loading">Loading conversations...</div>';

  try {
    const depth = paneData.includeSubdirs ? 3 : 0;
    const data = await agentRequest('GET',
      `/api/conversations-panes/${paneData.id}/data?depth=${depth}`,
      null, paneData.agentId);

    const conversations = data.conversations || [];
    listEl.innerHTML = '';

    if (conversations.length === 0) {
      listEl.innerHTML = '<div class="convos-empty">No Claude conversations found for this directory.</div>';
      return;
    }

    // Get current Claude states for active indicator
    let claudeStates = {};
    try {
      const statesData = await agentRequest('GET', '/api/terminals/states', null, paneData.agentId);
      claudeStates = statesData || {};
    } catch {}

    // Build a set of active session IDs from Claude states
    const activeSessionIds = new Set();
    for (const [, stateInfo] of Object.entries(claudeStates)) {
      if (stateInfo.isClaude && stateInfo.claudeSessionId) {
        activeSessionIds.add(stateInfo.claudeSessionId);
      }
    }

    // Also build a map of session ID -> state for status indicator
    const sessionStateMap = {};
    for (const [, stateInfo] of Object.entries(claudeStates)) {
      if (stateInfo.isClaude && stateInfo.claudeSessionId) {
        sessionStateMap[stateInfo.claudeSessionId] = stateInfo.state;
      }
    }

    for (const convo of conversations) {
      const isActive = activeSessionIds.has(convo.sessionId);
      const claudeState = sessionStateMap[convo.sessionId] || null;
      const item = document.createElement('div');
      item.className = 'convos-item' + (isActive ? ' convos-item-active' : '');
      item.setAttribute('data-nav-item', '');

      const title = convo.customTitle || convo.firstPrompt || convo.sessionId.slice(0, 8);
      const truncatedTitle = title.length > 80 ? title.slice(0, 80) + '...' : title;

      // Time display
      const modified = new Date(convo.lastModified);
      const now = new Date();
      const diffMs = now - modified;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);
      let timeStr;
      if (diffMins < 1) timeStr = 'just now';
      else if (diffMins < 60) timeStr = `${diffMins}m ago`;
      else if (diffHours < 24) timeStr = `${diffHours}h ago`;
      else if (diffDays < 7) timeStr = `${diffDays}d ago`;
      else timeStr = modified.toLocaleDateString();

      // Status indicator
      let statusHtml = '';
      if (isActive) {
        const stateClass = claudeState === 'working' ? 'working' : (claudeState === 'idle' ? 'idle' : 'active');
        const stateLabel = claudeState === 'working' ? 'Working' : (claudeState === 'idle' ? 'Idle' : (claudeState === 'permission_needed' ? 'Needs Input' : 'Active'));
        statusHtml = `<span class="convos-status convos-status-${stateClass}">${stateLabel}</span>`;
      }

      // Metadata tags
      let metaHtml = '';
      if (convo.gitBranch && convo.gitBranch !== 'HEAD') {
        metaHtml += `<span class="convos-meta-tag convos-tag-branch" title="Branch: ${escapeHtml(convo.gitBranch)}">${escapeHtml(convo.gitBranch.length > 30 ? convo.gitBranch.slice(0, 30) + '...' : convo.gitBranch)}</span>`;
      }
      if (convo.beadsIssueId) {
        metaHtml += `<span class="convos-meta-tag convos-tag-beads" title="Beads: ${escapeHtml(convo.beadsIssueId)}">${escapeHtml(convo.beadsIssueId)}</span>`;
      }
      if (convo.worktree) {
        metaHtml += `<span class="convos-meta-tag convos-tag-worktree" title="Worktree: ${escapeHtml(convo.worktree)}">WT</span>`;
      }

      item.innerHTML = `
        <div class="convos-item-header">
          <span class="convos-item-indicator ${isActive ? 'active' : 'inactive'}"></span>
          <span class="convos-item-title">${escapeHtml(truncatedTitle)}</span>
          ${statusHtml}
          <span class="convos-item-time">${timeStr}</span>
        </div>
        ${metaHtml ? `<div class="convos-item-meta">${metaHtml}</div>` : ''}
      `;

      item.style.cursor = 'pointer';
      item.addEventListener('click', () => showConversationDetail(pane, paneData, convo, isActive, claudeState));
      item.addEventListener('mouseenter', () => { item.style.background = 'rgba(var(--accent-rgb),0.1)'; });
      item.addEventListener('mouseleave', () => { item.style.background = ''; });

      listEl.appendChild(item);
    }

    // Update pane title with count
    const titleEl = pane.querySelector('.convos-title');
    if (titleEl) {
      const activeCount = conversations.filter(c => activeSessionIds.has(c.sessionId)).length;
      const countStr = activeCount > 0 ? ` (${activeCount} active / ${conversations.length})` : ` (${conversations.length})`;
      titleEl.innerHTML = `${paneData.device ? _ctx.deviceLabelHtml(paneData.device) : ''}<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align: middle; margin-right: 4px;">${ICON_CONVERSATIONS}</svg> Claude Sessions${countStr}`;
    }
  } catch (e) {
    console.error('[App] Failed to fetch conversations:', e);
    listEl.innerHTML = `<div class="convos-error">Failed to load: ${escapeHtml(e.message)}</div>`;
  }
}

export async function showConversationDetail(pane, paneData, convo, isActive, claudeState) {
  // Hide toolbar and list, show detail view
  const toolbar = pane.querySelector('.convos-toolbar');
  const listEl = pane.querySelector('.convos-list');
  if (toolbar) toolbar.style.display = 'none';
  if (listEl) listEl.style.display = 'none';

  // Remove existing detail view if any
  const existingDetail = pane.querySelector('.convos-detail');
  if (existingDetail) existingDetail.remove();

  const detail = document.createElement('div');
  detail.className = 'convos-detail';

  const title = convo.customTitle || convo.firstPrompt || convo.sessionId.slice(0, 8);

  // Status indicator for active sessions
  let statusBadge = '';
  if (isActive) {
    const stateClass = claudeState === 'working' ? 'working' : (claudeState === 'idle' ? 'idle' : 'active');
    const stateLabel = claudeState === 'working' ? 'Working' : (claudeState === 'idle' ? 'Idle' : (claudeState === 'permission_needed' ? 'Needs Input' : 'Active'));
    statusBadge = `<span class="convos-status convos-status-${stateClass}">${stateLabel}</span>`;
  }

  detail.innerHTML = `
    <div class="convos-detail-actionbar">
      <button class="convos-back-btn" title="Back to list">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
      </button>
      <div class="convos-detail-actions">
        <button class="convos-action-btn convos-btn-open-claude" title="Open in Claude (resume session)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M6 8l4 4-4 4"/><line x1="12" y1="16" x2="18" y2="16"/></svg>
          Resume
        </button>
        <button class="convos-action-btn convos-btn-extract" title="Extract conversation">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Extract
        </button>
        <button class="convos-action-btn convos-btn-summarize disabled" title="Summarize (coming soon)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="10" x2="16" y2="10"/><line x1="4" y1="14" x2="12" y2="14"/><line x1="4" y1="18" x2="8" y2="18"/></svg>
          Summarize
        </button>
      </div>
    </div>
    <div class="convos-detail-header">
      <div class="convos-detail-title">${escapeHtml(title.length > 120 ? title.slice(0, 120) + '...' : title)}</div>
      ${statusBadge}
    </div>
    <div class="convos-detail-meta">
      <div class="convos-detail-meta-row"><span class="convos-detail-label">Session</span><span class="convos-detail-value">${escapeHtml(convo.sessionId)}</span></div>
      ${convo.cwd ? `<div class="convos-detail-meta-row"><span class="convos-detail-label">Directory</span><span class="convos-detail-value">${escapeHtml(convo.cwd)}</span></div>` : ''}
      ${convo.gitBranch && convo.gitBranch !== 'HEAD' ? `<div class="convos-detail-meta-row"><span class="convos-detail-label">Branch</span><span class="convos-detail-value"><span class="convos-meta-tag convos-tag-branch">${escapeHtml(convo.gitBranch)}</span></span></div>` : ''}
      ${convo.beadsIssueId ? `<div class="convos-detail-meta-row"><span class="convos-detail-label">Beads</span><span class="convos-detail-value"><span class="convos-meta-tag convos-tag-beads">${escapeHtml(convo.beadsIssueId)}</span></span></div>` : ''}
      ${convo.worktree ? `<div class="convos-detail-meta-row"><span class="convos-detail-label">Worktree</span><span class="convos-detail-value"><span class="convos-meta-tag convos-tag-worktree">${escapeHtml(convo.worktree)}</span></span></div>` : ''}
      <div class="convos-detail-meta-row"><span class="convos-detail-label">Last active</span><span class="convos-detail-value">${new Date(convo.lastModified).toLocaleString()}</span></div>
      <div class="convos-detail-meta-row"><span class="convos-detail-label">Created</span><span class="convos-detail-value">${new Date(convo.createdAt).toLocaleString()}</span></div>
      <div class="convos-detail-meta-row"><span class="convos-detail-label">Size</span><span class="convos-detail-value">${(convo.fileSize / 1024).toFixed(1)} KB</span></div>
    </div>
    <div class="convos-detail-messages">
      <div class="convos-loading">Loading messages...</div>
    </div>
  `;

  // Insert before resize handle
  const resizeHandle = pane.querySelector('.pane-resize-handle');
  pane.insertBefore(detail, resizeHandle);

  // Back button
  detail.querySelector('.convos-back-btn').addEventListener('click', () => {
    detail.remove();
    if (toolbar) toolbar.style.display = '';
    if (listEl) listEl.style.display = '';
  });

  // Open in Claude button
  detail.querySelector('.convos-btn-open-claude').addEventListener('click', async () => {
    try {
      const terminal = await agentRequest('POST', '/api/terminals', {
        workingDir: convo.cwd || '~',
      }, paneData.agentId);

      // Create the terminal pane
      const tPane = {
        id: terminal.id,
        type: 'terminal',
        x: paneData.x + paneData.width + 20,
        y: paneData.y,
        width: PANE_DEFAULTS['terminal'].width,
        height: PANE_DEFAULTS['terminal'].height,
        zIndex: _ctx.state.nextZIndex++,
        tmuxSession: terminal.tmuxSession,
        device: paneData.device || null,
        agentId: paneData.agentId,
      };
      _ctx.state.panes.push(tPane); _telemetry.trackPaneOpen(tPane);
      _ctx.renderPane(tPane);
      _ctx.cloudSaveLayout(tPane);

      // Send the resume command after a short delay to let the terminal initialize
      setTimeout(() => {
        const cmd = `claude --resume ${convo.sessionId}\n`;
        sendWs('terminal:input', { terminalId: terminal.id, data: btoa(cmd) }, paneData.agentId);
      }, 800);
    } catch (e) {
      console.error('[Conversations] Failed to open in Claude:', e);
      alert('Failed to open terminal: ' + e.message);
    }
  });

  // Extract button
  detail.querySelector('.convos-btn-extract').addEventListener('click', () => {
    showExtractFormatPicker(detail, paneData, convo);
  });

  // Summarize button (placeholder)
  detail.querySelector('.convos-btn-summarize').addEventListener('click', () => {
    // Not wired yet
  });

  // Fetch message details
  try {
    const detailData = await agentRequest('GET',
      `/api/conversations-panes/${paneData.id}/detail?sessionId=${encodeURIComponent(convo.sessionId)}`,
      null, paneData.agentId);

    const messagesEl = detail.querySelector('.convos-detail-messages');
    if (!messagesEl) return;

    const messages = detailData.messages || [];
    if (messages.length === 0) {
      messagesEl.innerHTML = '<div class="convos-empty">No messages found.</div>';
      return;
    }

    messagesEl.innerHTML = '';
    // Show up to 50 messages to avoid DOM overload
    const displayMessages = messages.slice(0, 50);
    for (const msg of displayMessages) {
      const msgEl = document.createElement('div');
      msgEl.className = `convos-message convos-message-${msg.role}`;
      const roleLabel = msg.role === 'user' ? 'You' : 'Claude';
      const timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '';
      const textPreview = msg.text.length > 500 ? msg.text.slice(0, 500) + '...' : msg.text;
      msgEl.innerHTML = `
        <div class="convos-message-header">
          <span class="convos-message-role">${roleLabel}</span>
          ${timeStr ? `<span class="convos-message-time">${timeStr}</span>` : ''}
        </div>
        <div class="convos-message-text">${escapeHtml(textPreview)}</div>
      `;
      messagesEl.appendChild(msgEl);
    }
    if (messages.length > 50) {
      const moreEl = document.createElement('div');
      moreEl.className = 'convos-empty';
      moreEl.textContent = `... and ${messages.length - 50} more messages. Extract to see all.`;
      messagesEl.appendChild(moreEl);
    }
  } catch (e) {
    const messagesEl = detail.querySelector('.convos-detail-messages');
    if (messagesEl) {
      messagesEl.innerHTML = `<div class="convos-error">Failed to load messages: ${escapeHtml(e.message)}</div>`;
    }
  }
}

export function showExtractFormatPicker(detailEl, paneData, convo) {
  // Remove existing picker if any
  const existing = detailEl.querySelector('.convos-format-picker');
  if (existing) { existing.remove(); return; }

  const picker = document.createElement('div');
  picker.className = 'convos-format-picker';

  const formats = [
    { id: 'markdown', label: 'Markdown (.md)', icon: 'M' },
    { id: 'json', label: 'JSON (.json)', icon: '{}' },
    { id: 'jsonl', label: 'Raw JSONL (.jsonl)', icon: '[]' },
  ];

  for (const fmt of formats) {
    const btn = document.createElement('button');
    btn.className = 'convos-format-option';
    btn.setAttribute('data-nav-item', '');
    btn.innerHTML = `<span class="convos-format-icon">${fmt.icon}</span> ${fmt.label}`;
    btn.addEventListener('click', async () => {
      picker.remove();
      await downloadConversation(paneData, convo, fmt.id);
    });
    picker.appendChild(btn);
  }

  // Position near the extract button
  const extractBtn = detailEl.querySelector('.convos-btn-extract');
  const actionbar = detailEl.querySelector('.convos-detail-actionbar');
  actionbar.appendChild(picker);

  // Close on outside click
  const closeHandler = (e) => {
    if (!picker.contains(e.target) && e.target !== extractBtn) {
      picker.remove();
      document.removeEventListener('click', closeHandler, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
}

export async function downloadConversation(paneData, convo, format) {
  try {
    const data = await agentRequest('GET',
      `/api/conversations-panes/${paneData.id}/extract?sessionId=${encodeURIComponent(convo.sessionId)}&format=${format}`,
      null, paneData.agentId);

    if (data.error) {
      alert('Extract failed: ' + data.error);
      return;
    }

    // Trigger browser download
    const blob = new Blob([data.content], { type: data.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = data.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error('[Conversations] Extract failed:', e);
    alert('Failed to extract conversation: ' + e.message);
  }
}

export async function showConversationsDirPickerThenPlace() {
  showDevicePickerGeneric(
    (d) => _ctx.showRecentsOrBrowse('conversations', d.ip,
      (dirPath) => enterPlacementMode('conversations', (pos) => createConversationsPane(dirPath, pos, d.ip, d.name)),
      () => showConvosFolderPickerThenPlace(d.ip, d.name)
    ),
    () => _ctx.showRecentsOrBrowse('conversations', _ctx.getActiveAgentId(),
      (dirPath) => enterPlacementMode('conversations', (pos) => createConversationsPane(dirPath, pos)),
      () => showConvosFolderPickerThenPlace()
    )
  );
}

export async function showConvosFolderPickerThenPlace(targetAgentId, device) {
  const deviceLabel = device ? _ctx.deviceLabelHtml(device, 'font-size:11px; padding:2px 8px;') : '';
  const headerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" style="color:rgba(255,255,255,0.6);">${ICON_CONVERSATIONS}</svg>
    ${deviceLabel}
    <span style="color:rgba(255,255,255,0.7); font-size:13px; font-weight:500;">Choose Directory</span>`;

  showFolderScanPicker({
    id: 'convos-dir-browser',
    headerHTML,
    scanLabel: 'Show conversations for this directory',
    device,
    targetAgentId,
    onScan: async (folderPath, contentArea, closeBrowser) => {
      closeBrowser();
      enterPlacementMode('conversations', (pos) => createConversationsPane(folderPath, pos, targetAgentId, device));
    }
  });
}

export async function showFolderPaneDevicePickerThenPlace() {
  showDevicePickerGeneric(
    (d) => _ctx.showRecentsOrBrowse('folder', d.ip,
      (folderPath) => enterPlacementMode('folder', (pos) => createFolderPane(folderPath, pos, d.ip, d.name)),
      () => showFolderPickerThenPlace(d.ip, d.name)
    ),
    () => _ctx.showRecentsOrBrowse('folder', _ctx.getActiveAgentId(),
      (folderPath) => enterPlacementMode('folder', (pos) => createFolderPane(folderPath, pos)),
      () => showFolderPickerThenPlace()
    )
  );
}

export async function showFolderPickerThenPlace(targetAgentId, device) {
  const deviceLabel = device ? _ctx.deviceLabelHtml(device, 'font-size:11px; padding:2px 8px;') : '';
  const headerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" style="color:rgba(255,255,255,0.6);">${ICON_FOLDER}</svg>
    ${deviceLabel}
    <span style="color:rgba(255,255,255,0.7); font-size:13px; font-weight:500;">Choose Folder</span>`;

  showFolderScanPicker({
    id: 'folder-pane-browser',
    headerHTML,
    scanLabel: 'Open this folder as a pane',
    device,
    targetAgentId,
    onScan: async (folderPath, contentArea, closeBrowser, navigateFolder, navRefresh) => {
      closeBrowser();
      enterPlacementMode('folder', (pos) => createFolderPane(folderPath, pos, targetAgentId, device));
    }
  });
}

// Setup global event listeners
// Beads repo picker — reuses folder browser pattern from git-graph picker.
// Scans for git repos that contain a .beads/ directory.
export async function showBeadsRepoPickerWithDeviceThenPlace() {
  showDevicePickerGeneric(
    (d) => _ctx.showRecentsOrBrowse('beads', d.ip,
      (projectPath) => enterPlacementMode('beads', (pos) => createBeadsPane(projectPath, pos, d.ip, d.name)),
      () => showBeadsRepoPickerThenPlace(d.ip, d.name)
    ),
    () => _ctx.showRecentsOrBrowse('beads', _ctx.getActiveAgentId(),
      (projectPath) => enterPlacementMode('beads', (pos) => createBeadsPane(projectPath, pos)),
      () => showBeadsRepoPickerThenPlace()
    )
  );
}

export async function showBeadsRepoPickerThenPlace(targetAgentId, device) {
  const headerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" style="color:rgba(255,255,255,0.6);">${ICON_BEADS}</svg>
    <span style="color:rgba(255,255,255,0.7); font-size:13px; font-weight:500;">Choose Folder</span>`;

  showFolderScanPicker({
    id: 'git-repo-browser',
    headerHTML,
    scanLabel: 'Scan this folder for beads projects',
    targetAgentId,
    onScan: async (folderPath, contentArea, closeBrowser, navigateFolder, navRefresh) => {
      // Set up progressive UI immediately
      contentArea.innerHTML = '';
      let scanDone = false;

      const backBar = document.createElement('div');
      backBar.style.cssText = 'display:flex; align-items:center; gap:10px; padding:8px 16px; border-bottom:1px solid rgba(255,255,255,0.06); flex-shrink:0;';
      const backBtn = document.createElement('button');
      backBtn.setAttribute('data-nav-item', '');
      backBtn.style.cssText = 'background:none; border:none; color:rgba(255,255,255,0.5); cursor:pointer; font-size:12px; padding:2px 6px; border-radius:3px;';
      backBtn.textContent = '\u2190 Back';
      backBtn.addEventListener('click', () => navigateFolder(folderPath));
      backBtn.addEventListener('mouseenter', () => { backBtn.style.color = '#fff'; });
      backBtn.addEventListener('mouseleave', () => { backBtn.style.color = 'rgba(255,255,255,0.5)'; });
      backBar.appendChild(backBtn);

      const scanStatus = document.createElement('span');
      scanStatus.style.cssText = 'font-size:11px; color:rgba(255,255,255,0.3); margin-left:4px;';
      scanStatus.textContent = 'Scanning...';
      backBar.appendChild(scanStatus);

      contentArea.appendChild(backBar);

      const repoListEl = document.createElement('div');
      repoListEl.style.cssText = 'overflow-y:auto; flex:1;';
      contentArea.appendChild(repoListEl);

      let partialCount = 0;

      function makeBeadsItem(proj) {
        const item = document.createElement('div');
        item.setAttribute('data-nav-item', '');
        item.style.cssText = 'display:flex; align-items:center; gap:10px; padding:9px 16px; cursor:pointer; transition:background 0.1s; font-size:13px;';
        item.innerHTML = `
          <svg viewBox="0 0 24 24" width="16" height="16" style="color:#e8a882;">${ICON_BEADS}</svg>
          <span style="flex:1; overflow:hidden;">
            <strong style="color:rgba(255,255,255,0.9);">${escapeHtml(proj.name)}</strong><br>
            <span style="opacity:0.4; font-size:11px;">${escapeHtml(proj.path)}</span>
          </span>
        `;
        item.addEventListener('click', () => {
          closeBrowser();
          enterPlacementMode('beads', (pos) => createBeadsPane(proj.path, pos, targetAgentId, device));
        });
        item.addEventListener('mouseenter', () => { item.style.background = 'rgba(var(--accent-rgb),0.15)'; });
        item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
        return item;
      }

      try {
        const finalProjects = await agentRequest('GET', `/api/beads-projects/in-folder?path=${encodeURIComponent(folderPath)}`, null, targetAgentId, {
          onPartial: (repos) => {
            for (const proj of repos) {
              partialCount++;
              scanStatus.textContent = `Scanning... (${partialCount} found)`;
              repoListEl.appendChild(makeBeadsItem(proj));
              if (navRefresh) navRefresh();
            }
          }
        });
        scanDone = true;
        // Rebuild with authoritative final list
        repoListEl.innerHTML = '';
        if (finalProjects.length === 0) {
          const empty = document.createElement('div');
          empty.style.cssText = 'padding:20px; text-align:center; color:rgba(255,255,255,0.3); font-size:12px;';
          empty.textContent = 'No beads projects found in this folder';
          repoListEl.appendChild(empty);
        } else {
          for (const proj of finalProjects) repoListEl.appendChild(makeBeadsItem(proj));
        }
        scanStatus.textContent = `${finalProjects.length} projects`;
        if (navRefresh) navRefresh();
      } catch (e) {
        contentArea.innerHTML = `<div style="padding:20px; text-align:center; color:#f44747; font-size:12px;">Error: ${escapeHtml(e.message)}</div>`;
      }
    }
  });
}


// ============================================================================
