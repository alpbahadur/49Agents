// ─── Pane Creation ────────────────────────────────────────────────────────
// Creating and deleting panes of every type, restoring them from the saved
// layout, and the pickers that choose what a new pane points at — device,
// file, git repo, folder scan.
//
// createPane serialises through a queue so concurrent creations cannot
// interleave their layout writes; that queue is local to this module.

import { escapeHtml, formatBytes } from './utils.js';
import { ICON_GIT_GRAPH, PANE_DEFAULTS, PANE_ENDPOINT_MAP } from './constants.js';
import { agentRequest, sendWs } from './ws-transport.js';
import { calcPlacementPos } from './minimap.js';
import { clearTerminalNotificationState } from './notifications.js';
import { renderGitGraphPane } from './git-graph.js';
import { renderCheckpointPane, renderProjectRectangles, startProjectsSidebarRefresh } from './projects.js';
import { collapsePane, createBeadsPane, createFolderPane, renderBeadsPane, renderFolderPane, renderIframePane, renderNotePane } from './pane-renderers.js';
import { refreshPaneListIfVisible } from './view-mode.js';

let _ctx = null;

export function initPaneCreationDeps(ctx) { _ctx = ctx; }


// Load all 6 pane types from a single agent, tagging each with agentId
// Pane type configuration for data-driven loading
const PANE_TYPES = [
  { type: 'terminal', endpoint: '/api/terminals',
    defPos: { x: 50, y: 50 }, defSize: PANE_DEFAULTS['terminal'],
    extraFields: (t) => ({ tmuxSession: t.tmuxSession, device: t.device || null }),
    render: (p) => _ctx.renderPane(p) },
  { type: 'file', endpoint: '/api/file-panes',
    defPos: { x: 100, y: 100 }, defSize: PANE_DEFAULTS['file'],
    extraFields: (f) => ({ fileName: f.fileName, filePath: f.filePath, content: f.content, device: f.device || null }),
    render: (p) => _ctx.renderFilePane(p) },
  { type: 'note', endpoint: '/api/notes',
    defPos: { x: 100, y: 100 }, defSize: PANE_DEFAULTS['note'],
    extraFields: (n) => ({ content: n.content || '', fontSize: n.fontSize || 11, images: n.images || [] }),
    render: renderNotePane },
  { type: 'git-graph', endpoint: '/api/git-graphs',
    defPos: { x: 100, y: 100 }, defSize: PANE_DEFAULTS['git-graph'],
    extraFields: (g) => ({ repoPath: g.repoPath, repoName: g.repoName, device: g.device }),
    render: renderGitGraphPane },
  { type: 'iframe', endpoint: '/api/iframes',
    defPos: { x: 100, y: 100 }, defSize: PANE_DEFAULTS['iframe'],
    extraFields: (f) => ({ url: f.url }),
    render: renderIframePane },
  { type: 'beads', endpoint: '/api/beads-panes',
    defPos: { x: 100, y: 100 }, defSize: PANE_DEFAULTS['beads'],
    extraFields: (b) => ({ projectPath: b.projectPath, device: b.device || null }),
    render: renderBeadsPane },
  { type: 'folder', endpoint: '/api/folder-panes',
    defPos: { x: 100, y: 100 }, defSize: PANE_DEFAULTS['folder'],
    extraFields: (f) => ({ folderPath: f.folderPath, device: f.device || null }),
    render: renderFolderPane },
  { type: 'conversations', endpoint: '/api/conversations-panes',
    defPos: { x: 100, y: 100 }, defSize: PANE_DEFAULTS['conversations'],
    extraFields: (c) => ({ dirPath: c.dirPath, device: c.device || null }),
    render: (p) => _ctx.renderConversationsPane(p) },
];

export async function loadPanesFromAgent(agentId, cloudLayoutMap) {
  const agent = _ctx.agents.find(a => a.agentId === agentId);
  const agentHostname = agent && agent.hostname ? agent.hostname : null;

  const results = await Promise.all(
    PANE_TYPES.map(cfg => agentRequest('GET', cfg.endpoint, null, agentId).catch(() => []))
  );

  PANE_TYPES.forEach((cfg, i) => {
    for (const item of results[i]) {
      if (_ctx.state.panes.some(p => p.id === item.id)) continue;
      // Prefer cloud-saved layout, then agent-provided, then defaults
      const cl = cloudLayoutMap && cloudLayoutMap.get(item.id);
      const position = cl ? { x: cl.position_x, y: cl.position_y } : (item.position || cfg.defPos);
      const size = cl ? { width: cl.width, height: cl.height } : (item.size || cfg.defSize);
      const pane = {
        id: item.id,
        type: cfg.type,
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        zIndex: (cl && cl.z_index) ? cl.z_index : _ctx.state.nextZIndex++,
        ...cfg.extraFields(item),
        agentId: agentId
      };
      // Restore metadata from cloud layout
      if (cl && cl.metadata) {
        if (cl.metadata.device && !pane.device) pane.device = cl.metadata.device;
        if (cl.metadata.zoomLevel) pane.zoomLevel = cl.metadata.zoomLevel;
        if (cl.metadata.textOnly) pane.textOnly = cl.metadata.textOnly;
        if (cl.metadata.folderPath) pane.folderPath = cl.metadata.folderPath;
        if (cl.metadata.beadsTag) pane.beadsTag = cl.metadata.beadsTag;
        if (cl.metadata.dirPath) pane.dirPath = cl.metadata.dirPath;
        if (cl.metadata.claudeSessionId) pane.claudeSessionId = cl.metadata.claudeSessionId;
        if (cl.metadata.claudeSessionName) pane.claudeSessionName = cl.metadata.claudeSessionName;
        if (cl.metadata.workingDir) pane.workingDir = cl.metadata.workingDir;
        if (cl.metadata.shortcutNumber) pane.shortcutNumber = cl.metadata.shortcutNumber;
        if (cl.metadata.paneName) pane.paneName = cl.metadata.paneName;
        if (cl.metadata.tabGroupId) pane.tabGroupId = cl.metadata.tabGroupId;
        if (cl.metadata.tabGroupActive) pane.tabGroupActive = true;
      }
      // Fill in device from agent hostname if the agent didn't return one
      if (!pane.device && agentHostname) pane.device = agentHostname;
      _ctx.state.panes.push(pane); _ctx.telemetry.trackPaneOpen(pane);
      cfg.render(pane);
    }
  });
}


export async function loadTerminalsFromServer() {
  try {
    // Fetch cloud layouts FIRST so panes render with correct positions immediately
    let cloudLayoutMap = new Map();
    let cloudLayouts = [];
    try {
      const cloudData = await _ctx.cloudFetch('GET', '/api/layouts');
      if (cloudData.layouts && cloudData.layouts.length > 0) {
        cloudLayouts = cloudData.layouts;
        cloudLayoutMap = new Map(cloudLayouts.map(l => [l.id, l]));
      }
    } catch (e) {
      console.warn('[Cloud] Failed to pre-fetch cloud layouts:', e.message);
    }

    // Load panes from all online _ctx.agents, passing cloud layout data for correct positioning
    const onlineAgents = _ctx.agents.filter(a => a.online);
    if (onlineAgents.length > 0) {
      await Promise.all(onlineAgents.map(a => loadPanesFromAgent(a.agentId, cloudLayoutMap)));
    }

    // Apply cloud layout data to any panes that were already in state before this load
    // (e.g. panes added by earlier agent loads or other code paths)
    for (const pane of _ctx.state.panes) {
      const cl = cloudLayoutMap.get(pane.id);
      if (cl) {
        if (cl.agent_id && !pane.agentId) pane.agentId = cl.agent_id;
      }
    }

    // Create offline placeholder panes for cloud layouts whose _ctx.agents are not online.
    // This ensures panes from disconnected devices remain visible on the _ctx.getCanvas().
    if (cloudLayouts.length > 0) {
      const existingIds = new Set(_ctx.state.panes.map(p => p.id));
      for (const cl of cloudLayouts) {
          if (existingIds.has(cl.id)) continue; // already loaded from online agent
          const meta = cl.metadata ? (typeof cl.metadata === 'string' ? JSON.parse(cl.metadata) : cl.metadata) : {};
          // Resolve device name: metadata > agent hostname from DB > _ctx.agents array
          const agentEntry = _ctx.agents.find(a => a.agentId === cl.agent_id);
          const deviceName = meta.device || cl.agent_hostname || (agentEntry && agentEntry.hostname) || null;
          const pane = {
            id: cl.id,
            type: cl.pane_type,
            x: cl.position_x,
            y: cl.position_y,
            width: cl.width,
            height: cl.height,
            zIndex: cl.z_index || _ctx.state.nextZIndex++,
            agentId: cl.agent_id || null,
            device: deviceName,
            _offlinePlaceholder: true,
          };
          // Restore type-specific fields from metadata
          if (meta.filePath) pane.filePath = meta.filePath;
          if (meta.fileName) pane.fileName = meta.fileName;
          if (meta.folderPath) pane.folderPath = meta.folderPath;
          if (meta.url) pane.url = meta.url;
          if (meta.repoPath) pane.repoPath = meta.repoPath;
          if (meta.repoName) pane.repoName = meta.repoName;
          if (meta.graphMode) pane.graphMode = meta.graphMode;
          if (meta.projectPath) pane.projectPath = meta.projectPath;
          if (meta.dirPath) pane.dirPath = meta.dirPath;
          if (meta.beadsTag) pane.beadsTag = meta.beadsTag;
          if (meta.workingDir) pane.workingDir = meta.workingDir;
          if (meta.claudeSessionId) pane.claudeSessionId = meta.claudeSessionId;
          if (meta.claudeSessionName) pane.claudeSessionName = meta.claudeSessionName;
          if (meta.shortcutNumber) pane.shortcutNumber = meta.shortcutNumber;
          if (meta.paneName) pane.paneName = meta.paneName;
          if (meta.checkpointName) pane.checkpointName = meta.checkpointName;
          if (meta.tabGroupId) pane.tabGroupId = meta.tabGroupId;
          if (meta.tabGroupActive) pane.tabGroupActive = true;
          _ctx.state.panes.push(pane); _ctx.telemetry.trackPaneOpen(pane);
          // Checkpoint panes are client-only — render them directly, not as offline placeholders
          if (pane.type === 'checkpoint') {
            pane._offlinePlaceholder = false;
            renderCheckpointPane(pane);
          } else {
            _ctx.renderOfflinePlaceholder(pane);
          }
        }
    }

    // Fetch fresh beads tag statuses
    for (const pane of _ctx.state.panes) {
      if (pane.beadsTag && pane.beadsTag.id) {
        _ctx.refreshBeadsTagStatus(pane);
      }
    }
    // Sync any panes the cloud doesn't know about yet
    for (const pane of _ctx.state.panes) {
      _ctx.cloudSaveLayout(pane);
    }

    // Cloud Phase 4: Load cloud view state
    try {
      const vs = await _ctx.cloudFetch('GET', '/api/view-state');
      if (vs && vs.zoom !== undefined) {
        _ctx.state.zoom = vs.zoom;
        _ctx.state.panX = vs.pan_x || 0;
        _ctx.state.panY = vs.pan_y || 0;
        _ctx.updateCanvasTransform();
      }
    } catch (e) {
      console.warn('[Cloud] Failed to load cloud view state:', e.message);
    }

  } catch (e) {
    console.error('[App] Failed to load panes:', e);
  }

  // Ensure _ctx.getNextTabGroupId() is ahead of any restored groups
  for (const p of _ctx.state.panes) {
    if (p.tabGroupId) {
      const match = p.tabGroupId.match(/^tg-(\d+)$/);
      if (match) _ctx.setNextTabGroupId(Math.max(_ctx.getNextTabGroupId(), parseInt(match[1], 10) + 1));
    }
  }

  // Restore tab group UI for all panes that belong to a group.
  // renderOfflinePlaceholder and loadPanesFromAgent render panes individually
  // and never call refreshTabBars — so tab groups appear as separate panes
  // until we do this pass. We also ensure exactly one pane per group is active.
  {
    const seenGroups = new Set();
    for (const p of _ctx.state.panes) {
      if (!p.tabGroupId || seenGroups.has(p.tabGroupId)) continue;
      seenGroups.add(p.tabGroupId);
      const groupPanes = _ctx.state.panes.filter(g => g.tabGroupId === p.tabGroupId);
      // Guarantee exactly one active pane per group — pick the first if none is set
      const hasActive = groupPanes.some(g => g.tabGroupActive);
      if (!hasActive && groupPanes.length > 0) groupPanes[0].tabGroupActive = true;
      // Hide non-active panes, show active one
      for (const gp of groupPanes) {
        const el = document.getElementById(`pane-${gp.id}`);
        if (el) el.style.display = gp.tabGroupActive ? '' : 'none';
      }
      _ctx.refreshTabBars(p.tabGroupId);
    }
  }

  // Re-apply cached claude states now that panes are rendered
  // (states may have arrived before DOM elements existed)
  if (_ctx.getLastReceivedClaudeStates()) {
    _ctx.updateClaudeStates(_ctx.getLastReceivedClaudeStates());
  }

  // Render project rectangles on _ctx.getCanvas()
  renderProjectRectangles();
  startProjectsSidebarRefresh();
}

/**
 * createCustomSelect — replaces a native select with a styled custom dropdown.
 * Returns { el, value (getter/setter) }.
 */
export function createCustomSelect(options, defaultValue, onChange) {
  // options: [{ value: '...', label: '...' }, ...]
  let currentValue = defaultValue || options[0].value;

  // Trigger button
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'custom-select-trigger';
  const updateLabel = () => {
    const opt = options.find(o => o.value === currentValue) || options[0];
    trigger.textContent = '';
    const labelSpan = document.createElement('span');
    labelSpan.textContent = opt.label;
    const arrowSpan = document.createElement('span');
    arrowSpan.className = 'cs-arrow';
    arrowSpan.textContent = '\u25BE';
    trigger.appendChild(labelSpan);
    trigger.appendChild(arrowSpan);
  };
  updateLabel();

  // Prevent drag/pan on _ctx.getCanvas()
  trigger.addEventListener('mousedown', (e) => e.stopPropagation());

  let panel = null;
  let outsideHandler = null;
  let escHandler = null;
  const closePanel = () => {
    if (panel) { panel.remove(); panel = null; trigger.classList.remove('open'); }
    if (outsideHandler) { document.removeEventListener('click', outsideHandler); outsideHandler = null; }
    if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
  };

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel) { closePanel(); return; }

    panel = document.createElement('div');
    panel.className = 'pane-menu custom-select-panel';

    for (const opt of options) {
      const btn = document.createElement('button');
      btn.className = 'menu-item' + (opt.value === currentValue ? ' cs-active' : '');
      btn.textContent = opt.label;
      btn.style.cssText = 'font-size:11px; padding:6px 12px;';
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        currentValue = opt.value;
        updateLabel();
        closePanel();
        if (onChange) onChange(currentValue);
      });
      panel.appendChild(btn);
    }

    // Position below trigger
    const rect = trigger.getBoundingClientRect();
    panel.style.top = (rect.bottom + 4) + 'px';
    panel.style.left = rect.left + 'px';
    panel.style.minWidth = Math.max(rect.width, 80) + 'px';

    document.body.appendChild(panel);
    trigger.classList.add('open');

    // Close on click outside
    outsideHandler = (ev) => {
      if (!panel?.contains(ev.target) && ev.target !== trigger) {
        closePanel();
      }
    };
    setTimeout(() => document.addEventListener('click', outsideHandler), 0);

    // Close on Escape
    escHandler = (ev) => {
      if (ev.key === 'Escape') {
        closePanel();
      }
    };
    document.addEventListener('keydown', escHandler);
  });

  return {
    el: trigger,
    get value() { return currentValue; },
    set value(v) {
      const opt = options.find(o => o.value === v);
      if (opt) { currentValue = v; updateLabel(); }
    }
  };
}

// Show device picker and create terminal on selected device
// Shared device picker — all 7 picker functions delegate to this
const osIcons = { linux: '\u{1F427}', windows: '\u{1FA9F}', macos: '\u{1F34E}' };

// --- Shared keyboard navigation for picker/browser modals ---
// Attaches W/S + Up/Down arrow navigation, Enter to select, Escape to close.
// Items must have [data-nav-item] attribute. Call refresh() after content changes.
export function attachPickerKeyboardNav(container, { onEscape, onExtraKey } = {}) {
  let highlightIdx = -1;
  let alive = true;

  function getItems() {
    return Array.from(container.querySelectorAll('[data-nav-item]'));
  }

  function setHighlight(idx) {
    const items = getItems();
    container.querySelectorAll('[data-nav-highlighted]').forEach(el => el.removeAttribute('data-nav-highlighted'));
    if (idx >= 0 && idx < items.length) {
      highlightIdx = idx;
      items[idx].setAttribute('data-nav-highlighted', '');
      items[idx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      highlightIdx = -1;
    }
  }

  function handler(e) {
    if (!alive || !document.body.contains(container)) { cleanup(); return; }
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;

    const key = e.key;
    const items = getItems();

    if (key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      if (onEscape) onEscape();
      return;
    }

    // Skip W/S when modifier keys are held (Ctrl+S, Tab+W chords, etc.)
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (items.length === 0) return;
    if (highlightIdx >= items.length || highlightIdx < 0) highlightIdx = 0;

    if (key === 'ArrowUp' || key.toLowerCase() === 'w') {
      e.preventDefault();
      e.stopPropagation();
      setHighlight(highlightIdx <= 0 ? items.length - 1 : highlightIdx - 1);
    } else if (key === 'ArrowDown' || key.toLowerCase() === 's') {
      e.preventDefault();
      e.stopPropagation();
      setHighlight(highlightIdx >= items.length - 1 ? 0 : highlightIdx + 1);
    } else if (key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (highlightIdx >= 0 && highlightIdx < items.length) {
        items[highlightIdx].click();
      }
    } else if (onExtraKey) {
      onExtraKey(e, items, cleanup);
    }
  }

  document.addEventListener('keydown', handler, true);

  function cleanup() {
    alive = false;
    document.removeEventListener('keydown', handler, true);
  }

  function refresh() {
    if (!alive) return;
    const items = getItems();
    highlightIdx = items.length > 0 ? 0 : -1;
    if (highlightIdx >= 0) setHighlight(highlightIdx);
  }

  requestAnimationFrame(() => { if (alive) refresh(); });

  return { cleanup, refresh };
}

export async function showDevicePickerGeneric(onDeviceSelected, onFallback) {
  try {
    const devices = _ctx.getDevicesFromAgents();

    if (devices.length === 0) {
      if (onFallback) onFallback();
      return;
    }

    if (devices.length === 1) {
      onDeviceSelected(devices[0]);
      return;
    }

    const existing = document.getElementById('device-picker');
    if (existing) existing.remove();

    const picker = document.createElement('div');
    picker.id = 'device-picker';
    picker.className = 'pane-menu';
    picker.style.cssText = 'min-width:180px;';

    for (let i = 0; i < devices.length; i++) {
      const device = devices[i];
      const btn = document.createElement('button');
      btn.className = 'menu-item';
      btn.setAttribute('data-nav-item', '');
      const icon = osIcons[device.os] || '\u{1F4BB}';
      const localBadge = device.isLocal ? ' <span style="opacity:0.5; font-size:11px;">(local)</span>' : '';
      const onlineColor = device.online ? 'var(--status-ok)' : 'var(--text-muted)';
      const numLabel = i < 9 ? `<span style="opacity:0.5; font-size:11px; margin-right:4px;">${i + 1}</span>` : '';
      btn.innerHTML = `${numLabel}<span style="font-size:16px;">${icon}</span><span style="flex:1;">${device.name}${localBadge}</span><span style="width:8px; height:8px; border-radius:50%; background:${onlineColor}; display:inline-block;"></span>`;
      btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--ink-10)'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
      btn.addEventListener('click', () => {
        nav.cleanup();
        document.removeEventListener('click', closeHandler);
        picker.remove();
        onDeviceSelected(device);
      });
      picker.appendChild(btn);
    }

    const closeHandler = (e) => {
      if (!picker.contains(e.target)) {
        nav.cleanup();
        document.removeEventListener('click', closeHandler);
        picker.remove();
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);
    document.body.appendChild(picker);

    // Keyboard nav: W/S, Up/Down, Enter, Escape + number keys 1-9
    const nav = attachPickerKeyboardNav(picker, {
      onEscape: () => {
        document.removeEventListener('click', closeHandler);
        picker.remove();
      },
      onExtraKey: (e, items, cleanup) => {
        const num = parseInt(e.key);
        if (num >= 1 && num <= 9 && num <= devices.length) {
          e.preventDefault();
          e.stopPropagation();
          cleanup();
          document.removeEventListener('click', closeHandler);
          picker.remove();
          onDeviceSelected(devices[num - 1]);
        }
      }
    });
  } catch (e) {
    console.error('[App] Device picker error:', e);
    if (onFallback) onFallback(e);
  }
}

export async function showDevicePicker(placementPos) {
  showDevicePickerGeneric(
    (d) => createPane(d.name, placementPos, d.ip),
    () => createPane(undefined, placementPos)
  );
}

// Serialize terminal creation to avoid concurrent ttyd spawns on the agent.
// Back-to-back createPane calls queue up so each terminal fully completes
// (POST + render + attach) before the next one starts.
let createPaneQueue = Promise.resolve();

// Create a new terminal pane
export function createPane(device, placementPos, targetAgentId, opts) {
  const task = createPaneQueue.then(() => _createPaneImpl(device, placementPos, targetAgentId, opts));
  createPaneQueue = task.catch(() => {});
  return task;
}

async function _createPaneImpl(device, placementPos, targetAgentId, opts = {}) {
  const resolvedAgentId = targetAgentId || _ctx.getActiveAgentId();

  const position = calcPlacementPos(placementPos, 300, 200);

  try {
    const reqBody = { workingDir: '~', position, size: PANE_DEFAULTS['terminal'] };
    if (device) reqBody.device = device;
    const terminal = await agentRequest('POST', '/api/terminals', reqBody, resolvedAgentId);

    const pane = {
      id: terminal.id,
      type: 'terminal',
      x: terminal.position.x,
      y: terminal.position.y,
      width: terminal.size.width,
      height: terminal.size.height,
      zIndex: _ctx.state.nextZIndex++,
      tmuxSession: terminal.tmuxSession,
      device: terminal.device || device || null,
      agentId: resolvedAgentId
    };

    _ctx.state.panes.push(pane); _ctx.telemetry.trackPaneOpen(pane);
    _ctx.renderPane(pane);
    _ctx.cloudSaveLayout(pane);
    // attachTerminal is called from initTerminal after a 100ms setTimeout.
    // Wait for that to fire before releasing the queue so the next terminal's
    // ttyd spawn doesn't contend with this one on the agent side.
    await new Promise(r => setTimeout(r, 200));
  } catch (e) {
    console.error('[App] Failed to create terminal:', e);
    // The starter terminal is created for the user, not by them. A modal error
    // on an otherwise empty first canvas explains nothing and blocks the app,
    // so that path fails quietly and leaves the canvas as it was.
    if (!opts.silent) alert('Failed to create terminal: ' + e.message);
    return false;
  }
  return true;
}

// Resume or reconnect a dead terminal in an existing pane
export async function resumeTerminalPane(paneId, isResume) {
  const pane = _ctx.state.panes.find(p => p.id === paneId);
  if (!pane) return;

  const el = document.getElementById(`pane-${paneId}`);
  if (!el) return;

  // Find an online agent that can handle this pane (may differ from original agent)
  const targetAgent = _ctx.findOnlineAgentForDevice(pane);
  if (!targetAgent) {
    console.error('[App] No online agent available for resume');
    return;
  }

  // Build the command for claude resume, or null for plain reconnect
  let command = null;
  if (isResume && pane.claudeSessionId) {
    command = `claude --resume ${pane.claudeSessionId}`;
  }

  // Hide overlay, show connecting state
  _ctx.setDisconnectOverlay(el, false);
  _ctx.updateConnectionStatus(paneId, 'connecting');

  try {
    const terminal = await agentRequest('POST', '/api/terminals/resume', {
      terminalId: paneId,
      workingDir: pane.workingDir || '~',
      command
    }, targetAgent.agentId);

    // Update pane to point to the new agent and tmux session
    pane.agentId = targetAgent.agentId;
    pane.tmuxSession = terminal.tmuxSession;
    // Clear placeholder flag so agent:online won't remove it
    delete pane._offlinePlaceholder;

    // If this was an offline placeholder, it has no xterm instance —
    // re-render as a full terminal pane (which initializes xterm + attaches)
    if (!_ctx.terminals.has(paneId)) {
      el.remove();
      el.classList.remove('agent-offline');
      _ctx.renderPane(pane);
    } else {
      // Already has xterm — just reattach
      el.classList.remove('agent-offline');
      _ctx.attachTerminal(pane);
    }

    // Persist the agent reassignment to cloud
    _ctx.cloudSaveLayout(pane);

  } catch (e) {
    console.error('[App] Failed to resume terminal:', e);
    if (pane.claudeSessionId) {
      _ctx.setDisconnectOverlay(el, 'resume');
    } else {
      _ctx.setDisconnectOverlay(el, 'reconnect');
    }
    _ctx.updateConnectionStatus(paneId, 'error');
  }
}

// Show device picker for opening a file, then show file browser
export async function openFileWithDevicePicker(placementPos) {
  showDevicePickerGeneric(
    (d) => showFileBrowser(d.name, '~', placementPos, false, d.ip),
    (e) => alert('Failed to list devices: ' + e.message)
  );
}

// Show the file browser overlay for a given device
// === Shared browser overlay infrastructure ===

export function createBrowserOverlay(id, headerContentHTML) {
  const existing = document.getElementById(id);
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = id;
  overlay.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; z-index:10001; display:flex; align-items:center; justify-content:center; background:var(--scrim);';

  const browser = document.createElement('div');
  browser.style.cssText = 'width:500px; max-width:90vw; max-height:70vh; background:rgba(15,20,35,0.98); border:1px solid rgba(var(--accent-rgb),0.3); border-radius:12px; display:flex; flex-direction:column; overflow:hidden; box-shadow:0 20px 60px rgba(var(--sink-rgb), 0.6);';

  const header = document.createElement('div');
  header.style.cssText = 'padding:12px 16px; background:rgba(var(--sink-rgb), 0.3); border-bottom:1px solid var(--ink-08); display:flex; align-items:center; gap:10px; flex-shrink:0;';
  header.innerHTML = headerContentHTML + '<button class="browser-overlay-close" style="margin-left:auto; background:none; border:none; color:var(--ink-40); font-size:20px; cursor:pointer; padding:2px 6px; border-radius:4px;">&times;</button>';

  const breadcrumbBar = document.createElement('div');
  breadcrumbBar.style.cssText = 'padding:8px 16px; background:rgba(var(--sink-rgb), 0.15); border-bottom:1px solid var(--ink-05); display:flex; align-items:center; gap:4px; flex-shrink:0; overflow-x:auto; font-size:12px;';

  const contentArea = document.createElement('div');
  contentArea.className = 'tc-scrollbar';
  contentArea.style.cssText = 'flex:1; overflow-y:auto; padding:4px 0; min-height:200px;';

  browser.appendChild(header);
  browser.appendChild(breadcrumbBar);
  browser.appendChild(contentArea);
  overlay.appendChild(browser);
  document.body.appendChild(overlay);

  const cleanupFns = [];
  const closeBrowser = () => { overlay.remove(); cleanupFns.forEach(fn => fn()); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeBrowser(); });
  header.querySelector('.browser-overlay-close').addEventListener('click', closeBrowser);
  // Fallback Escape handler — keyboard nav also handles Escape, but this ensures
  // Escape works even if attachPickerKeyboardNav is not attached by the caller.
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape' && document.body.contains(overlay)) { closeBrowser(); document.removeEventListener('keydown', escHandler); }
  });

  return { overlay, header, breadcrumbBar, contentArea, closeBrowser, addCleanup: (fn) => cleanupFns.push(fn) };
}

function renderBreadcrumb(breadcrumbBar, resolvedPath, onNavigate) {
  breadcrumbBar.innerHTML = '';
  const parts = resolvedPath.split('/').filter(p => p);

  const rootBtn = document.createElement('button');
  rootBtn.style.cssText = 'background:none; border:none; color:var(--ink-60); cursor:pointer; font-size:12px; padding:2px 4px; border-radius:3px;';
  rootBtn.textContent = '/';
  rootBtn.addEventListener('click', () => onNavigate('/'));
  rootBtn.addEventListener('mouseenter', () => { rootBtn.style.color = 'var(--text-bright)'; });
  rootBtn.addEventListener('mouseleave', () => { rootBtn.style.color = 'var(--ink-60)'; });
  breadcrumbBar.appendChild(rootBtn);

  parts.forEach((part, i) => {
    const sep = document.createElement('span');
    sep.style.cssText = 'color:var(--ink-20); margin:0 2px;';
    sep.textContent = '/';
    breadcrumbBar.appendChild(sep);

    const btn = document.createElement('button');
    btn.style.cssText = 'background:none; border:none; color:var(--ink-60); cursor:pointer; font-size:12px; padding:2px 4px; border-radius:3px;';
    btn.textContent = part;
    const targetPath = '/' + parts.slice(0, i + 1).join('/');
    btn.addEventListener('click', () => onNavigate(targetPath));
    btn.addEventListener('mouseenter', () => { btn.style.color = 'var(--text-bright)'; });
    btn.addEventListener('mouseleave', () => { btn.style.color = 'var(--ink-60)'; });
    breadcrumbBar.appendChild(btn);
  });
}

function createFolderItem(name, onClick) {
  const item = document.createElement('div');
  item.setAttribute('data-nav-item', '');
  item.style.cssText = 'display:flex; align-items:center; gap:10px; padding:7px 16px; cursor:pointer; transition:background 0.1s; font-size:13px;';
  const icon = name === '..' ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>' : '\u{1F4C1}';
  item.innerHTML = `<span style="width:20px; text-align:center;">${icon}</span><span style="color:var(--ink-85); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(name)}</span>`;
  item.addEventListener('click', onClick);
  item.addEventListener('mouseenter', () => { item.style.background = 'rgba(var(--accent-rgb),0.15)'; });
  item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
  return item;
}

// Shared folder-browse-then-scan picker used by git and beads repo pickers.
// config: { id, headerHTML, scanLabel, onScan(folderPath, contentArea, closeBrowser, navigateFolder, navRefresh), device, targetAgentId }
export function showFolderScanPicker(config) {
  const { id, headerHTML, scanLabel, onScan, device, targetAgentId } = config;
  const { overlay, header, breadcrumbBar, contentArea, closeBrowser, addCleanup } = createBrowserOverlay(id, headerHTML);

  // Attach keyboard nav to the overlay (lives for entire overlay lifetime)
  const nav = attachPickerKeyboardNav(overlay, { onEscape: closeBrowser });
  addCleanup(nav.cleanup);

  async function navigateFolder(path) {
    contentArea.innerHTML = '<div style="padding:40px; text-align:center; color:var(--ink-40); font-size:13px;">Loading...</div>';

    try {
      const deviceParam = device ? `&device=${encodeURIComponent(device)}` : '';
      const data = await agentRequest('GET', `/api/files/browse?path=${encodeURIComponent(path)}${deviceParam}`, null, targetAgentId);

      renderBreadcrumb(breadcrumbBar, data.path, navigateFolder);
      contentArea.innerHTML = '';

      if (data.path !== '/') {
        const parentPath = data.path.split('/').slice(0, -1).join('/') || '/';
        contentArea.appendChild(createFolderItem('..', () => navigateFolder(parentPath)));
      }

      // "Scan this folder" / "Open this folder" button
      const selectBtn = document.createElement('div');
      selectBtn.setAttribute('data-nav-item', '');
      selectBtn.style.cssText = 'display:flex; align-items:center; gap:10px; padding:9px 16px; cursor:pointer; transition:background 0.1s; font-size:13px; background:rgba(var(--accent-rgb),0.1); border-bottom:1px solid var(--ink-05); margin-bottom:2px;';
      selectBtn.innerHTML = `<span style="width:20px; text-align:center; color:var(--accent-hex);">\u2713</span><span style="color:var(--accent-soft-hex); font-weight:500;">${escapeHtml(scanLabel)}</span>`;
      selectBtn.addEventListener('click', () => onScan(data.path, contentArea, closeBrowser, navigateFolder, () => nav.refresh()));
      selectBtn.addEventListener('mouseenter', () => { selectBtn.style.background = 'rgba(var(--accent-rgb),0.25)'; });
      selectBtn.addEventListener('mouseleave', () => { selectBtn.style.background = 'rgba(var(--accent-rgb),0.1)'; });
      contentArea.appendChild(selectBtn);

      const dirs = data.entries.filter(e => e.type === 'dir');
      if (dirs.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:20px; text-align:center; color:var(--ink-30); font-size:12px;';
        empty.textContent = 'No subdirectories';
        contentArea.appendChild(empty);
      }

      for (const entry of dirs) {
        const fullPath = data.path === '/' ? `/${entry.name}` : `${data.path}/${entry.name}`;
        contentArea.appendChild(createFolderItem(entry.name, () => navigateFolder(fullPath)));
      }

      // Refresh keyboard nav to highlight first item in new content
      nav.refresh();
    } catch (e) {
      contentArea.innerHTML = `<div style="padding:20px; text-align:center; color:#f44747; font-size:12px;">Error: ${escapeHtml(e.message)}</div>`;
    }
  }

  navigateFolder('~');
  return { closeBrowser };
}

export async function showFileBrowser(device, startPath = '~', placementPos, thenPlace = false, targetAgentId) {
  const headerHTML = `
    ${_ctx.deviceLabelHtml(device, 'font-size:11px; padding:2px 8px;')}
    <span style="color:var(--ink-70); font-size:13px; font-weight:500;">Browse Files</span>
    <button id="file-browser-new" style="margin-left:auto; background:rgba(var(--accent-rgb),0.2); border:1px solid rgba(var(--accent-rgb),0.3); color:var(--ink-70); font-size:12px; cursor:pointer; padding:4px 10px; border-radius:6px; transition:all 0.15s;">+ New File</button>`;
  const { overlay, header, breadcrumbBar, contentArea, closeBrowser, addCleanup } = createBrowserOverlay('file-browser', headerHTML);

  // Attach keyboard nav to the overlay
  const nav = attachPickerKeyboardNav(overlay, { onEscape: closeBrowser });
  addCleanup(nav.cleanup);

  let currentBrowsePath = startPath;

  // New File button handler
  const newFileBtn = header.querySelector('#file-browser-new');
  newFileBtn.addEventListener('mouseenter', () => { newFileBtn.style.background = 'rgba(var(--accent-rgb),0.35)'; newFileBtn.style.color = 'var(--text-bright)'; });
  newFileBtn.addEventListener('mouseleave', () => { newFileBtn.style.background = 'rgba(var(--accent-rgb),0.2)'; newFileBtn.style.color = 'var(--ink-70)'; });
  newFileBtn.addEventListener('click', () => {
    const existing = contentArea.querySelector('.new-file-input-row');
    if (existing) { existing.querySelector('input').focus(); return; }

    const row = document.createElement('div');
    row.className = 'new-file-input-row';
    row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:8px 16px; background:rgba(var(--accent-rgb),0.1); border-bottom:1px solid rgba(var(--accent-rgb),0.2);';

    const icon = document.createElement('span');
    icon.style.cssText = 'width:20px; text-align:center; font-size:13px;';
    icon.textContent = '\u{1F4C4}';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'filename.txt';
    input.style.cssText = 'flex:1; background:rgba(var(--sink-rgb), 0.3); border:1px solid rgba(var(--accent-rgb),0.4); border-radius:4px; color:var(--text-bright); padding:5px 8px; font-size:12px; font-family:inherit; outline:none;';
    input.addEventListener('focus', () => { input.style.borderColor = 'rgba(var(--accent-rgb),0.7)'; });
    input.addEventListener('blur', () => { input.style.borderColor = 'rgba(var(--accent-rgb),0.4)'; });

    const createBtn = document.createElement('button');
    createBtn.textContent = 'Create';
    createBtn.style.cssText = 'background:rgba(var(--accent-rgb),0.4); border:none; color:var(--text-bright); font-size:11px; padding:5px 12px; border-radius:4px; cursor:pointer; transition:background 0.15s;';
    createBtn.addEventListener('mouseenter', () => { createBtn.style.background = 'rgba(var(--accent-rgb),0.6)'; });
    createBtn.addEventListener('mouseleave', () => { createBtn.style.background = 'rgba(var(--accent-rgb),0.4)'; });

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '\u00D7';
    cancelBtn.style.cssText = 'background:none; border:none; color:var(--ink-40); font-size:16px; cursor:pointer; padding:2px 6px;';
    cancelBtn.addEventListener('click', () => row.remove());

    async function doCreate() {
      const fileName = input.value.trim();
      if (!fileName) return;
      if (fileName.includes('/') || fileName.includes('\\')) {
        input.style.borderColor = '#f44747';
        return;
      }
      createBtn.textContent = '...';
      createBtn.disabled = true;
      const fullPath = currentBrowsePath === '/' ? `/${fileName}` : `${currentBrowsePath}/${fileName}`;
      try {
        await agentRequest('POST', '/api/files/create', { path: fullPath, device }, targetAgentId);
        closeBrowser();
        if (thenPlace) {
          _ctx.enterPlacementMode('file', (pos) => createFilePaneFromRemote(device, fullPath, pos, targetAgentId));
        } else {
          createFilePaneFromRemote(device, fullPath, placementPos, targetAgentId);
        }
      } catch (e) {
        createBtn.textContent = 'Create';
        createBtn.disabled = false;
        input.style.borderColor = '#f44747';
        console.error('[App] Failed to create file:', e);
      }
    }

    createBtn.addEventListener('click', doCreate);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doCreate();
      if (e.key === 'Escape') row.remove();
    });

    row.appendChild(icon);
    row.appendChild(input);
    row.appendChild(createBtn);
    row.appendChild(cancelBtn);
    contentArea.insertBefore(row, contentArea.firstChild);
    setTimeout(() => input.focus(), 0);
  });

  async function navigateTo(path) {
    contentArea.innerHTML = '<div style="padding:40px; text-align:center; color:var(--ink-40); font-size:13px;">Loading...</div>';

    try {
      const data = await agentRequest('GET', `/api/files/browse?path=${encodeURIComponent(path)}&device=${encodeURIComponent(device)}`, null, targetAgentId);
      currentBrowsePath = data.path;
      renderBreadcrumb(breadcrumbBar, data.path, navigateTo);
      contentArea.innerHTML = '';

      if (data.path !== '/') {
        const parentPath = data.path.split('/').slice(0, -1).join('/') || '/';
        const parentItem = createBrowserItem('..', 'dir', null, () => navigateTo(parentPath));
        contentArea.appendChild(parentItem);
      }

      if (data.entries.length === 0) {
        contentArea.innerHTML = '<div style="padding:20px; text-align:center; color:var(--ink-30); font-size:12px;">Empty directory</div>';
        nav.refresh();
        return;
      }

      for (const entry of data.entries) {
        const fullPath = data.path === '/' ? `/${entry.name}` : `${data.path}/${entry.name}`;
        const item = createBrowserItem(entry.name, entry.type, entry.size, () => {
          if (entry.type === 'dir') {
            navigateTo(fullPath);
          } else {
            closeBrowser();
            if (thenPlace) {
              _ctx.enterPlacementMode('file', (pos) => createFilePaneFromRemote(device, fullPath, pos, targetAgentId));
            } else {
              createFilePaneFromRemote(device, fullPath, placementPos, targetAgentId);
            }
          }
        });
        contentArea.appendChild(item);
      }

      // Refresh keyboard nav to highlight first item in new content
      nav.refresh();
    } catch (e) {
      contentArea.innerHTML = `<div style="padding:20px; text-align:center; color:#f44747; font-size:12px;">Error: ${escapeHtml(e.message)}</div>`;
    }
  }

  function createBrowserItem(name, type, size, onClick) {
    const item = document.createElement('div');
    item.setAttribute('data-nav-item', '');
    item.style.cssText = 'display:flex; align-items:center; gap:10px; padding:7px 16px; cursor:pointer; transition:background 0.1s; font-size:13px;';
    const icon = name === '..' ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>' : type === 'dir' ? '\u{1F4C1}' : '\u{1F4C4}';
    const sizeStr = type === 'file' && size !== null ? `<span style="color:var(--ink-30); font-size:11px; margin-left:auto;">${formatBytes(size)}</span>` : '';
    item.innerHTML = `<span style="width:20px; text-align:center;">${icon}</span><span style="color:var(--ink-85); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(name)}</span>${sizeStr}`;
    item.addEventListener('click', onClick);
    item.addEventListener('mouseenter', () => { item.style.background = 'rgba(var(--accent-rgb),0.15)'; });
    item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
    return item;
  }

  navigateTo(startPath);
}

// Create a file pane from a remote (or local) device + path
export async function createFilePaneFromRemote(device, filePath, placementPos, targetAgentId) {
  const resolvedAgentId = targetAgentId || _ctx.getActiveAgentId();

  const position = calcPlacementPos(placementPos, 300, 200);

  try {
    const filePane = await agentRequest('POST', '/api/file-panes', {
      filePath,
      device,
      position,
      size: PANE_DEFAULTS['file']
    }, resolvedAgentId);

    const pane = {
      id: filePane.id,
      type: 'file',
      x: filePane.position.x,
      y: filePane.position.y,
      width: filePane.size.width,
      height: filePane.size.height,
      zIndex: _ctx.state.nextZIndex++,
      fileName: filePane.fileName,
      filePath: filePane.filePath,
      content: filePane.content,
      device: filePane.device || device,
      agentId: resolvedAgentId
    };

    _ctx.state.panes.push(pane); _ctx.telemetry.trackPaneOpen(pane);
    _ctx.renderFilePane(pane);
    _ctx.cloudSaveLayout(pane);
    _ctx.saveRecentContext('file', pane.filePath, pane.fileName, resolvedAgentId);

  } catch (e) {
    console.error('[App] Failed to create file pane:', e);
    alert('Failed to open file: ' + e.message);
  }
}



// Create a new sticky note pane
export async function createNotePane(placementPos, initialContent, initialImages) {

  const position = calcPlacementPos(placementPos, PANE_DEFAULTS['note'].width / 2, PANE_DEFAULTS['note'].height / 2);

  try {
    const notePane = await agentRequest('POST', '/api/notes', { position, size: PANE_DEFAULTS['note'] });

    const pane = {
      id: notePane.id,
      type: 'note',
      x: notePane.position.x,
      y: notePane.position.y,
      width: notePane.size?.width || 600,
      height: notePane.size?.height || 400,
      zIndex: _ctx.state.nextZIndex++,
      content: initialContent || notePane.content || '',
      images: initialImages || notePane.images || [],
      fontSize: notePane.fontSize || 11,
      agentId: _ctx.getActiveAgentId()
    };

    _ctx.state.panes.push(pane); _ctx.telemetry.trackPaneOpen(pane);
    renderNotePane(pane);
    _ctx.cloudSaveLayout(pane);

    // If initial content or images provided, save immediately and focus the note
    if (initialContent || (initialImages && initialImages.length > 0)) {
      agentRequest('PATCH', `/api/notes/${pane.id}`, { content: initialContent || '', images: pane.images }, pane.agentId)
        .catch(e => console.error('Failed to save initial note content:', e));
      _ctx.cloudSaveNote(pane.id, initialContent || '', pane.fontSize, pane.images);
    }

    // Focus the new note pane
    _ctx.focusPane(pane);
    const noteInfo = _ctx.noteEditors.get(pane.id);
    // The .note-editor fallback that used to sit here queried an element notes
    // have not rendered since they moved to Monaco, so it never ran.
    if (noteInfo?.monacoEditor) {
      noteInfo.monacoEditor.focus();
    }

    return pane;

  } catch (e) {
    console.error('[App] Failed to create note pane:', e);
    alert('Failed to create note pane: ' + e.message);
  }
}

// Show device picker then git repo picker
export async function showGitRepoPickerWithDevice(placementPos) {
  showDevicePickerGeneric(
    (d) => showGitRepoPicker(d.name, placementPos, false, d.ip),
    () => showGitRepoPicker(undefined, placementPos)
  );
}

// Show folder browser then repo picker for git graph pane
export async function showGitRepoPicker(device, placementPos, thenPlace = false, targetAgentId) {
  const deviceLabel = device ? _ctx.deviceLabelHtml(device, 'font-size:11px; padding:2px 8px;') : '';
  const headerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" style="color:var(--ink-60);">${ICON_GIT_GRAPH}</svg>
    ${deviceLabel}
    <span style="color:var(--ink-70); font-size:13px; font-weight:500;">Choose Folder</span>`;

  let masterOnly = true;

  showFolderScanPicker({
    id: 'git-repo-browser',
    headerHTML,
    scanLabel: 'Scan this folder for repos',
    device,
    targetAgentId,
    onScan: async (folderPath, contentArea, closeBrowser, navigateFolder, navRefresh) => {
      // Set up progressive UI immediately
      contentArea.innerHTML = '';
      const allRepos = [];
      let scanDone = false;

      // Toggle bar (back + master/main filter)
      const toggleBar = document.createElement('div');
      toggleBar.style.cssText = 'display:flex; align-items:center; gap:10px; padding:8px 16px; border-bottom:1px solid var(--ink-06); flex-shrink:0;';

      const backBtn = document.createElement('button');
      backBtn.setAttribute('data-nav-item', '');
      backBtn.style.cssText = 'background:none; border:none; color:var(--ink-50); cursor:pointer; font-size:12px; padding:2px 6px; border-radius:3px;';
      backBtn.textContent = '\u2190 Back';
      backBtn.addEventListener('click', () => navigateFolder(folderPath));
      backBtn.addEventListener('mouseenter', () => { backBtn.style.color = 'var(--text-bright)'; });
      backBtn.addEventListener('mouseleave', () => { backBtn.style.color = 'var(--ink-50)'; });
      toggleBar.appendChild(backBtn);

      const scanStatus = document.createElement('span');
      scanStatus.style.cssText = 'font-size:11px; color:var(--ink-30); margin-left:4px;';
      scanStatus.textContent = 'Scanning...';
      toggleBar.appendChild(scanStatus);

      const spacer = document.createElement('div');
      spacer.style.cssText = 'flex:1;';
      toggleBar.appendChild(spacer);

      const toggleWrap = document.createElement('label');
      toggleWrap.style.cssText = 'display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none;';

      const toggleTrack = document.createElement('div');
      toggleTrack.style.cssText = `width:32px; height:18px; border-radius:9px; position:relative; transition:background 0.2s; ${masterOnly ? 'background:var(--ink-15);' : 'background:rgba(var(--accent-rgb),0.6);'}`;

      const toggleThumb = document.createElement('div');
      toggleThumb.style.cssText = `width:14px; height:14px; border-radius:50%; background:var(--text-bright); position:absolute; top:2px; transition:left 0.2s; ${masterOnly ? 'left:2px;' : 'left:16px;'}`;
      toggleTrack.appendChild(toggleThumb);

      const toggleLabel = document.createElement('span');
      toggleLabel.style.cssText = 'font-size:11px; color:var(--ink-50);';
      toggleLabel.textContent = masterOnly ? 'master/main only' : 'all branches';

      toggleWrap.appendChild(toggleTrack);
      toggleWrap.appendChild(toggleLabel);
      toggleWrap.addEventListener('click', (e) => {
        e.preventDefault();
        masterOnly = !masterOnly;
        toggleTrack.style.background = masterOnly ? 'var(--ink-15)' : 'rgba(var(--accent-rgb),0.6)';
        toggleThumb.style.left = masterOnly ? '2px' : '16px';
        toggleLabel.textContent = masterOnly ? 'master/main only' : 'all branches';
        rebuildRepoList();
      });
      toggleBar.appendChild(toggleWrap);
      contentArea.appendChild(toggleBar);

      const repoListEl = document.createElement('div');
      repoListEl.style.cssText = 'overflow-y:auto; flex:1;';
      contentArea.appendChild(repoListEl);

      function makeRepoItem(repo) {
        const item = document.createElement('div');
        item.setAttribute('data-nav-item', '');
        item.style.cssText = 'display:flex; align-items:center; gap:10px; padding:9px 16px; cursor:pointer; transition:background 0.1s; font-size:13px;';
        const branchColor = (repo.branch === 'master' || repo.branch === 'main') ? 'var(--status-ok)' : '#b392f0';
        item.innerHTML = `
          <span style="color:#f97583; font-size:14px;">&#9679;</span>
          <span style="flex:1; overflow:hidden;">
            <strong style="color:var(--ink-90);">${escapeHtml(repo.name)}</strong><br>
            <span style="opacity:0.4; font-size:11px;">${escapeHtml(repo.path)}</span>
          </span>
          <span style="color:${branchColor}; font-size:11px; white-space:nowrap;">${escapeHtml(repo.branch)}</span>
        `;
        item.addEventListener('click', () => {
          closeBrowser();
          if (thenPlace) {
            _ctx.enterPlacementMode('git-graph', (pos) => createGitGraphPane(repo.path, device, pos, targetAgentId));
          } else {
            createGitGraphPane(repo.path, device, placementPos, targetAgentId);
          }
        });
        item.addEventListener('mouseenter', () => { item.style.background = 'rgba(var(--accent-rgb),0.15)'; });
        item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
        return item;
      }

      function shouldShow(repo) {
        return !masterOnly || repo.branch === 'master' || repo.branch === 'main';
      }

      function rebuildRepoList() {
        repoListEl.innerHTML = '';
        const filtered = allRepos.filter(shouldShow);
        if (filtered.length === 0 && scanDone) {
          const empty = document.createElement('div');
          empty.style.cssText = 'padding:20px; text-align:center; color:var(--ink-30); font-size:12px;';
          empty.textContent = masterOnly ? 'No repos on master/main in this folder' : 'No git repos found in this folder';
          repoListEl.appendChild(empty);
        }
        for (const repo of filtered) repoListEl.appendChild(makeRepoItem(repo));
        if (navRefresh) navRefresh();
      }

      function appendRepo(repo) {
        scanStatus.textContent = `Scanning... (${allRepos.length} found)`;
        if (shouldShow(repo)) {
          repoListEl.appendChild(makeRepoItem(repo));
          if (navRefresh) navRefresh();
        }
      }

      try {
        const deviceParam = device ? `&device=${encodeURIComponent(device)}` : '';
        const finalRepos = await agentRequest('GET', `/api/git-repos/in-folder?path=${encodeURIComponent(folderPath)}${deviceParam}`, null, targetAgentId, {
          onPartial: (repos) => {
            for (const repo of repos) {
              allRepos.push(repo);
              appendRepo(repo);
            }
          }
        });
        scanDone = true;
        // Use final complete list (authoritative) and rebuild
        allRepos.length = 0;
        allRepos.push(...finalRepos);
        scanStatus.textContent = `${allRepos.length} repos`;
        rebuildRepoList();
      } catch (e) {
        contentArea.innerHTML = `<div style="padding:20px; text-align:center; color:#f44747; font-size:12px;">Error: ${escapeHtml(e.message)}</div>`;
      }
    }
  });
}

// Create a new iframe pane
export async function createIframePane(placementPos) {
  let url = prompt('Enter URL to embed:');
  if (!url || !url.trim()) return;
  url = url.trim();

  // Auto-add protocol if missing
  if (!/^https?:\/\//i.test(url)) {
    url = 'http://' + url;
  }

  try {
    new URL(url);
  } catch {
    alert('Invalid URL format');
    return;
  }


  const position = calcPlacementPos(placementPos, 400, 300);

  try {
    const iframeData = await agentRequest('POST', '/api/iframes', { url, position, size: PANE_DEFAULTS['iframe'] });

    const pane = {
      id: iframeData.id,
      type: 'iframe',
      x: iframeData.position.x,
      y: iframeData.position.y,
      width: iframeData.size.width,
      height: iframeData.size.height,
      zIndex: _ctx.state.nextZIndex++,
      url: iframeData.url,
      agentId: _ctx.getActiveAgentId()
    };

    _ctx.state.panes.push(pane); _ctx.telemetry.trackPaneOpen(pane);
    renderIframePane(pane);
    _ctx.cloudSaveLayout(pane);
    try { _ctx.saveRecentContext('iframe', pane.url, new URL(pane.url).hostname); } catch (_) { _ctx.saveRecentContext('iframe', pane.url, pane.url); }
  } catch (e) {
    console.error('[App] Failed to create iframe pane:', e);
    alert('Failed to create iframe: ' + e.message);
  }
}

// Create iframe pane with a pre-known URL (skips prompt)
export async function createIframePaneWithUrl(url, placementPos) {
  const position = calcPlacementPos(placementPos, 400, 300);
  try {
    const iframeData = await agentRequest('POST', '/api/iframes', { url, position, size: PANE_DEFAULTS['iframe'] });
    const pane = {
      id: iframeData.id,
      type: 'iframe',
      x: iframeData.position.x,
      y: iframeData.position.y,
      width: iframeData.size.width,
      height: iframeData.size.height,
      zIndex: _ctx.state.nextZIndex++,
      url: iframeData.url,
      agentId: _ctx.getActiveAgentId()
    };
    _ctx.state.panes.push(pane); _ctx.telemetry.trackPaneOpen(pane);
    renderIframePane(pane);
    _ctx.cloudSaveLayout(pane);
    try { _ctx.saveRecentContext('iframe', pane.url, new URL(pane.url).hostname); } catch (_) { _ctx.saveRecentContext('iframe', pane.url, pane.url); }
  } catch (e) {
    console.error('[App] Failed to create iframe pane:', e);
    alert('Failed to create iframe: ' + e.message);
  }
}

export async function createGitGraphPane(repoPath, device, placementPos, targetAgentId) {
  const resolvedAgentId = targetAgentId || _ctx.getActiveAgentId();

  const position = calcPlacementPos(placementPos, 250, 225);

  try {
    const reqBody = { repoPath, position, size: PANE_DEFAULTS['git-graph'] };
    if (device) reqBody.device = device;
    const ggPane = await agentRequest('POST', '/api/git-graphs', reqBody, resolvedAgentId);

    const pane = {
      id: ggPane.id,
      type: 'git-graph',
      x: ggPane.position.x,
      y: ggPane.position.y,
      width: ggPane.size.width,
      height: ggPane.size.height,
      zIndex: _ctx.state.nextZIndex++,
      repoPath: ggPane.repoPath,
      repoName: ggPane.repoName,
      device: device || ggPane.device,
      agentId: resolvedAgentId
    };

    _ctx.state.panes.push(pane); _ctx.telemetry.trackPaneOpen(pane);
    renderGitGraphPane(pane);
    _ctx.cloudSaveLayout(pane);
    _ctx.saveRecentContext('git-graph', pane.repoPath, pane.repoName, resolvedAgentId);

  } catch (e) {
    console.error('[App] Failed to create git graph pane:', e);
    alert('Failed to create git graph pane: ' + e.message);
  }
}

// renderGitGraphPane, setupGitGraphListeners, assignLanes, gitRelativeTime,
// renderSvgGitGraph, fetchGitGraphData — imported from modules/git-graph.js

  // Delete a pane (terminal or file)
export async function deletePane(paneId) {

  // Remove from broadcast selection if present
  if (_ctx.selectedPaneIds.delete(paneId)) {
    _ctx.updateBroadcastIndicator();
  }

  // If this pane is expanded, collapse it first
  if (_ctx.getExpandedPaneId() === paneId) {
    collapsePane();
  }

  try {
    const pane = _ctx.state.panes.find(p => p.id === paneId);
    const paneType = pane?.type || 'terminal';
    _ctx.telemetry.trackPaneClose(paneId, paneType);

    if (paneType === 'terminal') {
      // Close terminal via WebSocket
      sendWs('terminal:close', { terminalId: paneId }, _ctx.getPaneAgentId(paneId));

      // Clean up xterm instance
      const termInfo = _ctx.terminals.get(paneId);
      if (termInfo) {
        termInfo.xterm.dispose();
        _ctx.terminals.delete(paneId);
        _ctx.termDeferredBuffers.delete(paneId);
      }
      // Claude state and notification records are keyed by terminal id and are
      // otherwise only pruned on a state transition, which a closed terminal
      // never produces again.
      _ctx.claudeTerminalIds.delete(paneId);
      clearTerminalNotificationState(paneId);
    } else if (paneType === 'file') {
      // Check for unsaved changes
      const editorInfo = _ctx.fileEditors.get(paneId);
      if (editorInfo?.hasChanges) {
        if (!confirm('You have unsaved changes. Close anyway?')) {
          return;
        }
      }
      // Stop auto-refresh and label update
      if (editorInfo?.refreshInterval) {
        clearInterval(editorInfo.refreshInterval);
      }
      if (editorInfo?.labelInterval) {
        clearInterval(editorInfo.labelInterval);
      }
      // Dispose Monaco editor and ResizeObserver
      if (editorInfo?.monacoEditor) {
        editorInfo.monacoEditor.dispose();
      }
      if (editorInfo?.resizeObserver) {
        editorInfo.resizeObserver.disconnect();
      }
      _ctx.fileEditors.delete(paneId);
      _ctx.fileHandles.delete(paneId); // Clean up file handle

      // Delete from server (best-effort — agent may be offline)
      agentRequest('DELETE', `/api/file-panes/${paneId}`, null, pane?.agentId).catch(() => {});
    } else if (paneType === 'note') {
      // Dispose Monaco editor if this is a note pane
      const noteInfo = _ctx.noteEditors.get(paneId);
      if (noteInfo) {
        if (noteInfo.monacoEditor) noteInfo.monacoEditor.dispose();
        if (noteInfo.resizeObserver) noteInfo.resizeObserver.disconnect();
        _ctx.noteEditors.delete(paneId);
      }
      // Delete from server (best-effort — agent may be offline)
      agentRequest('DELETE', `/api/notes/${paneId}`, null, pane?.agentId).catch(() => {});
    } else if (paneType === 'git-graph') {
      // Stop auto-refresh
      const ggInfo = _ctx.gitGraphPanes.get(paneId);
      if (ggInfo?.refreshInterval) {
        clearInterval(ggInfo.refreshInterval);
      }
      _ctx.gitGraphPanes.delete(paneId);
      // Delete from server (best-effort — agent may be offline)
      agentRequest('DELETE', `/api/git-graphs/${paneId}`, null, pane?.agentId).catch(() => {});
    } else if (paneType === 'iframe') {
      agentRequest('DELETE', `/api/iframes/${paneId}`, null, pane?.agentId).catch(() => {});
    } else if (paneType === 'beads') {
      // Stop auto-refresh
      const bInfo = _ctx.beadsPanes.get(paneId);
      if (bInfo?.refreshInterval) {
        clearInterval(bInfo.refreshInterval);
      }
      _ctx.beadsPanes.delete(paneId);
      agentRequest('DELETE', `/api/beads-panes/${paneId}`, null, pane?.agentId).catch(() => {});
    } else if (paneType === 'folder') {
      const fpInfo = _ctx.folderPanes.get(paneId);
      if (fpInfo?.refreshInterval) clearInterval(fpInfo.refreshInterval);
      _ctx.folderPanes.delete(paneId);
      agentRequest('DELETE', `/api/folder-panes/${paneId}`, null, pane?.agentId).catch(() => {});
    } else if (paneType === 'conversations') {
      agentRequest('DELETE', `/api/conversations-panes/${paneId}`, null, pane?.agentId).catch(() => {});
    } else if (paneType === 'checkpoint') {
      // Checkpoint panes are local-only, just remove from state
    }

    // Remove from state
    const index = _ctx.state.panes.findIndex(p => p.id === paneId);
    if (index !== -1) {
      _ctx.state.panes.splice(index, 1);
    }

    // Remove from DOM
    const paneEl = document.getElementById(`pane-${paneId}`);
    if (paneEl) {
      paneEl.remove();
    }
    if (_ctx.getLastFocusedPaneId() === paneId) _ctx.setLastFocusedPaneId(null);

    // Remove from cloud layout
    _ctx.cloudDeleteLayout(paneId);

    // List view is built from state.panes, so a removal has to show at once
    // rather than waiting for the next refresh tick.
    refreshPaneListIfVisible();

  } catch (e) {
    console.error('[App] Error deleting pane:', e);
  }
}

