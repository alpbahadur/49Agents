import { Terminal } from './lib/xterm.mjs';
import { FitAddon } from './lib/addon-fit.mjs';
import { WebLinksAddon } from './lib/addon-web-links.mjs';
import { playDismissSound, playNotificationSound, setSoundEnabled as _setSoundEnabled } from './modules/sounds.js';
import { escapeHtml, formatBytes, metricColorClass, formatLocationPath, isExternalInputFocused, truncateUrl, isAgentVersionOutdated, getTerminalFontFamily } from './modules/utils.js';
import { APP_VERSION, PANE_DEFAULTS, PANE_ENDPOINT_MAP, ICON_BEADS, ICON_GIT_GRAPH, ICON_FOLDER, ICON_CONVERSATIONS, CLAUDE_STATE_SVGS, CLAUDE_LOGO_SVG, RESET_ICON_SVG, WIFI_OFF_SVG, DEVICE_COLORS, TERMINAL_FONTS, CANVAS_BACKGROUNDS, osIcon } from './modules/constants.js';
import { initMinimap, startMinimapLoop, hideMinimap, renderMinimap, getCanvasBounds, calcPlacementPos, setMinimapEnabled, getMinimapEnabled } from './modules/minimap.js';
import { initNotificationDeps, initNotifications, showPromoToasts, showToast, dismissToast, snoozeNotification, sendBrowserNotification, updateTabTitleBadge, handleStateTransition, previousClaudeStates, notifiedStates, activeToasts, snoozedNotifications, snoozeCount, getIsFirstClaudeStateUpdate, setIsFirstClaudeStateUpdate, getNotificationContainer, showAdminToast, dismissAdminToast } from './modules/notifications.js';
import { initGitGraphDeps, renderGitGraphPane, fetchGitGraphData } from './modules/git-graph.js';

// 49Agents - Mobile-first terminal pane management
(function() {
  'use strict';

  // ============================================================================
  // SECTION 1: STATE & CONSTANTS                                    [Lines ~15-77]
  // All module-scope state: pane maps, mode flags, UI settings, etc.
  // ============================================================================

  // Map of note pane ID -> { monacoEditor, resizeObserver }
  const noteEditors = new Map();

  const RESIZE_HOLD_DURATION = 150;
  const SNAP_THRESHOLD = 38; // px in canvas space
  const SNAP_GAP = 10; // px gap between snapped panes

  // PANE_DEFAULTS — imported from modules/constants.js

  let state = {
    panes: [],        // Panes can be type: 'terminal' or 'file'
    zoom: 1,
    panX: 0,
    panY: 0,
    nextZIndex: 1,
    projects: [],     // { id, name, color, x, y, width, height, shortcutNumber }
  };

  // File editors map (paneId -> { originalContent, hasChanges, fileHandle })
  const fileEditors = new Map();

  // === Placement Mode State ===
  let placementMode = null; // { type: 'terminal'|'file'|'note'|'git-graph', cursorEl: HTMLElement }

  // Git graph panes map (paneId -> { refreshInterval })
  const gitGraphPanes = new Map();

  // Beads panes map (paneId -> { refreshInterval })
  const beadsPanes = new Map();

  // Folder panes map (paneId -> { refreshInterval })
  const folderPanes = new Map();

  // Tab groups: panes sharing a tabGroupId appear as tabs in one window.
  // Only the active tab's DOM element is visible; siblings are display:none.
  let nextTabGroupId = 1;

  // Notification state — imported from modules/notifications.js
  // (previousClaudeStates, notifiedStates, activeToasts, snoozedNotifications, snoozeCount)
  // Sound state — imported from modules/sounds.js
  let snoozeDurationMs = 90 * 1000;
  let notificationSoundEnabled = true;
  let autoRemoveDoneNotifs = false;
  let focusMode = 'hover'; // 'hover' (default) or 'click' — how mouse selects panes
  let tabHeld = false; // Track Tab key state globally (used for Tab+scroll canvas pan, Tab+key chords)
  let tutorialsCompleted = {};
  let projectsSidebarVisible = false; // Tab+P toggles projects sidebar
  let projectsSidebarPosition = 'right'; // 'left' or 'right'
  let teleportAnimation = true; // false = instant teleport

  // ---------------------------------------------------------------------------
  // Client-side telemetry tracker (local mode only, respects consent)
  // ---------------------------------------------------------------------------
  const _telemetry = {
    _active: false,
    _queue: [],
    _sessionStart: Date.now(),
    _activeMs: 0,
    _lastVisible: Date.now(),
    _terminalInputCount: 0,
    _panePeakCounts: {},
    _paneOpenTimes: {},

    init() {
      fetch('/api/auth/mode').then(r => r.json()).then(m => {
        window.__tcAuthMode = m.mode;
        if (m.mode !== 'local') return;
        return fetch('/api/auth/telemetry-consent', { credentials: 'include' }).then(r => r.json());
      }).then(d => {
        if (!d || !d.consent) return;
        this._active = true;
        this._setupVisibility();
        this.track('session.start', {
          screen_width: screen.width,
          screen_height: screen.height,
          viewport_width: window.innerWidth,
          viewport_height: window.innerHeight,
          is_mobile: /Mobi|Android/i.test(navigator.userAgent),
        });
        setInterval(() => this.flush(), 30000);
      }).catch(() => {});
    },

    track(type, data) {
      if (!this._active) return;
      this._queue.push({
        event_type: type,
        data: data || {},
        ts: new Date().toISOString(),
        sid: sessionStorage.getItem('_49a_sid'),
      });
      if (this._queue.length >= 20) this.flush();
    },

    flush() {
      if (!this._active || this._queue.length === 0) return;
      const batch = this._queue.splice(0);
      const body = JSON.stringify({ events: batch });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/telemetry/client-events', new Blob([body], { type: 'application/json' }));
      } else {
        fetch('/api/telemetry/client-events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
      }
    },

    _setupVisibility() {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this._activeMs += Date.now() - this._lastVisible;
          this._trackSessionEnd();
          this.flush();
        } else {
          this._lastVisible = Date.now();
        }
      });
      window.addEventListener('beforeunload', () => {
        this._trackSessionEnd();
        this.flush();
      });
    },

    _trackSessionEnd() {
      const now = Date.now();
      const totalActive = this._activeMs + (document.visibilityState === 'visible' ? now - this._lastVisible : 0);
      this.track('session.end', {
        duration_ms: now - this._sessionStart,
        active_ms: totalActive,
        idle_ms: (now - this._sessionStart) - totalActive,
        pane_counts: this._panePeakCounts,
        terminal_commands_sent: this._terminalInputCount,
      });
    },

    trackPaneOpen(pane) {
      const type = pane.type || 'terminal';
      this.track('pane.open', { pane_type: type });
      this._paneOpenTimes[pane.id] = Date.now();
      const current = state.panes.filter(p => (p.type || 'terminal') === type).length;
      this._panePeakCounts[type] = Math.max(this._panePeakCounts[type] || 0, current);
    },

    trackPaneClose(paneId, paneType) {
      const openTime = this._paneOpenTimes[paneId];
      this.track('pane.close', {
        pane_type: paneType,
        duration_ms: openTime ? Date.now() - openTime : null,
      });
      delete this._paneOpenTimes[paneId];
    },
  };

  // Expanded pane state
  let expandedPaneId = null;

  // Quick View state
  let quickViewActive = false;
  let deviceHoverActive = false;

  // Mention Mode state
  let mentionModeActive = false;
  let mentionStage = 0; // 0 = inactive, 1 = pick source, 2 = pick target
  let mentionPayload = null; // { type: 'file'|'iframe'|'beads', text: string, sourceAgentId: string }

  // Last focused pane tracking (for auto-refocus on keypress)
  let lastFocusedPaneId = null;

  // Move Mode state (WASD pane navigation)
  let moveModeActive = false;
  let moveModePaneId = null;   // pane currently highlighted in move mode
  let lastTabUpTime = 0;       // timestamp for double-tap Tab detection
  let moveModeOriginalZoom = 1;  // zoom before entering move mode (for Esc restore)

  // ============================================================================
  // SECTION 2: SHORTCUT & NAVIGATION HELPERS                       [Lines ~79-199]
  // Tab+1-9 quick-jump, shortcut badges, shortcut assign popup
  // ============================================================================

  // Shortcut number helpers (Tab+1..9 quick-jump)
  function getNextShortcutNumber() {
    const used = new Set([
      ...state.panes.map(p => p.shortcutNumber).filter(Boolean),
      ...state.projects.map(p => p.shortcutNumber).filter(Boolean),
    ]);
    for (let n = 1; n <= 9; n++) {
      if (!used.has(n)) return n;
    }
    return null; // all 1-9 taken
  }

  function shortcutBadgeHtml(paneData) {
    const num = paneData.shortcutNumber;
    if (!num) return '';
    return `<span class="pane-shortcut-badge" data-tooltip="Tab+${num} to jump here (click to reassign)">${num}</span>`;
  }

  function paneNameHtml(paneData) {
    const name = paneData.paneName || '';
    const display = name ? escapeHtml(name) : 'Name';
    const cls = name ? 'pane-name' : 'pane-name empty';
    return `<span class="${cls}">${display}</span>`;
  }

  function jumpToPane(paneData) {
    // Same zoom/center behavior as move mode confirm
    const targetZoom = calcMoveModeZoom(paneData);
    state.zoom = targetZoom;
    const paneCenterX = paneData.x + paneData.width / 2;
    const paneCenterY = paneData.y + paneData.height / 2;
    state.panX = window.innerWidth / 2 - paneCenterX * state.zoom;
    state.panY = window.innerHeight / 2 - paneCenterY * state.zoom;

    canvas.style.transition = 'transform 100ms ease';
    updateCanvasTransform();
    setTimeout(() => { canvas.style.transition = ''; }, 120);

    focusPane(paneData);
    setTimeout(() => { focusTerminalInput(paneData.id); }, 50);
    saveViewState();
  }

  function reassignShortcutNumber(paneData, newNum) {
    // Swap if another pane or project has this number
    const existingPane = state.panes.find(p => p.shortcutNumber === newNum && p.id !== paneData.id);
    if (existingPane) {
      existingPane.shortcutNumber = paneData.shortcutNumber || null;
      updateShortcutBadge(existingPane);
      cloudSaveLayout(existingPane);
    }
    const existingProject = state.projects.find(p => p.shortcutNumber === newNum && p.id !== paneData.id);
    if (existingProject) {
      existingProject.shortcutNumber = paneData.shortcutNumber || null;
      saveProjectsToCloud();
      renderProjectsSidebar();
    }
    paneData.shortcutNumber = newNum;
    // Determine what type of thing this is and save accordingly
    if (state.projects.includes(paneData)) {
      saveProjectsToCloud();
      renderProjectsSidebar();
    } else {
      updateShortcutBadge(paneData);
      cloudSaveLayout(paneData);
    }
  }

  function updateShortcutBadge(paneData) {
    const paneEl = document.getElementById(`pane-${paneData.id}`);
    if (!paneEl) return;

    // Checkpoint pane badge
    const ckptBadge = paneEl.querySelector('.checkpoint-pane-badge');
    if (ckptBadge) {
      ckptBadge.textContent = paneData.shortcutNumber ? `Tab+${paneData.shortcutNumber}` : 'Tab+?';
      return;
    }

    // Regular pane badge
    paneEl.querySelectorAll('.pane-shortcut-badge').forEach(el => el.remove());
    if (paneData.shortcutNumber) {
      const headerRight = paneEl.querySelector('.pane-header-right');
      if (headerRight) {
        const badge = document.createElement('span');
        badge.className = 'pane-shortcut-badge';
        badge.dataset.tooltip = `Tab+${paneData.shortcutNumber} (click to reassign)`;
        badge.textContent = paneData.shortcutNumber;
        headerRight.insertBefore(badge, headerRight.firstChild);
      }
    }
  }

  // Shortcut assign popup — floating overlay that captures a single keypress
  let shortcutPopup = null;
  function showShortcutAssignPopup(paneData) {
    closeShortcutAssignPopup();
    const paneEl = document.getElementById(`pane-${paneData.id}`);
    if (!paneEl) return;
    const badge = paneEl.querySelector('.pane-shortcut-badge') || paneEl.querySelector('.checkpoint-pane-badge');
    if (!badge) return;

    const rect = badge.getBoundingClientRect();
    const popup = document.createElement('div');
    popup.className = 'shortcut-assign-popup';
    popup.innerHTML = `<span class="shortcut-assign-label">Press 1-9</span>`;
    popup.style.left = `${rect.left + rect.width / 2}px`;
    popup.style.top = `${rect.bottom + 6}px`;
    document.body.appendChild(popup);

    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        closeShortcutAssignPopup();
        return;
      }
      if (e.key >= '1' && e.key <= '9') {
        reassignShortcutNumber(paneData, parseInt(e.key, 10));
        closeShortcutAssignPopup();
      }
    };
    const onClickOutside = (e) => {
      if (!popup.contains(e.target)) {
        closeShortcutAssignPopup();
      }
    };
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => document.addEventListener('mousedown', onClickOutside, true), 0);

    shortcutPopup = { popup, onKey, onClickOutside };
  }

  function closeShortcutAssignPopup() {
    if (!shortcutPopup) return;
    const { popup, onKey, onClickOutside } = shortcutPopup;
    popup.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onClickOutside, true);
    shortcutPopup = null;
  }

  // Minimap — imported from modules/minimap.js
  // PANE_ENDPOINT_MAP, ICON_*, CLAUDE_STATE_SVGS — imported from modules/constants.js



  // isExternalInputFocused — imported from modules/utils.js

  // ============================================================================
  // SECTION 3: TERMINAL OUTPUT & DEFERRED BUFFERING               [Lines ~204-334]
  // Terminal I/O, selection-safe deferred writes, diagnostic dump (Ctrl+Shift+D)
  // ============================================================================

  // File handles for native file picker (for saving back)
  const fileHandles = new Map(); // paneId -> FileSystemFileHandle

  // Save view state to cloud
  function saveViewState() {
    cloudSaveViewState();
  }

  // Terminal instances and WebSocket
  const terminals = new Map(); // paneId -> { xterm, fitAddon }
  let terminalMouseDown = false; // pause output writes while mouse is held on any terminal

  // Deferred output buffer — only used when selection is active or mouse is held
  const termDeferredBuffers = new Map(); // terminalId -> Uint8Array[]
  let deferFlushPending = false;

  function flushDeferredOutputs() {
    deferFlushPending = false;
    for (const [terminalId, chunks] of termDeferredBuffers) {
      if (chunks.length === 0) continue;
      const termInfo = terminals.get(terminalId);
      if (!termInfo) { chunks.length = 0; continue; }
      if (terminalMouseDown || termInfo.xterm.hasSelection()) {
        // Still selecting — cap at 512KB to prevent memory bloat
        const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
        if (totalLen < 524288) {
          if (!deferFlushPending) {
            deferFlushPending = true;
            requestAnimationFrame(flushDeferredOutputs);
          }
          continue;
        }
      }
      const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      chunks.length = 0;
      termInfo.xterm.write(merged);
    }
  }

  // Write terminal output immediately, unless selection is active
  function writeTermOutput(terminalId, data) {
    const termInfo = terminals.get(terminalId);
    if (!termInfo) return;

    // If selecting, defer writes to avoid clearing selection
    if (terminalMouseDown || termInfo.xterm.hasSelection()) {
      let buf = termDeferredBuffers.get(terminalId);
      if (!buf) {
        buf = [];
        termDeferredBuffers.set(terminalId, buf);
      }
      buf.push(data);
      if (!deferFlushPending) {
        deferFlushPending = true;
        requestAnimationFrame(flushDeferredOutputs);
      }
      return;
    }

    // Flush any deferred data first, then write new data
    const deferred = termDeferredBuffers.get(terminalId);
    if (deferred && deferred.length > 0) {
      const totalLen = deferred.reduce((sum, c) => sum + c.length, 0);
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of deferred) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      deferred.length = 0;
      termInfo.xterm.write(merged);
    }

    termInfo.xterm.write(data);
  }

  // Ctrl+Shift+D — dump full terminal diagnostic state to console
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      console.log('=== TERMINAL DIAGNOSTICS (Ctrl+Shift+D) ===');
      console.log(`Time: ${new Date().toISOString()}`);
      console.log(`terminalMouseDown: ${terminalMouseDown}`);
      console.log(`deferFlushPending: ${deferFlushPending}`);
      console.log(`Relay WS state: ${ws ? ['CONNECTING','OPEN','CLOSING','CLOSED'][ws.readyState] : 'null'}`);
      console.log(`Agents: ${JSON.stringify(agents.map(a => ({ id: a.agentId?.slice(0,8), online: a.online })))}`);
      console.log('--- Per-terminal state ---');
      for (const [id, termInfo] of terminals) {
        const pane = state.panes.find(p => p.id === id);
        const bufChunks = termDeferredBuffers.get(id);
        const pendingBytes = bufChunks ? bufChunks.reduce((s, c) => s + c.length, 0) : 0;
        const xterm = termInfo.xterm;
        const altScreen = xterm.buffer.active === xterm.buffer.alternate;
        const hasSel = xterm.hasSelection();
        const viewportY = xterm.buffer.active.viewportY;
        const baseY = xterm.buffer.active.baseY;
        const cursorY = xterm.buffer.active.cursorY;
        const cursorX = xterm.buffer.active.cursorX;
        const rows = xterm.rows;
        const cols = xterm.cols;
        const paneZoom = pane ? (pane.zoomLevel || 100) : 100;
        // Sample first visible line content (to see if screen is blank)
        let firstLine = '';
        try {
          const line = xterm.buffer.active.getLine(viewportY);
          if (line) firstLine = line.translateToString(true).slice(0, 60);
        } catch {}
        let lastLine = '';
        try {
          const line = xterm.buffer.active.getLine(viewportY + rows - 1);
          if (line) lastLine = line.translateToString(true).slice(0, 60);
        } catch {}
        console.log(
          `  ${id.slice(0,8)}: altScreen=${altScreen} hasSel=${hasSel} ` +
          `pending=${pendingBytes}B size=${cols}x${rows} zoom=${paneZoom}% ` +
          `cursor=${cursorX},${cursorY} viewport=${viewportY} base=${baseY} ` +
          `initialAttach=${!!termInfo._initialAttachDone} ` +
          `connected=${pane ? 'yes' : 'orphan'}`
        );
        console.log(`    firstLine: "${firstLine}"`);
        console.log(`    lastLine:  "${lastLine}"`);
      }
      console.log('=== END DIAGNOSTICS ===');
    }
  });

  // ============================================================================
  // SECTION 4: CLOUD PERSISTENCE & SYNC                           [Lines ~336-430]
  // WebSocket/agent state vars, cloudFetch, layout/view/note sync (debounced)
  // ============================================================================

  let ws = null;
  let wsReconnectTimer = null;
  let wsReconnectDelay = 2000;
  const WS_RECONNECT_MAX = 30000;
  let pendingAttachments = new Set();

  // Agent/relay state
  let agents = [];          // populated from agents:list message
  let activeAgentId = null; // currently selected agent
  const agentUpdates = new Map(); // agentId -> { currentVersion, latestVersion }

  // === Cloud-Direct Persistence (Phase 4) ===
  // These are direct fetch() calls to the cloud server, NOT relayed through agent.

  function cloudFetch(method, path, body) {
    const opts = {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
    };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
    return fetch(path, opts).then(r => r.ok ? r.json() : Promise.reject(new Error(`Cloud ${method} ${path}: ${r.status}`)));
  }

  // Cloud layout persistence (debounced per-pane, 500ms)
  const cloudLayoutTimers = new Map();
  function cloudSaveLayout(pane) {
    if (cloudLayoutTimers.has(pane.id)) clearTimeout(cloudLayoutTimers.get(pane.id));
    cloudLayoutTimers.set(pane.id, setTimeout(() => {
      cloudLayoutTimers.delete(pane.id);
      const metadata = {};
      if (pane.zoomLevel && pane.zoomLevel !== 100) metadata.zoomLevel = pane.zoomLevel;
      if (pane.textOnly) metadata.textOnly = true;
      if (pane.type === 'folder' && pane.folderPath) metadata.folderPath = pane.folderPath;
      if (pane.beadsTag) metadata.beadsTag = pane.beadsTag;
      if (pane.device) metadata.device = pane.device;
      if (pane.filePath) metadata.filePath = pane.filePath;
      if (pane.fileName) metadata.fileName = pane.fileName;
      if (pane.url) metadata.url = pane.url;
      if (pane.repoPath) metadata.repoPath = pane.repoPath;
      if (pane.repoName) metadata.repoName = pane.repoName;
      if (pane.graphMode && pane.graphMode !== 'svg') metadata.graphMode = pane.graphMode;
      if (pane.projectPath) metadata.projectPath = pane.projectPath;
      if (pane.dirPath) metadata.dirPath = pane.dirPath;
      if (pane.claudeSessionId) metadata.claudeSessionId = pane.claudeSessionId;
      if (pane.claudeSessionName) metadata.claudeSessionName = pane.claudeSessionName;
      if (pane.workingDir) metadata.workingDir = pane.workingDir;
      if (pane.shortcutNumber) metadata.shortcutNumber = pane.shortcutNumber;
      if (pane.paneName) metadata.paneName = pane.paneName;
      if (pane.checkpointName) metadata.checkpointName = pane.checkpointName;
      if (pane.tabGroupId) metadata.tabGroupId = pane.tabGroupId;
      if (pane.tabGroupActive) metadata.tabGroupActive = true;
      cloudFetch('PUT', `/api/layouts/${pane.id}`, {
        paneType: pane.type,
        positionX: pane.x,
        positionY: pane.y,
        width: pane.width,
        height: pane.height,
        zIndex: pane.zIndex || 0,
        agentId: pane.agentId || activeAgentId,
        metadata: Object.keys(metadata).length > 0 ? metadata : null
      }).catch(e => console.error('[Cloud] Layout save failed:', e.message));
    }, 500));
  }

  // Save a recent pane context to cloud (fire-and-forget)
  function saveRecentContext(paneType, context, label, agentId) {
    const resolvedAgentId = agentId || activeAgentId;
    if (!resolvedAgentId || !context) return;
    cloudFetch('POST', '/api/recent-contexts', { paneType, agentId: resolvedAgentId, context, label: label || null })
      .catch(e => console.error('[Cloud] Recent context save failed:', e.message));
  }

  // Fetch recent pane contexts from cloud
  async function fetchRecentContexts(paneType, agentId) {
    const resolvedAgentId = agentId || activeAgentId;
    if (!resolvedAgentId) return [];
    try {
      const data = await cloudFetch('GET', `/api/recent-contexts?paneType=${encodeURIComponent(paneType)}&agentId=${encodeURIComponent(resolvedAgentId)}`);
      return data.recents || [];
    } catch (e) {
      console.error('[Cloud] Recent context fetch failed:', e.message);
      return [];
    }
  }

  // Show a recents popup for a pane type. If recents exist, shows them + Browse option.
  // If no recents, calls browseFn() directly.
  // onRecent(context, label) is called when user picks a recent item.
  // browseFn() is called when user picks "Browse..." or no recents exist.
  async function showRecentsOrBrowse(paneType, agentId, onRecent, browseFn) {
    const recents = await fetchRecentContexts(paneType, agentId);
    if (!recents || recents.length === 0) {
      browseFn();
      return;
    }

    const existing = document.getElementById('recents-picker');
    if (existing) existing.remove();

    const picker = document.createElement('div');
    picker.id = 'recents-picker';
    picker.className = 'pane-menu';
    picker.style.cssText = 'min-width:220px; max-width:360px;';

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'padding:8px 14px 4px; font-size:11px; color:rgba(255,255,255,0.35); font-weight:500; text-transform:uppercase; letter-spacing:0.5px;';
    header.textContent = 'Recent';
    picker.appendChild(header);

    // Recent items
    for (const r of recents) {
      const btn = document.createElement('button');
      btn.className = 'menu-item';
      btn.setAttribute('data-nav-item', '');
      const displayLabel = escapeHtml(r.label || r.context);
      const displayPath = r.label && r.label !== r.context ? `<span style="opacity:0.4; font-size:11px; margin-left:6px;">${escapeHtml(r.context)}</span>` : '';
      btn.innerHTML = `<span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${displayLabel}${displayPath}</span>`;
      btn.addEventListener('click', () => {
        nav.cleanup();
        document.removeEventListener('click', closeHandler);
        picker.remove();
        onRecent(r.context, r.label);
      });
      btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,0.1)'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
      picker.appendChild(btn);
    }

    // Divider
    const divider = document.createElement('div');
    divider.style.cssText = 'height:1px; background:rgba(255,255,255,0.08); margin:4px 8px;';
    picker.appendChild(divider);

    // Browse button
    const browseBtn = document.createElement('button');
    browseBtn.className = 'menu-item';
    browseBtn.setAttribute('data-nav-item', '');
    browseBtn.innerHTML = '<span style="opacity:0.6;">Browse...</span>';
    browseBtn.addEventListener('click', () => {
      nav.cleanup();
      document.removeEventListener('click', closeHandler);
      picker.remove();
      browseFn();
    });
    browseBtn.addEventListener('mouseenter', () => { browseBtn.style.background = 'rgba(255,255,255,0.1)'; });
    browseBtn.addEventListener('mouseleave', () => { browseBtn.style.background = 'none'; });
    picker.appendChild(browseBtn);

    // Position near the add button
    const addBtn = document.getElementById('add-pane-btn');
    if (addBtn) {
      const rect = addBtn.getBoundingClientRect();
      picker.style.top = (rect.bottom + 8) + 'px';
      picker.style.right = '16px';
    }

    document.body.appendChild(picker);

    const nav = attachPickerKeyboardNav(picker, {
      onEscape: () => {
        document.removeEventListener('click', closeHandler);
        picker.remove();
      }
    });

    const closeHandler = (e) => {
      if (!picker.contains(e.target)) {
        nav.cleanup();
        picker.remove();
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);
  }

  function cloudDeleteLayout(paneId) {
    if (cloudLayoutTimers.has(paneId)) {
      clearTimeout(cloudLayoutTimers.get(paneId));
      cloudLayoutTimers.delete(paneId);
    }
    cloudFetch('DELETE', `/api/layouts/${paneId}`)
      .catch(e => console.error('[Cloud] Layout delete failed:', e.message));
  }

  // Cloud view state (debounced 1s)
  let cloudViewStateTimer = null;
  function cloudSaveViewState() {
    if (cloudViewStateTimer) clearTimeout(cloudViewStateTimer);
    cloudViewStateTimer = setTimeout(() => {
      cloudFetch('PUT', '/api/view-state', {
        zoom: state.zoom,
        panX: state.panX,
        panY: state.panY
      }).catch(e => console.error('[Cloud] View state save failed:', e.message));
    }, 1000);
  }

  // Cloud note sync (debounced per-note, 500ms)
  const cloudNoteTimers = new Map();
  function cloudSaveNote(noteId, content, fontSize, images) {
    if (cloudNoteTimers.has(noteId)) clearTimeout(cloudNoteTimers.get(noteId));
    cloudNoteTimers.set(noteId, setTimeout(() => {
      cloudNoteTimers.delete(noteId);
      const payload = { content, fontSize };
      if (images !== undefined) payload.images = images;
      cloudFetch('PUT', `/api/cloud-notes/${noteId}`, payload)
        .catch(e => console.error('[Cloud] Note sync failed:', e.message));
    }, 500));
  }

  let canvas, canvasContainer;
  let isPanning = false;
  let panStartX, panStartY;
  let lastPanX, lastPanY;

  // Touch/drag state
  let activePane = null;
  let holdTimer = null;
  let isDragging = false;
  let isResizing = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  // ============================================================================
  // SECTION 5: MULTI-SELECT & BROADCAST                           [Lines ~445-497]
  // Pane selection for broadcast mode, indicator UI
  // ============================================================================

  // Broadcast mode state (unified multi-select + broadcast)
  const selectedPaneIds = new Set();

  function clearMultiSelect() {
    selectedPaneIds.forEach(id => {
      const el = document.getElementById(`pane-${id}`);
      if (el) el.classList.remove('broadcast-selected');
    });
    selectedPaneIds.clear();
    updateBroadcastIndicator();
  }

  function togglePaneSelection(paneId) {
    const el = document.getElementById(`pane-${paneId}`);
    if (!el) return;
    if (selectedPaneIds.has(paneId)) {
      selectedPaneIds.delete(paneId);
      el.classList.remove('broadcast-selected');
    } else {
      selectedPaneIds.add(paneId);
      el.classList.add('broadcast-selected');
    }
  }

  // Check if a DOM element is inside a broadcast-selected pane
  function isInsideBroadcastPane(el) {
    const paneEl = el.closest('.pane');
    if (!paneEl) return false;
    return selectedPaneIds.has(paneEl.dataset.paneId);
  }

  // Show/hide the broadcast indicator (unified yellow for all modes)
  function updateBroadcastIndicator() {
    let indicator = document.getElementById('broadcast-indicator');
    const count = selectedPaneIds.size;

    if (count >= 2) {
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'broadcast-indicator';
        document.body.appendChild(indicator);
      }
      indicator.className = 'broadcast-indicator';
      indicator.innerHTML = `<span class="broadcast-icon">◉</span> BROADCAST — ${count} panes`;
      indicator.style.display = 'flex';
    } else {
      if (indicator) indicator.style.display = 'none';
    }
  }

  // Pinch zoom state
  let initialPinchDistance = 0;
  let initialZoom = 1;

  // ============================================================================
  // SECTION 6: HUD SYSTEM (Fleet, Agents, Chat)                  [Lines ~499-1488]
  // HUD container, fleet device cards, agents usage, chat/feedback panel,
  // device highlighting, terminal theme application
  // ============================================================================

  // HUD overlay state
  let hudData = { devices: [] };
  let hudPollingTimer = null;
  let hudRenderTimer = null;
  let hudIsHovered = false;
  let hudExpanded = false;
  let deviceColorOverrides = {}; // { deviceName: colorIndex } — persisted in hudState.device_colors
  let deviceSwatchOpenFor = null; // device name whose color swatches are currently shown
  let hoveredDeviceName = null;
  const HUD_POLL_SLOW = 30000;
  const HUD_POLL_FAST = 1000;

  // Agents HUD state
  let agentsHudExpanded = false;
  let feedbackHudExpanded = false;
  let feedbackPaneHidden = false;
  let hudHidden = false;
  let fleetPaneHidden = false;
  let agentsPaneHidden = false;
  let agentsUsageData = null;
  let agentsUsageLastUpdated = null;
  let agentsUsageIntervalId = null;
  let agentsUsageFetchError = null;
  let agentsUsageAgoIntervalId = null;

  // Terminal themes loaded from themes.js (external file)
  let currentTerminalTheme = 'default';
  const TERMINAL_THEMES = window.TERMINAL_THEMES || {};

  // RESET_ICON_SVG — imported from modules/constants.js

  // Track which terminals are Claude Code (updated from WS push)
  const claudeTerminalIds = new Set();
  // Cache last received claude:states so we can re-apply after panes render
  let lastReceivedClaudeStates = null;

  // osIcon — imported from modules/constants.js

  // formatBytes, metricColorClass — imported from modules/utils.js

  function createHudContainer() {
    const container = document.createElement('div');
    container.id = 'hud-container';
    document.body.appendChild(container);

    // Restore dot — shown when HUD is fully hidden
    const dot = document.createElement('div');
    dot.id = 'hud-restore-dot';
    dot.addEventListener('click', () => toggleHudHidden());
    document.body.appendChild(dot);

    return container;
  }

  function toggleHudHidden() {
    hudHidden = !hudHidden;
    const container = document.getElementById('hud-container');
    const dot = document.getElementById('hud-restore-dot');
    if (hudHidden) {
      if (container) container.style.display = 'none';
      if (dot) dot.style.display = 'block';
      applyNoHudMode(true);
    } else {
      // Tab+H restores all panes to visible
      fleetPaneHidden = false;
      agentsPaneHidden = false;
      feedbackPaneHidden = false;
      if (container) container.style.display = '';
      if (dot) dot.style.display = 'none';
      applyPaneVisibility();
      applyNoHudMode(false);
    }
    savePrefsToCloud({ hudState: { fleet_expanded: hudExpanded, agents_expanded: agentsHudExpanded, feedback_expanded: feedbackHudExpanded, hud_hidden: hudHidden } });
  }

  function applyPaneVisibility() {
    const fleet = document.getElementById('hud-overlay');
    const agents = document.getElementById('agents-hud');
    const feedback = document.getElementById('feedback-hud');
    if (fleet) fleet.style.display = fleetPaneHidden ? 'none' : '';
    if (agents) agents.style.display = agentsPaneHidden ? 'none' : '';
    if (feedback) feedback.style.display = feedbackPaneHidden ? 'none' : '';
  }

  function checkAutoHideHud() {
    // If all panes are individually hidden, auto-collapse to dot
    if (fleetPaneHidden && agentsPaneHidden && feedbackPaneHidden) {
      hudHidden = true;
      const container = document.getElementById('hud-container');
      const dot = document.getElementById('hud-restore-dot');
      if (container) container.style.display = 'none';
      if (dot) dot.style.display = 'block';
      applyNoHudMode(true);
      savePrefsToCloud({ hudState: { fleet_expanded: hudExpanded, agents_expanded: agentsHudExpanded, feedback_expanded: feedbackHudExpanded, hud_hidden: hudHidden } });
    }
  }

  function applyNoHudMode(enabled) {
    const addBtn = document.getElementById('add-pane-btn');
    const settingsBtn = document.getElementById('settings-btn');
    const tutorialBtn = document.getElementById('tutorial-btn');
    const controls = document.getElementById('controls');
    const dot = document.getElementById('hud-restore-dot');
    if (enabled) {
      if (addBtn) addBtn.classList.add('no-hud-mode');
      if (settingsBtn) settingsBtn.classList.add('no-hud-mode');
      if (tutorialBtn) tutorialBtn.classList.add('no-hud-mode');
      if (controls) controls.classList.add('no-hud-mode');
      // Set dot color based on connection status
      updateHudDotColor();
    } else {
      if (addBtn) addBtn.classList.remove('no-hud-mode');
      if (settingsBtn) settingsBtn.classList.remove('no-hud-mode');
      if (tutorialBtn) tutorialBtn.classList.remove('no-hud-mode');
      if (controls) controls.classList.remove('no-hud-mode');
      if (dot) { dot.classList.remove('connected', 'disconnected'); }
    }
  }

  function updateHudDotColor() {
    const dot = document.getElementById('hud-restore-dot');
    if (!dot) return;
    const hasOnline = hudData.devices.some(d => d.online);
    dot.classList.toggle('connected', hasOnline);
    dot.classList.toggle('disconnected', !hasOnline);
  }

  function createHud(container) {
    const hud = document.createElement('div');
    hud.id = 'hud-overlay';
    if (!hudExpanded) hud.classList.add('collapsed');
    hud.innerHTML = `
      <div class="hud-header">
        <span class="hud-title">Machines</span>
        <span class="hud-collapse-dots"></span>
      </div>
      <div class="hud-content"></div>
    `;
    container.appendChild(hud);

    hud.addEventListener('click', (e) => {
      if (e.target.closest('input, button, a, select, textarea')) return;
      // Don't allow collapsing when fleet is empty — keep "Add Machine" visible
      if (hudData.devices.length === 0 && hudExpanded) return;
      hudExpanded = !hudExpanded;
      hud.classList.toggle('collapsed', !hudExpanded);
      savePrefsToCloud({
        hudState: {
          fleet_expanded: hudExpanded,
          agents_expanded: agentsHudExpanded,
        }
      });
      restartHudPolling();
      renderHud();
    });

    hud.addEventListener('mouseenter', () => {
      hudIsHovered = true;
      restartHudPolling();
    });
    hud.addEventListener('mouseleave', () => {
      hudIsHovered = false;
      restartHudPolling();
    });

    // Device hover highlight via event delegation (attached once, not per render)
    // Uses mouseover/mouseout + relatedTarget to avoid false clears when
    // moving between child elements inside the same .hud-device card.
    const hudContent = hud.querySelector('.hud-content');
    hudContent.addEventListener('mouseover', (e) => {
      const card = e.target.closest('.hud-device');
      if (!card) return;
      if (hoveredDeviceName === card.dataset.device) return; // already hovering this device
      hoveredDeviceName = card.dataset.device;
      applyDeviceHighlight();
    });
    hudContent.addEventListener('mouseout', (e) => {
      const card = e.target.closest('.hud-device');
      if (!card) return;
      // Only clear if mouse is actually leaving the card, not moving to a child within it
      const relatedCard = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.hud-device') : null;
      if (relatedCard === card) return;
      hoveredDeviceName = null;
      clearDeviceHighlight();
      renderHud(); // Catch up on any skipped renders during hover
    });
  }

  async function pollHud() {
    try {
      const onlineAgents = agents.filter(a => a.online);
      if (onlineAgents.length === 0) return;
      // Fetch metrics from all online agents in parallel
      const results = await Promise.all(
        onlineAgents.map(a => agentRequest('GET', '/api/metrics', null, a.agentId).catch(() => []))
      );
      // Merge all agents' device lists
      hudData.devices = results.flat();
      if (hudHidden) updateHudDotColor();
      // Skip DOM rebuild while hovering a device to prevent flickering;
      // data is still updated above — next render after hover ends picks it up.
      if (!hoveredDeviceName) renderHud();
    } catch (e) {
      // Silent — relay/agent may not be connected yet
    }
  }

  function restartHudPolling() {
    if (hudPollingTimer) clearInterval(hudPollingTimer);
    const rate = (hudExpanded && hudIsHovered) ? HUD_POLL_FAST : HUD_POLL_SLOW;
    hudPollingTimer = setInterval(pollHud, rate);
  }

  function getDevicePaneCounts(deviceName) {
    let terms = 0, claudes = 0, files = 0;
    for (const p of state.panes) {
      const pDevice = p.device || hudData.devices.find(d => d.isLocal)?.name;
      if (pDevice !== deviceName) continue;
      if (p.type === 'terminal') {
        if (claudeTerminalIds.has(p.id)) claudes++;
        else terms++;
      } else if (p.type === 'file') {
        files++;
      }
    }
    return { terms, claudes, files };
  }

  function renderHud() {
    const content = document.querySelector('#hud-overlay .hud-content');
    const collapseDots = document.querySelector('#hud-overlay .hud-collapse-dots');
    const hudEl = document.getElementById('hud-overlay');
    if (!content) return;

    // When fleet is empty, force expanded so "Add Machine" is always visible
    const fleetEmpty = hudData.devices.length === 0;
    if (fleetEmpty && !hudExpanded) {
      hudExpanded = true;
      if (hudEl) hudEl.classList.remove('collapsed');
    }

    // Build dots HTML for collapsed header
    let dotsHtml = '';
    if (!hudExpanded) {
      for (const device of hudData.devices) {
        const cls = device.online ? 'online' : 'offline';
        dotsHtml += `<span class="hud-dot ${cls}" data-tooltip="${escapeHtml(device.name)}"></span>`;
      }
    }
    if (collapseDots) collapseDots.innerHTML = dotsHtml;

    // Collapsed: nothing in content area
    if (!hudExpanded) {
      content.innerHTML = '';
      return;
    }

    // Expanded — split into active (has panes) and inactive (no panes + phones)
    const PHONE_OS = new Set(['iOS', 'android']);
    const active = [];
    const inactive = [];
    for (const device of hudData.devices) {
      const { terms, claudes, files } = getDevicePaneCounts(device.name);
      if (PHONE_OS.has(device.os) || (terms === 0 && claudes === 0 && files === 0)) {
        inactive.push(device);
      } else {
        active.push(device);
      }
    }

    // Pane count SVG icons (defined once)
    const termSvg = '<svg class="hud-count-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v12h16V6H4zm2 2l4 4-4 4 1.5 1.5L9 12l-5.5-5.5L2 8zm6 8h6v2h-6v-2z"/></svg>';
    const claudeSvg = CLAUDE_LOGO_SVG.replace('class="claude-logo"', 'class="hud-count-icon hud-claude-icon"');
    const fileSvg = '<svg class="hud-count-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>';

    function renderDeviceCard(device, showMetrics) {
      const online = device.online;
      const dotClass = online ? 'online' : 'offline';
      let icon = osIcon(device.os);
      const deviceColor = getDeviceColor(device.name);
      if (deviceColor) {
        icon = icon.replace('class="hud-os-icon"', `class="hud-os-icon" style="color:${deviceColor.text}"`);
      }
      const { terms, claudes, files } = getDevicePaneCounts(device.name);

      let countsHtml = '';
      const counts = [];
      if (claudes > 0) counts.push(`<span class="hud-count" data-tooltip="Claude Code">${claudeSvg}${claudes}</span>`);
      if (terms > 0) counts.push(`<span class="hud-count" data-tooltip="Terminals">${termSvg}${terms}</span>`);
      if (files > 0) counts.push(`<span class="hud-count" data-tooltip="Files">${fileSvg}${files}</span>`);
      if (counts.length) countsHtml = `<span class="hud-counts">${counts.join('')}</span>`;

      // Agent version dot (green = up to date, yellow = outdated)
      let versionDotHtml = '';
      const agentEntry = agents.find(a => a.hostname === device.name || a.agentId === device.ip);
      if (agentEntry?.version && online) {
        const isOutdated = agentUpdates.has(agentEntry.agentId);
        const dotClass2 = isOutdated ? 'hud-version-dot outdated' : 'hud-version-dot current';
        const tooltipText = isOutdated
          ? `v${agentEntry.version} — update available. Re-download: click Add Machine, copy the command, re-run on this machine. Kill the old agent process first.`
          : `v${agentEntry.version} — up to date`;
        versionDotHtml = `<span class="${dotClass2}" data-tooltip="${escapeHtml(tooltipText)}"></span>`;
      }

      let metricsHtml = '';
      if (showMetrics && device.metrics) {
        const m = device.metrics;
        const ramPct = Math.round((m.ram.used / m.ram.total) * 100);
        const ramMax = formatBytes(m.ram.total);
        const ramClass = metricColorClass(ramPct);

        const cpuVal = m.cpu != null ? m.cpu : null;
        const cpuClass = cpuVal != null ? metricColorClass(cpuVal) : '';

        let parts = [];
        parts.push(`<span class="hud-metric ${ramClass}">RAM ${ramPct}% <span class="hud-metric-dim">${ramMax}</span></span>`);
        parts.push(`<span class="hud-metric ${cpuClass}">CPU ${cpuVal != null ? cpuVal + '%' : '...'}</span>`);

        if (m.gpu) {
          const gpuClass = metricColorClass(m.gpu.utilization);
          parts.push(`<span class="hud-metric ${gpuClass}">GPU ${m.gpu.utilization}%</span>`);
        }

        metricsHtml = `<div class="hud-metrics">${parts.join('<span class="hud-metric-sep">·</span>')}</div>`;
      } else if (showMetrics && online) {
        metricsHtml = '<div class="hud-metrics"><span class="hud-metric hud-metric-dim">loading...</span></div>';
      }

      return `
        <div class="hud-device" data-device="${escapeHtml(device.name)}" data-agent-id="${escapeHtml(device.ip)}">
          <div class="hud-device-row">
            <span class="hud-status-dot ${dotClass}"></span>
            ${icon}
            <span class="hud-device-name">${escapeHtml(device.name)}</span>
            ${versionDotHtml}
            ${countsHtml}
            <button class="hud-device-delete" data-agent-id="${escapeHtml(device.ip)}" data-tooltip="Remove machine">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12"/><path d="M5.5 4V2.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V4"/><path d="M12.5 4v9a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 13V4"/></svg>
            </button>
          </div>
          ${metricsHtml}
        </div>
      `;
    }

    let html = '';

    if (fleetEmpty) {
      // Empty fleet — show prominent "Add Machine" as the default view
      html += `<div style="text-align:center;padding:12px 8px 4px;">
        <div style="color:rgba(255,255,255,0.4);font-size:11px;margin-bottom:10px;">No machines connected</div>
        <button class="add-machine-fleet-btn" style="width:100%;padding:8px 12px;background:#4ec9b0;border:none;color:#0a0a1a;border-radius:4px;cursor:pointer;font-family:monospace;font-size:12px;font-weight:600;transition:opacity 0.15s;">+ Add Machine</button>
      </div>`;
    } else {
      for (const device of active) {
        html += renderDeviceCard(device, !PHONE_OS.has(device.os));
      }

      if (inactive.length > 0) {
        html += '<div class="hud-section-sep"></div>';
        for (const device of inactive) {
          html += renderDeviceCard(device, !PHONE_OS.has(device.os));
        }
      }

      // Add "Add Machine" button at the bottom of the Machines HUD
      html += `<button class="add-machine-fleet-btn" style="width:100%;margin-top:8px;padding:6px;background:transparent;border:1px solid #4ec9b0;color:#4ec9b0;border-radius:4px;cursor:pointer;font-family:monospace;font-size:11px;transition:background 0.15s,color 0.15s;">+ Add Machine</button>`;
    }

    content.innerHTML = html;

    const addBtn = content.querySelector('.add-machine-fleet-btn');
    if (addBtn) {
      addBtn.addEventListener('click', showAddMachineDialog);
      // Apply pulse animation if no agents are online
      if (window.__pulseAddMachine) addBtn.classList.add('pulsing');
      if (fleetEmpty) {
        // Filled button style for empty fleet
        addBtn.addEventListener('mouseenter', () => { addBtn.style.opacity = '0.8'; });
        addBtn.addEventListener('mouseleave', () => { addBtn.style.opacity = '1'; });
      } else {
        // Outline button style when devices exist
        addBtn.addEventListener('mouseenter', () => { addBtn.style.background = '#4ec9b0'; addBtn.style.color = '#0a0a1a'; });
        addBtn.addEventListener('mouseleave', () => { addBtn.style.background = 'transparent'; addBtn.style.color = '#4ec9b0'; });
      }
    }

    // Device color picker — click a device card to show swatches
    function showSwatchesForCard(card) {
      const deviceName = card.dataset.device;
      const row = document.createElement('div');
      row.className = 'device-color-swatches';
      row.style.cssText = 'display:flex; gap:4px; padding:4px 0 2px 20px; flex-wrap:wrap;';
      DEVICE_COLORS.forEach((c, idx) => {
        const swatch = document.createElement('span');
        swatch.style.cssText = `width:16px; height:16px; border-radius:4px; cursor:pointer; background:${c.bg}; border:2px solid ${c.border}; transition:transform 0.1s;`;
        // Highlight current selection
        const currentIdx = deviceColorOverrides[deviceName];
        if (currentIdx === idx) swatch.style.outline = '2px solid rgba(255,255,255,0.6)';
        swatch.addEventListener('mouseenter', () => { swatch.style.transform = 'scale(1.3)'; });
        swatch.addEventListener('mouseleave', () => { swatch.style.transform = 'scale(1)'; });
        swatch.addEventListener('click', (ev) => {
          ev.stopPropagation();
          deviceColorOverrides[deviceName] = idx;
          savePrefsToCloud({
            hudState: {
              fleet_expanded: hudExpanded,
              agents_expanded: agentsHudExpanded,
              device_colors: deviceColorOverrides,
            }
          });
          renderHud();
          // Re-render pane headers with new device color
          for (const p of state.panes) {
            if (p.device === deviceName) {
              const paneEl = document.getElementById(`pane-${p.id}`);
              if (paneEl) applyDeviceHeaderColor(paneEl, deviceName);
            }
          }
        });
        row.appendChild(swatch);
      });
      card.appendChild(row);
    }

    // Delete machine buttons
    content.querySelectorAll('.hud-device-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const agentId = btn.dataset.agentId;
        const agentEntry = agents.find(a => a.agentId === agentId);
        if (!agentEntry) return;
        const deviceName = agentEntry.displayName || agentEntry.hostname || agentId;

        if (!confirm(`Remove "${deviceName}" and all its panes? This cannot be undone.`)) return;

        try {
          await cloudFetch('DELETE', `/api/agents/${agentEntry.agentId}`);

          // Remove all panes belonging to this agent
          const agentPanes = state.panes.filter(p => p.agentId === agentEntry.agentId || p.device === deviceName);
          for (const pane of agentPanes) {
            const paneEl = document.getElementById(`pane-${pane.id}`);
            if (paneEl) paneEl.remove();
            // Clean up terminal instances
            const termInfo = terminals.get(pane.id);
            if (termInfo) {
              termInfo.xterm.dispose();
              terminals.delete(pane.id);
              termDeferredBuffers.delete(pane.id);
            }
            // Clean up editor instances
            const editorInfo = fileEditors.get(pane.id);
            if (editorInfo) {
              if (editorInfo.monacoEditor) editorInfo.monacoEditor.dispose();
              if (editorInfo.resizeObserver) editorInfo.resizeObserver.disconnect();
              if (editorInfo.refreshInterval) clearInterval(editorInfo.refreshInterval);
              if (editorInfo.labelInterval) clearInterval(editorInfo.labelInterval);
              fileEditors.delete(pane.id);
            }
            const noteInfo = noteEditors.get(pane.id);
            if (noteInfo) {
              if (noteInfo.monacoEditor) noteInfo.monacoEditor.dispose();
              if (noteInfo.resizeObserver) noteInfo.resizeObserver.disconnect();
              noteEditors.delete(pane.id);
            }
            const ggInfo = gitGraphPanes.get(pane.id);
            if (ggInfo?.refreshInterval) clearInterval(ggInfo.refreshInterval);
            gitGraphPanes.delete(pane.id);
            const bInfo = beadsPanes.get(pane.id);
            if (bInfo?.refreshInterval) clearInterval(bInfo.refreshInterval);
            beadsPanes.delete(pane.id);
            const fpInfo = folderPanes.get(pane.id);
            if (fpInfo?.refreshInterval) clearInterval(fpInfo.refreshInterval);
            folderPanes.delete(pane.id);
          }
          state.panes = state.panes.filter(p => p.agentId !== agentEntry.agentId);

          // Remove agent from local state
          agents = agents.filter(a => a.agentId !== agentEntry.agentId);
          hudData.devices = hudData.devices.filter(d => d.ip !== agentId);
          renderHud();
        } catch (err) {
          console.error('[App] Failed to delete machine:', err);
          alert('Failed to remove machine. Please try again.');
        }
      });
    });

    // Double-click device name to rename
    content.querySelectorAll('.hud-device-name').forEach(nameEl => {
      nameEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const card = nameEl.closest('.hud-device');
        if (!card) return;
        const agentId = card.dataset.agentId;
        const agentEntry = agents.find(a => a.agentId === agentId);
        if (!agentEntry) return;

        // Prevent multiple inputs
        if (card.querySelector('.hud-device-name-input')) return;

        const input = document.createElement('input');
        input.className = 'hud-device-name-input';
        input.type = 'text';
        input.value = agentEntry.displayName || agentEntry.hostname || '';
        input.placeholder = agentEntry.hostname || 'Name';
        input.maxLength = 50;
        input.style.cssText = 'background:rgba(255,255,255,0.1);border:1px solid rgba(255,235,150,0.5);color:#fff;font-size:11px;font-family:monospace;padding:1px 4px;border-radius:3px;width:100px;outline:none;';

        nameEl.style.display = 'none';
        nameEl.parentNode.insertBefore(input, nameEl.nextSibling);
        input.focus();
        input.select();

        const commit = async () => {
          const val = input.value.trim();
          input.remove();
          nameEl.style.display = '';

          // If cleared or same as hostname, set to null (revert to hostname)
          const newDisplayName = (val && val !== agentEntry.hostname) ? val : null;
          if (newDisplayName === (agentEntry.displayName || null)) return; // No change

          try {
            await cloudFetch('PATCH', `/api/agents/${agentId}`, { displayName: newDisplayName || '' });
            agentEntry.displayName = newDisplayName;
            nameEl.textContent = newDisplayName || agentEntry.hostname || agentId;
            card.dataset.device = nameEl.textContent;
            // Update hudData too
            const hudDevice = hudData.devices.find(d => d.ip === agentId);
            if (hudDevice) hudDevice.name = nameEl.textContent;
          } catch (err) {
            console.error('[App] Failed to rename machine:', err);
          }
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (ke) => {
          if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
          if (ke.key === 'Escape') {
            input.value = agentEntry.displayName || agentEntry.hostname || '';
            input.blur();
          }
          ke.stopPropagation();
        });
        input.addEventListener('mousedown', (me) => me.stopPropagation());
      });
    });

    content.querySelectorAll('.hud-device').forEach(card => {
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        const deviceName = card.dataset.device;
        // Toggle: if swatches already shown, close them
        if (card.querySelector('.device-color-swatches')) {
          deviceSwatchOpenFor = null;
          card.querySelector('.device-color-swatches').remove();
          return;
        }
        // Remove any other open swatches
        content.querySelectorAll('.device-color-swatches').forEach(el => el.remove());
        deviceSwatchOpenFor = deviceName;
        showSwatchesForCard(card);
      });
      // Restore swatches if this card was open before re-render
      if (deviceSwatchOpenFor && card.dataset.device === deviceSwatchOpenFor) {
        showSwatchesForCard(card);
      }
    });

    // Re-apply highlight if mouse is still over a device after re-render
    if (hoveredDeviceName) {
      applyDeviceHighlight();
    }
  }

  function applyDeviceHighlight() {
    if (!hoveredDeviceName) return;
    if (quickViewActive) return; // QV already has its own overlays
    const localDevice = hudData.devices.find(d => d.isLocal)?.name;
    const deviceColor = getDeviceColor(hoveredDeviceName);
    const rgb = deviceColor ? deviceColor.rgb : '96,165,250';

    deviceHoverActive = true;

    document.querySelectorAll('.pane').forEach(paneEl => {
      const paneData = state.panes.find(p => p.id === paneEl.dataset.paneId);
      if (!paneData) return;

      // Add QV-style overlay with device/path/icon info
      addQuickViewOverlay(paneEl, paneData);

      // Highlight panes matching the hovered device with device color
      if (paneData.type !== 'note') {
        const paneDevice = paneData.device || localDevice;
        if (paneDevice === hoveredDeviceName) {
          paneEl.classList.add('device-highlighted');
          paneEl.style.boxShadow = `0 0 20px rgba(${rgb},0.4), 0 0 50px rgba(${rgb},0.15), inset 0 0 20px rgba(${rgb},0.08)`;
          paneEl.style.borderColor = `rgba(${rgb},0.5)`;
        }
      }
    });

    // Remove focused state like QV does
    document.querySelectorAll('.pane.focused').forEach(p => p.classList.remove('focused'));
  }

  function clearDeviceHighlight() {
    deviceHoverActive = false;
    // Only remove overlays if QV isn't also active (they share the same overlay class)
    if (!quickViewActive) {
      document.querySelectorAll('.quick-view-overlay').forEach(o => o.remove());
      document.querySelectorAll('.pane.qv-hover').forEach(p => p.classList.remove('qv-hover'));
    }
    document.querySelectorAll('.pane').forEach(paneEl => {
      paneEl.classList.remove('device-highlighted', 'device-dimmed');
      paneEl.style.boxShadow = '';
      paneEl.style.borderColor = '';
    });
  }

  // === Agents HUD ===
  function createAgentsHud(container) {
    const hud = document.createElement('div');
    hud.id = 'agents-hud';
    if (!agentsHudExpanded) hud.classList.add('collapsed');
    hud.innerHTML = `
      <div class="hud-header agents-hud-header">
        <span class="hud-title">Usage</span>
        <span class="agents-hud-pct" id="agents-hud-pct"></span>
        <button id="agents-usage-refresh" title="Refresh usage" style="background:none;border:none;color:#6a6a8a;cursor:pointer;padding:0 2px;line-height:1;font-size:13px;margin-left:4px;opacity:0.7;transition:opacity 0.15s;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.7">&#x21bb;</button>
      </div>
      <div class="agents-hud-content"></div>
    `;
    container.appendChild(hud);

    hud.addEventListener('click', (e) => {
      if (e.target.closest('input, button, a, select, textarea')) return;
      agentsHudExpanded = !agentsHudExpanded;
      hud.classList.toggle('collapsed', !agentsHudExpanded);
      savePrefsToCloud({
        hudState: {
          fleet_expanded: hudExpanded,
          agents_expanded: agentsHudExpanded,
        }
      });
      renderAgentsHud();
    });

    hud.querySelector('#agents-usage-refresh').addEventListener('click', (e) => {
      e.stopPropagation();
      fetchAgentsUsage(true);
    });

    // Polling starts when first agent comes online (see updateAgentsHud)
  }

  // === Chat HUD ===
  function createChatHud(container) {
    const CHAT_MAX_LENGTH = 3000;
    const CHAT_WARN_THRESHOLD = 2500;
    let chatLastSentAt = 0;
    let chatUnreadCount = 0;
    let chatMessagesLoaded = false;

    const hud = document.createElement('div');
    hud.id = 'feedback-hud';
    if (!feedbackHudExpanded) hud.classList.add('collapsed');
    hud.innerHTML = `
      <div class="hud-header chat-hud-header">
        <span class="hud-title">Feedback</span>
        <span class="chat-unread-badge" style="display:none;"></span>
      </div>
      <div class="chat-hud-content">
        <div class="chat-messages"></div>
        <div class="chat-input-area">
          <textarea class="chat-textarea" rows="2" maxlength="3000" placeholder="shift + enter to send"></textarea>
          <div class="chat-input-footer">
            <span class="chat-char-count"></span>
            <span class="chat-status"></span>
            <button class="chat-send-btn">Send</button>
          </div>
        </div>
      </div>
    `;
    container.appendChild(hud);

    const msgList = hud.querySelector('.chat-messages');
    const textarea = hud.querySelector('.chat-textarea');
    const sendBtn = hud.querySelector('.chat-send-btn');
    const statusEl = hud.querySelector('.chat-status');
    const charCountEl = hud.querySelector('.chat-char-count');
    const unreadBadge = hud.querySelector('.chat-unread-badge');

    // Restore draft
    const savedDraft = localStorage.getItem('tc_feedback_draft');
    if (savedDraft) textarea.value = savedDraft.substring(0, CHAT_MAX_LENGTH);

    function updateCharCount() {
      const len = textarea.value.length;
      if (len >= CHAT_WARN_THRESHOLD) {
        charCountEl.textContent = `${len} / ${CHAT_MAX_LENGTH}`;
        charCountEl.style.display = '';
      } else {
        charCountEl.textContent = '';
        charCountEl.style.display = 'none';
      }
    }

    function updateBadge() {
      if (chatUnreadCount > 0) {
        unreadBadge.textContent = chatUnreadCount > 99 ? '99+' : chatUnreadCount;
        unreadBadge.style.display = '';
      } else {
        unreadBadge.style.display = 'none';
      }
    }

    function formatTime(dateStr) {
      const d = new Date(dateStr + 'Z');
      const now = new Date();
      const diff = now - d;
      if (diff < 60000) return 'now';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    function escapeHtml(s) {
      const div = document.createElement('div');
      div.textContent = s;
      return div.innerHTML;
    }

    function appendMessage(msg) {
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble ' + (msg.sender === 'admin' ? 'admin' : 'user');
      bubble.innerHTML = `
        <div class="chat-bubble-body">${escapeHtml(msg.body)}</div>
        <div class="chat-bubble-time">${formatTime(msg.created_at)}</div>
      `;
      msgList.appendChild(bubble);
    }

    async function loadMessages() {
      try {
        const data = await cloudFetch('GET', '/api/messages');
        msgList.innerHTML = '';
        if (data.messages && data.messages.length > 0) {
          data.messages.forEach(m => appendMessage(m));
          msgList.scrollTop = msgList.scrollHeight;
        } else {
          msgList.innerHTML = '<div class="chat-empty">No messages yet. Say hello!</div>';
        }
        chatUnreadCount = data.unread || 0;
        updateBadge();
        chatMessagesLoaded = true;
        if (chatUnreadCount > 0) {
          cloudFetch('POST', '/api/messages/mark-read').then(() => {
            chatUnreadCount = 0;
            updateBadge();
          }).catch(() => {});
        }
      } catch (e) {
        // Feedback routes not available (self-hosted without extensions)
        console.warn('[chat] Messages not available:', e.message);
      }
    }

    async function sendMessage() {
      const message = textarea.value.trim();
      if (!message) return;
      const now = Date.now();
      if (now - chatLastSentAt < 10000) {
        statusEl.textContent = 'Wait 10s';
        statusEl.className = 'chat-status error';
        return;
      }
      sendBtn.disabled = true;
      statusEl.textContent = '';
      statusEl.className = 'chat-status';
      try {
        const resp = await cloudFetch('POST', '/api/messages', { message });
        chatLastSentAt = Date.now();
        textarea.value = '';
        localStorage.removeItem('tc_feedback_draft');
        updateCharCount();
        if (resp.message) {
          const empty = msgList.querySelector('.chat-empty');
          if (empty) empty.remove();
          appendMessage(resp.message);
          msgList.scrollTop = msgList.scrollHeight;
        }
      } catch (e) {
        statusEl.textContent = 'Failed';
        statusEl.className = 'chat-status error';
        setTimeout(() => { statusEl.textContent = ''; }, 2000);
      } finally {
        sendBtn.disabled = false;
      }
    }

    textarea.addEventListener('input', () => {
      if (textarea.value.length > CHAT_MAX_LENGTH) {
        textarea.value = textarea.value.substring(0, CHAT_MAX_LENGTH);
      }
      localStorage.setItem('tc_feedback_draft', textarea.value);
      updateCharCount();
    });

    hud.addEventListener('click', (e) => {
      if (e.target.closest('textarea, button, a, select')) return;
      feedbackHudExpanded = !feedbackHudExpanded;
      hud.classList.toggle('collapsed', !feedbackHudExpanded);
      if (feedbackHudExpanded) {
        textarea.focus();
        loadMessages();
      }
      savePrefsToCloud({
        hudState: {
          fleet_expanded: hudExpanded,
          agents_expanded: agentsHudExpanded,
          feedback_expanded: feedbackHudExpanded,
        }
      });
    });

    sendBtn.addEventListener('click', sendMessage);

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    updateCharCount();

    if (feedbackHudExpanded) {
      loadMessages();
    } else {
      cloudFetch('GET', '/api/messages/unread-count').then(data => {
        chatUnreadCount = data.count || 0;
        updateBadge();
      }).catch(() => {});
    }

    window._chatHud = {
      appendMessage,
      loadMessages,
      get isExpanded() { return feedbackHudExpanded; },
      get unreadCount() { return chatUnreadCount; },
      set unreadCount(v) { chatUnreadCount = v; updateBadge(); },
      markRead() {
        cloudFetch('POST', '/api/messages/mark-read').then(() => {
          chatUnreadCount = 0;
          updateBadge();
        }).catch(() => {});
      },
      scrollToBottom() { msgList.scrollTop = msgList.scrollHeight; },
    };
  }

  async function fetchAgentsUsage(force = false) {
    // Query agents sequentially — stop at first success.
    // (usage data is per-account, so any agent returns the same data; parallel
    // requests against the same OAuth token trigger Anthropic rate limits)
    const onlineAgents = agents.filter(a => a.online);
    if (onlineAgents.length === 0) return;
    const path = force ? '/api/usage?force=true' : '/api/usage';
    let lastError = null;
    for (const agent of onlineAgents) {
      try {
        const data = await agentRequest('GET', path, null, agent.agentId);
        if (data) {
          agentsUsageData = data;
          if (!data.stale) agentsUsageLastUpdated = Date.now();
          agentsUsageFetchError = null;
          renderAgentsHud();
          return;
        }
      } catch (e) {
        lastError = e.message || 'Failed to fetch usage';
        console.warn(`[usage] Agent ${agent.agentId.slice(0,8)} failed:`, e.message);
      }
    }
    agentsUsageFetchError = lastError || 'No response from agents';
    console.warn('[usage] All agents failed to return usage data');
    renderAgentsHud();
  }

  function agentsUsageColorClass(pct) {
    if (pct >= 75) return 'high';
    if (pct >= 40) return 'medium';
    return 'low';
  }

  function agentsTimeUntil(isoDate) {
    const diff = new Date(isoDate) - Date.now();
    if (diff <= 0) return 'now';
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function renderAgentsHud() {
    const hud = document.getElementById('agents-hud');
    if (!hud) return;

    const pctEl = hud.querySelector('#agents-hud-pct');
    const content = hud.querySelector('.agents-hud-content');

    // Header: show shortest-term usage percentage
    if (agentsUsageData && agentsUsageData.five_hour) {
      const pct = agentsUsageData.five_hour.utilization;
      const cls = agentsUsageColorClass(pct);
      if (pctEl) {
        pctEl.textContent = pct + '%';
        pctEl.className = 'agents-hud-pct ' + cls;
      }
    } else if (pctEl) {
      pctEl.textContent = '';
    }

    // Collapsed: no content
    if (!agentsHudExpanded) {
      if (content) content.innerHTML = '';
      return;
    }

    // Expanded: usage bars
    if (!agentsUsageData) {
      content.innerHTML = '<div class="agents-empty">Loading...</div>';
      return;
    }

    let blocks = '';
    function addBlock(periodLabel, data) {
      if (!data) return;
      const pct = data.utilization;
      const cls = agentsUsageColorClass(pct);
      const reset = agentsTimeUntil(data.resets_at);
      blocks += `
        <div class="usage-block">
          <div class="usage-top-row">
            ${RESET_ICON_SVG}
            <span class="usage-reset-time">${reset}</span>
            <span class="usage-pct ${cls}">${pct}%</span>
          </div>
          <div class="usage-bar-track">
            <div class="usage-bar-fill ${cls}" style="width: ${Math.min(pct, 100)}%"></div>
          </div>
          <div class="usage-period">${periodLabel}</div>
        </div>
      `;
    }

    addBlock('5-hour window', agentsUsageData.five_hour);
    addBlock('7-day window', agentsUsageData.seven_day);
    addBlock('7-day sonnet', agentsUsageData.seven_day_sonnet);
    if (agentsUsageData.seven_day_opus) addBlock('7-day opus', agentsUsageData.seven_day_opus);

    // "Last updated" indicator + error state
    if (agentsUsageLastUpdated) {
      const ago = Math.floor((Date.now() - agentsUsageLastUpdated) / 60000);
      const agoText = ago < 1 ? 'just now' : `${ago}m ago`;
      const isStale = ago >= 10;
      const color = isStale ? '#e85' : '#666';
      let updatedLine = `<div class="agents-last-updated" style="text-align:right;font-size:10px;color:${color};margin-top:4px;">Updated ${agoText}`;
      if (agentsUsageData?.stale) {
        updatedLine += ` <span style="color:#e85;" title="Anthropic rate limited — showing cached data">\u00b7 data may be outdated</span>`;
      } else if (agentsUsageFetchError && isStale) {
        updatedLine += ` <span style="color:#e55;">\u00b7 update failed</span>`;
      }
      updatedLine += `</div>`;
      blocks += updatedLine;
    } else if (agentsUsageFetchError) {
      blocks += `<div class="agents-last-updated" style="text-align:right;font-size:10px;color:#e55;margin-top:4px;">Failed to load usage</div>`;
    }

    content.innerHTML = blocks || '<div class="agents-empty">No usage data</div>';
  }

  // === Terminals HUD ===
  function applyTerminalTheme(themeKey) {
    const theme = TERMINAL_THEMES[themeKey];
    if (!theme) return;
    currentTerminalTheme = themeKey;
    // Apply to all existing terminals
    terminals.forEach(({ xterm }) => {
      xterm.options.theme = { ...theme };
    });
  }


  // ============================================================================
  // SECTION 7: GUEST MODE & CLAUDE STATE TRACKING                [Lines ~1491-1942]
  // Guest session nudges/expiry, init() bootstrap, Claude state badges,
  // updateClaudeStates() notification integration
  // ============================================================================

  // === Guest Mode: Nudge & Forced Registration ===
  const GUEST_HARD_LIMIT_MS = 30 * 60 * 1000;       // 30 minutes
  const GUEST_TOAST_ID = '__guest_expiry__';
  let guestExpiryTimers = [];
  let guestCountdownInterval = null;

  function showGuestRegisterModal(force) {
    let overlay = document.getElementById('guest-register-overlay');
    if (overlay) overlay.remove();

    overlay = document.createElement('div');
    overlay.id = 'guest-register-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:200000;';

    const card = document.createElement('div');
    card.style.cssText = 'background:#1a1a2e;border:1px solid #8b8ff6;border-radius:14px;padding:36px;max-width:440px;width:90%;color:#e0e0e0;font-family:Montserrat,sans-serif;text-align:center;';

    const title = force ? 'sorry\u{1F614}\u{1F61E} \u2014 guest session expired' : 'Guest session ending soon';
    const msg = force
      ? 'we are not VC funded and we are paying out of pocket. Unfortunately we can not yet afford to let people use this as guests for longer, BUT if you register now, you get to keep all your work!!'
      : 'we are not VC funded and we are paying out of pocket. Unfortunately we can not yet afford to let people use this as guests for longer, BUT if you register now, you get to keep all your work!!';
    const continueBtn = force
      ? ''
      : `<button id="guest-continue-btn" style="background:transparent;color:#5a6578;border:1px solid rgba(255,255,255,0.1);padding:10px 24px;border-radius:8px;cursor:pointer;font-family:monospace;font-size:13px;margin-top:4px;">continue in guest mode</button>`;

    // In local mode, redirect to login page instead of showing OAuth modal
    const isLocal = !window.__tcUser || window.__tcAuthMode === 'local';
    if (isLocal && force) {
      window.location.href = '/login';
      return;
    }

    card.innerHTML = `
      <h2 style="margin:0 0 12px;color:#8b8ff6;font-size:20px;font-weight:600;">${title}</h2>
      <p style="color:#8a8faa;margin:0 0 24px;font-size:14px;line-height:1.5;">${msg}</p>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px;">
        <a href="/login" style="display:inline-flex;align-items:center;justify-content:center;gap:10px;padding:12px 20px;background:rgba(139,143,246,0.15);border:1px solid rgba(139,143,246,0.35);border-radius:8px;color:#e8ecf4;text-decoration:none;font-size:14px;transition:all 0.2s;">
          Sign up
        </a>
      </div>
      ${continueBtn}
    `;
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Force mode: block all interaction (no dismiss)
    if (force) return;

    // Continue in guest mode button
    const continueEl = document.getElementById('guest-continue-btn');
    if (continueEl) {
      continueEl.addEventListener('click', () => overlay.remove());
    }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  // Show a guest expiry toast using the same notification system as claude state notifs
  function showGuestExpiryToast(remainingMs, snoozable) {
    // Remove existing guest toast
    const existingToast = activeToasts.get(GUEST_TOAST_ID);
    if (existingToast) {
      if (existingToast._guestCountdown) clearInterval(existingToast._guestCountdown);
      activeToasts.delete(GUEST_TOAST_ID);
      existingToast.remove();
    }

    const toast = document.createElement('div');
    toast.className = 'notification-toast state-guest-expiry';
    toast.dataset.terminalId = GUEST_TOAST_ID;
    toast.dataset.claudeState = 'guest-expiry';

    const minutesLeft = Math.ceil(remainingMs / 60000);
    const timeLabel = minutesLeft > 1 ? `${minutesLeft} min` : '< 1 min';

    const actionButton = snoozable
      ? `<button class="notification-snooze" data-tooltip="Snooze">\u{1F554}</button>`
      : '';

    toast.innerHTML = `
      <div class="notification-icon">\u{1F616}</div>
      <div class="notification-body">
        <div class="notification-title">Guest session ending</div>
        <div class="notification-device guest-timer-label">${timeLabel} remaining</div>
      </div>
      ${actionButton}
    `;

    toast._notificationInfo = { claudeState: 'guest-expiry' };

    // Click toast → open modal with "continue in guest mode" (unless expired)
    toast.addEventListener('click', (e) => {
      if (e.target.closest('.notification-snooze')) return;
      const user = window.__tcUser;
      if (!user || !user.isGuest) return;
      const startedAt = new Date(user.guestStartedAt).getTime();
      const nowRemaining = GUEST_HARD_LIMIT_MS - (Date.now() - startedAt);
      showGuestRegisterModal(nowRemaining <= 0);
    });

    // Snooze button (only on 60/15 min toasts)
    const snoozeBtn = toast.querySelector('.notification-snooze');
    if (snoozeBtn) {
      snoozeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (toast._guestCountdown) clearInterval(toast._guestCountdown);
        toast.classList.add('dismissing');
        activeToasts.delete(GUEST_TOAST_ID);
        setTimeout(() => toast.remove(), 200);
      });
    }

    // For the 3-min (unsnoozable) toast, run a live countdown timer
    if (!snoozable) {
      const timerLabel = toast.querySelector('.guest-timer-label');
      const expiresAt = Date.now() + remainingMs;
      toast._guestCountdown = setInterval(() => {
        const left = Math.max(0, expiresAt - Date.now());
        const m = Math.floor(left / 60000);
        const s = Math.floor((left % 60000) / 1000);
        timerLabel.textContent = `${m}:${String(s).padStart(2, '0')} remaining`;
        if (left <= 0) {
          clearInterval(toast._guestCountdown);
          timerLabel.textContent = 'expired';
          showGuestRegisterModal(true);
        }
      }, 1000);
    }

    if (getNotificationContainer()) {
      getNotificationContainer().prepend(toast);
      activeToasts.set(GUEST_TOAST_ID, toast);
      requestAnimationFrame(() => toast.classList.add('visible'));
    }
  }

  function initGuestNudge(user) {
    if (!user.isGuest) return;

    const startedAt = new Date(user.guestStartedAt).getTime();
    const elapsed = Date.now() - startedAt;
    const remaining = GUEST_HARD_LIMIT_MS - elapsed;

    // Already expired
    if (remaining <= 0) {
      showGuestRegisterModal(true);
      return;
    }

    // Clear any previous timers
    guestExpiryTimers.forEach(t => clearTimeout(t));
    guestExpiryTimers = [];

    // Schedule toast at 60 min before expiry (snoozable) — only if enough time left
    const t60 = remaining - 60 * 60 * 1000; // won't fire for 30min sessions, that's fine
    if (t60 > 0) {
      guestExpiryTimers.push(setTimeout(() => {
        if (!activeToasts.has(GUEST_TOAST_ID)) showGuestExpiryToast(60 * 60 * 1000, true);
      }, t60));
    }

    // 15 min before expiry (snoozable) — transform existing or show new
    const t15 = remaining - 15 * 60 * 1000;
    if (t15 > 0) {
      guestExpiryTimers.push(setTimeout(() => {
        showGuestExpiryToast(15 * 60 * 1000, true);
      }, t15));
    } else if (remaining > 3 * 60 * 1000) {
      // Already past 15 min mark but not yet at 3 min — show immediately
      showGuestExpiryToast(remaining, true);
    }

    // 3 min before expiry (unsnoozable + live countdown)
    const t3 = remaining - 3 * 60 * 1000;
    if (t3 > 0) {
      guestExpiryTimers.push(setTimeout(() => {
        showGuestExpiryToast(3 * 60 * 1000, false);
      }, t3));
    } else {
      // Already under 3 min — show countdown immediately
      showGuestExpiryToast(remaining, false);
    }

    // Hard expiry — force modal
    guestExpiryTimers.push(setTimeout(() => {
      showGuestRegisterModal(true);
    }, remaining));
  }

  async function init() {

    // Auth check
    try {
      const authRes = await fetch('/auth/me', { credentials: 'include' });
      if (authRes.status === 401) {
        window.location.href = '/login';
        return;
      }
      const currentUser = await authRes.json();
      // Store user info for tier gating later
      window.__tcUser = currentUser;

      // Start guest nudge timers if this is a guest session
      if (currentUser.isGuest) {
        initGuestNudge(currentUser);
      }
    } catch (e) {
      // If auth check fails, continue anyway (might be local dev mode)
      console.warn('[App] Auth check failed:', e);
    }

    // Load cloud preferences (night mode, theme, sound)
    try {
      const prefs = await cloudFetch('GET', '/api/preferences');
      if (prefs.nightMode) setNightMode(true);
      if (prefs.terminalTheme && TERMINAL_THEMES[prefs.terminalTheme]) {
        currentTerminalTheme = prefs.terminalTheme;
      }
      if (prefs.notificationSound !== undefined) {
        notificationSoundEnabled = prefs.notificationSound;
        _setSoundEnabled(prefs.notificationSound);
      }
      if (prefs.autoRemoveDone !== undefined) {
        autoRemoveDoneNotifs = prefs.autoRemoveDone;
      }
      if (prefs.canvasBg) setCanvasBackground(prefs.canvasBg);
      if (prefs.snoozeDuration) {
        snoozeDurationMs = prefs.snoozeDuration * 1000;
      }
      if (prefs.terminalFont) {
        currentTerminalFont = prefs.terminalFont;
      }
      if (prefs.focusMode) {
        focusMode = prefs.focusMode;
      } else if (matchMedia('(pointer: coarse)').matches) {
        // Touch-primary device with no saved preference: default to click focus
        focusMode = 'click';
      }
      if (prefs.hudState) {
        hudExpanded = !!prefs.hudState.fleet_expanded;
        agentsHudExpanded = !!prefs.hudState.agents_expanded;
        feedbackHudExpanded = !!prefs.hudState.feedback_expanded;
        if (prefs.hudState.device_colors) deviceColorOverrides = prefs.hudState.device_colors;
        hudHidden = !!prefs.hudState.hud_hidden;
      }
      if (prefs.tutorialsCompleted) {
        tutorialsCompleted = prefs.tutorialsCompleted;
      }
      if (prefs.projectsSidebarPosition) {
        projectsSidebarPosition = prefs.projectsSidebarPosition;
      }
      if (prefs.teleportAnimation !== undefined) {
        teleportAnimation = prefs.teleportAnimation;
      }
      // Load projects
      loadProjectsFromPrefs(prefs);
    } catch (e) {
      console.error('[App] Preferences load failed:', e.message);
    }

    // xterm.js is loaded via ESM import at top of file

    // Wire up module dependencies (modules can't access IIFE scope directly)
    initMinimap({
      getState: () => state,
      updateCanvasTransform: () => updateCanvasTransform(),
      saveViewState: () => saveViewState(),
      getMoveModeActive: () => moveModeActive,
      getMoveModePaneId: () => moveModePaneId,
    });
    initNotificationDeps({
      getState: () => state,
      panToPane: (id) => panToPane(id),
      getSnoozeDurationMs: () => snoozeDurationMs,
      getAutoRemoveDoneNotifs: () => autoRemoveDoneNotifs,
    });
    initGitGraphDeps({
      getNextShortcutNumber, deviceLabelHtml, paneNameHtml, shortcutBadgeHtml,
      setupPaneListeners, agentRequest, gitGraphPanes, cloudSaveLayout,
      getCanvas: () => canvas,
    });

    canvas = document.getElementById('canvas');
    canvasContainer = document.getElementById('canvas-container');

    // Selection rectangle for shift+drag broadcast selection
    const selectionRect = document.createElement('div');
    selectionRect.id = 'selection-rect';
    canvas.appendChild(selectionRect);

    // Start minimap render loop
    startMinimapLoop();

    // Delegated click handler for disconnect overlay action buttons
    canvas.addEventListener('click', (e) => {
      const btn = e.target.closest('.disconnect-action-btn');
      if (!btn) return;
      const paneId = btn.dataset.paneId;
      if (!paneId) return;
      const isResume = btn.classList.contains('resume-btn');
      resumeTerminalPane(paneId, isResume);
    });

    updateCanvasTransform();
    setupEventListeners();
    initNotifications();
    showPromoToasts();
    connectWebSocket();
    _telemetry.init();
    // loadTerminalsFromServer is called after agents:list arrives via WS

    const hudContainer = createHudContainer();
    createHud(hudContainer);
    createAgentsHud(hudContainer);
    createChatHud(hudContainer);
    // Apply HUD hidden state from preferences
    if (hudHidden) {
      hudContainer.style.display = 'none';
      const dot = document.getElementById('hud-restore-dot');
      if (dot) dot.style.display = 'block';
      applyNoHudMode(true);
    }
    pollHud();
    restartHudPolling();
    // Re-render every 5s to keep pane counts fresh (1s caused Firefox freeze from DOM thrashing)
    hudRenderTimer = setInterval(renderHud, 5000);

    // Redirect first-time users to the interactive tutorial
    // Skip if server-side prefs already show completion (returning user, new device)
    const tutorialState = localStorage.getItem('tc_tutorial');
    if (!tutorialState && !tutorialsCompleted['getting-started']) {
      window.location.href = '/tutorial';
      return;
    }
    // Sync localStorage if server says completed but local doesn't know
    if (!tutorialState && tutorialsCompleted['getting-started']) {
      try { localStorage.setItem('tc_tutorial', 'completed'); } catch (e) {}
    }

  }

  // CLAUDE_LOGO_SVG — imported from modules/constants.js

  // formatLocationPath — imported from modules/utils.js

  // Notification functions — imported from modules/notifications.js

    // Update pane headers with Claude state info (called from WS push)
  function updateClaudeStates(states) {
    if (getIsFirstClaudeStateUpdate()) {
      // On first load, show notifications for existing permission/question states
      // Sort: questions/inputNeeded first, permissions last (prepend = last added lands on top)
      const entries = Object.entries(states).filter(([, i]) => i.isClaude &&
        (i.state === 'permission' || i.state === 'question' || i.state === 'inputNeeded'));
      entries.sort((a, b) => {
        const rank = s => s === 'permission' ? 1 : 0;
        return rank(a[1].state) - rank(b[1].state);
      });
      for (const [terminalId, info] of entries) {
        handleStateTransition(terminalId, 'working', info.state, info);
      }
    } else {
      // Detect state transitions and fire notifications
      for (const [terminalId, info] of Object.entries(states)) {
        if (!info.isClaude) continue;
        const prevState = previousClaudeStates.get(terminalId);
        const newState = info.state;

        if (prevState !== newState) {
          // Skip done notifications for terminals first appearing as already idle
          if (!prevState && newState === 'idle') continue;
          // Treat newly-seen terminals as transitioning from 'working'
          // so sounds fire when a terminal first appears in a notifiable state
          handleStateTransition(terminalId, prevState || 'working', newState, info);
        }

        // If state changed away from a notified state, clear dedup + auto-dismiss toast
        if (notifiedStates.has(terminalId) && notifiedStates.get(terminalId) !== newState) {
          notifiedStates.delete(terminalId);
          dismissToast(terminalId);
        }
      }
    }
    setIsFirstClaudeStateUpdate(false);

    // Track current states for next comparison
    for (const [terminalId, info] of Object.entries(states)) {
      if (info.isClaude) {
        previousClaudeStates.set(terminalId, info.state);
      }
    }

    // Update tab title badge
    updateTabTitleBadge(states);

    // Update DOM (original logic)
    for (const [terminalId, info] of Object.entries(states)) {
      // Track alternate screen state from tmux (authoritative source)
      const termInfo = terminals.get(terminalId);
      if (termInfo && info) {
        termInfo._alternateOn = !!info.alternateOn;
      }
      // Track claude terminals for HUD counts
      if (info && info.isClaude) claudeTerminalIds.add(terminalId);
      else claudeTerminalIds.delete(terminalId);
      const paneEl = document.getElementById(`pane-${terminalId}`);
      const titleEl = paneEl?.querySelector('.pane-title');
      const paneData = state.panes.find(p => p.id === terminalId);

      // Update paneData.workingDir from live tmux cwd
      if (paneData && info && info.cwd) {
        paneData.workingDir = info.cwd;
      }
      // Update Claude session ID/name and persist to cloud when they change
      if (paneData && info && info.claudeSessionId) {
        const idChanged = paneData.claudeSessionId !== info.claudeSessionId;
        const nameChanged = info.claudeSessionName && paneData.claudeSessionName !== info.claudeSessionName;
        paneData.claudeSessionId = info.claudeSessionId;
        if (info.claudeSessionName) paneData.claudeSessionName = info.claudeSessionName;
        if (idChanged || nameChanged) cloudSaveLayout(paneData);
      }

      if (paneEl && titleEl && info) {
        paneEl.classList.remove('claude-working', 'claude-idle', 'claude-permission', 'claude-question', 'claude-input-needed');

        const deviceLabel = paneData?.device ? deviceLabelHtml(paneData.device) : '';
        const beadsTag = beadsTagHtml(paneData?.beadsTag);

        // Skip title update if user is editing a beads tag
        const isEditingBeadsTag = paneEl.querySelector('.beads-tag-input');

        if (info.isClaude) {
          const stateClassMap = {
            working: 'claude-working',
            idle: 'claude-idle',
            permission: 'claude-permission',
            question: 'claude-question',
            inputNeeded: 'claude-input-needed'
          };
          if (stateClassMap[info.state]) {
            paneEl.classList.add(stateClassMap[info.state]);
          }

          const stateIndicators = CLAUDE_STATE_SVGS;
          const stateHtml = stateIndicators[info.state] || '';
          const locationHtml = info.location ? formatLocationPath(info.location.name) : '';
          const sessionBadge = claudeSessionBadgeHtml(info.claudeSessionId, info.claudeSessionName);

          if (!isEditingBeadsTag) {
            titleEl.innerHTML = `
              <span class="claude-header">
                ${deviceLabel}
                ${beadsTag}
                ${sessionBadge}
                ${sessionBadge ? '' : CLAUDE_LOGO_SVG}
                ${stateHtml}
                <span class="claude-location">${locationHtml}</span>
              </span>
            `;
          }
        } else {
          if (!isEditingBeadsTag) {
            titleEl.innerHTML = `${deviceLabel}${beadsTag}<span style="opacity:0.7;">Terminal</span>`;
          }
        }
      }
    }
  }

  // ============================================================================
  // SECTION 8: WEBSOCKET COMMUNICATION                           [Lines ~1944-2388]
  // connectWebSocket(), handleWsMessage() giant switch, heartbeat, reconnect,
  // agent online/offline handling, upgrade prompts
  // ============================================================================

  // Connect to WebSocket
  function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;


    ws = new WebSocket(wsUrl);

    let heartbeatInterval = null;

    ws.onopen = () => {

      clearTimeout(wsReconnectTimer);
      wsReconnectDelay = 2000; // reset backoff on successful connection
      // Send heartbeat every 10s to keep connection alive over Tailscale/NAT
      clearInterval(heartbeatInterval);
      heartbeatInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 10000);
      // Reattach any pending terminals
      for (const paneId of pendingAttachments) {
        const pane = state.panes.find(p => p.id === paneId);
        if (pane) {
          attachTerminal(pane);
        }
      }
      pendingAttachments.clear();
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'pong') return; // ignore heartbeat replies
        handleWsMessage(message);
      } catch (e) {
        console.error('[WS] Error parsing message:', e);
      }
    };

    ws.onclose = () => {
      clearInterval(heartbeatInterval);

      // Reject all pending REST-over-WS requests immediately
      for (const [id, pending] of pendingRequests.entries()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('WebSocket disconnected'));
      }
      pendingRequests.clear();
      pendingScanCallbacks.clear();

      console.log(`[WS] Reconnecting in ${wsReconnectDelay}ms...`);
      wsReconnectTimer = setTimeout(connectWebSocket, wsReconnectDelay);
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_RECONNECT_MAX);
    };

    ws.onerror = (error) => {
      console.error('[WS] Error:', error);
    };
  }

  // Handle WebSocket messages
  function handleWsMessage(message) {
    const { type, payload } = message;


    switch (type) {
      case 'terminal:attached':

        updateConnectionStatus(payload.terminalId, 'connected');
        console.log(`[DBG-ATTACH] terminal:attached for ${payload.terminalId.slice(0,8)} at ${Date.now()}`);
        // Fade out loading overlay
        {
          const paneEl = document.getElementById(`pane-${payload.terminalId}`);
          const overlay = paneEl?.querySelector('.terminal-loading-overlay');
          if (overlay) {
            overlay.classList.add('fade-out');
            overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
          }
        }
        // History is now injected server-side via terminal:history message.
        // Only run ONCE per terminal — skip on reattach after agent reconnect.
        {
          const termInfo = terminals.get(payload.terminalId);
          if (termInfo) {
            // Enable input forwarding — pty is now in raw mode (tmux controls it)
            termInfo._attached = true;
          }
          if (termInfo && !termInfo._initialAttachDone) {
            termInfo._initialAttachDone = true;
            console.log(`[DBG-ATTACH] first attach for ${payload.terminalId.slice(0,8)}, history injection via terminal:history message`);
          } else if (termInfo) {
            console.log(`[DBG-ATTACH] reattach for ${payload.terminalId.slice(0,8)} (skipping history injection)`);
          }
        }
        break;

      case 'terminal:history':
        if (payload.data) {
          const termInfo = terminals.get(payload.terminalId);
          // Only inject history once per xterm instance. On WebSocket
          // reconnect the agent re-sends history, but the xterm buffer
          // already has it — writing it again causes duplicate content.
          // On page refresh, termInfo is a new object so the flag is unset.
          if (termInfo && !termInfo._historyLoaded) {
            termInfo._historyLoaded = true;
            const decoded = Uint8Array.from(atob(payload.data), c => c.charCodeAt(0));
            console.log(`[DBG-HISTORY] Writing ${decoded.length} bytes of history for ${payload.terminalId.slice(0,8)}`);
            termInfo.xterm.write(decoded);
            // Push history into scrollback so tmux's cursor positioning
            // (e.g. \e[H) from the live screen dump won't overwrite it.
            // The visible area is cleared for tmux to paint the current screen.
            const rows = termInfo.xterm.rows;
            termInfo.xterm.write('\r\n'.repeat(rows), () => {
              // Viewport is now stuck in scrollback — scroll to bottom
              // so the live screen (painted by tmux) is visible immediately.
              termInfo.xterm.scrollToBottom();
            });
          } else if (termInfo) {
            console.log(`[DBG-HISTORY] Skipping duplicate history for ${payload.terminalId.slice(0,8)}`);
          }
        }
        break;

      case 'terminal:output':

        if (payload.data) {
          const decoded = Uint8Array.from(atob(payload.data), c => c.charCodeAt(0));
          writeTermOutput(payload.terminalId, decoded);
        }
        break;

      case 'terminal:error':
        console.error('[WS] Terminal error:', payload.message);
        updateConnectionStatus(payload.terminalId, 'error');
        break;

      case 'terminal:disconnected':
        console.log(`[DBG-ATTACH] terminal:disconnected for ${payload.terminalId.slice(0,8)} — will reattach in 2s`);
        updateConnectionStatus(payload.terminalId, 'disconnected');
        // Auto-reattach after a short delay
        setTimeout(() => {
          const pane = state.panes.find(p => p.id === payload.terminalId);
          if (pane && ws && ws.readyState === WebSocket.OPEN) {
            console.log(`[DBG-ATTACH] reattaching ${payload.terminalId.slice(0,8)}`);
            attachTerminal(pane);
          }
        }, 2000);
        break;

      case 'terminal:closed': {
        const closedPane = state.panes.find(p => p.id === payload.terminalId);
        if (!closedPane) break;
        const el = document.getElementById(`pane-${payload.terminalId}`);
        if (!el) break;

        const matchedAgent = findOnlineAgentForDevice(closedPane);
        if (matchedAgent) {
          if (closedPane.claudeSessionId) {
            setDisconnectOverlay(el, 'resume');
          } else {
            setDisconnectOverlay(el, 'reconnect');
          }
        } else {
          setDisconnectOverlay(el, 'offline');
        }
        updateConnectionStatus(payload.terminalId, 'disconnected');
        break;
      }

      case 'claude:states':
        if (payload?._agentTs) {
          console.log(`[WS] claude:states received, agent→browser: ${Date.now() - payload._agentTs}ms`);
        }
        lastReceivedClaudeStates = payload;
        updateClaudeStates(payload);
        break;

      case 'agents:list':
        // Initial agent list from cloud on connect
        agents = payload;
        if (agents.length === 1) {
          activeAgentId = agents[0].agentId;
        } else if (agents.length > 1 && !activeAgentId) {
          activeAgentId = agents[0].agentId;  // auto-select first (default device for new panes)
        }
        updateAgentOverlay();
        updateAgentsHud();
        // Load panes from ALL online agents
        if (agents.some(a => a.online)) {
          loadTerminalsFromServer().catch(e => console.error('Failed to load panes:', e));
        }
        // Re-attach all existing terminal panes (agent may have restarted, clearing its activeTerminals)
        for (const pane of state.panes) {
          if (pane.type === 'terminal' && terminals.has(pane.id)) {
            const agent = agents.find(a => a.agentId === pane.agentId && a.online);
            if (agent) attachTerminal(pane);
          }
        }
        break;

      case 'agent:online': {
        // New agent connected
        console.log(`[DBG-AGENT] agent:online ${payload.agentId?.slice(0,8)} at ${Date.now()}`);
        const newAgentId = payload.agentId;
        // Cancel pending offline timer — agent reconnected before debounce fired
        if (window._agentOfflineTimers?.has(newAgentId)) {
          clearTimeout(window._agentOfflineTimers.get(newAgentId));
          window._agentOfflineTimers.delete(newAgentId);
        }
        agents = agents.filter(a => a.agentId !== newAgentId);
        // Insert in chronological order (by createdAt)
        const newAgent = { ...payload, online: true };
        const insertIdx = agents.findIndex(a => a.createdAt && newAgent.createdAt && a.createdAt > newAgent.createdAt);
        if (insertIdx === -1) {
          agents.push(newAgent);
        } else {
          agents.splice(insertIdx, 0, newAgent);
        }
        // Check if this agent was pending update and now has latest version
        const prevUpdate = agentUpdates.get(newAgentId);
        if (prevUpdate && !isAgentVersionOutdated(payload.version, prevUpdate.latestVersion)) {
          agentUpdates.delete(newAgentId);
          showUpdateCompleteToast(newAgentId, payload.hostname || newAgentId.slice(0, 8), payload.version);
        }
        if (!activeAgentId) {
          activeAgentId = newAgentId;
        }
        updateAgentOverlay();
        updateAgentsHud();
        // Remove offline placeholders for this agent — they'll be replaced by real panes
        const placeholders = state.panes.filter(p => p.agentId === newAgentId && p._offlinePlaceholder);
        if (placeholders.length > 0) {
          for (const ph of placeholders) {
            const el = document.getElementById(`pane-${ph.id}`);
            if (el) el.remove();
          }
          state.panes = state.panes.filter(p => !(p.agentId === newAgentId && p._offlinePlaceholder));
        }
        // Load panes from newly connected agent onto the canvas
        if (!state.panes.some(p => p.agentId === newAgentId)) {
          (async () => {
            try {
              let cloudLayoutMap = new Map();
              const cloudData = await cloudFetch('GET', '/api/layouts').catch(() => null);
              if (cloudData?.layouts?.length > 0) {
                cloudLayoutMap = new Map(cloudData.layouts.map(l => [l.id, l]));
              }
              await loadPanesFromAgent(newAgentId, cloudLayoutMap);
            } catch (e) {
              console.error('Failed to load panes from new agent:', e);
            }
          })();
        }
        // Remove offline styling and re-attach terminals for this agent's panes
        state.panes.filter(p => p.agentId === newAgentId).forEach(p => {
          const el = document.getElementById(`pane-${p.id}`);
          if (el) {
            el.classList.remove('agent-offline');
            setDisconnectOverlay(el, false);
            updateConnectionStatus(p.id, 'connecting');
          }
          // Re-send terminal:attach so the agent re-establishes ttyd connections
          if (p.type === 'terminal' && terminals.has(p.id)) {
            attachTerminal(p);
          }
        });
        break;
      }

      case 'agent:offline': {
        // Agent disconnected
        console.warn(`[DBG-AGENT] agent:offline ${payload.agentId?.slice(0,8)} at ${Date.now()} — panes will dim to 40% opacity!`);
        const offlineAgentId = payload.agentId;
        agents = agents.map(a =>
          a.agentId === offlineAgentId ? { ...a, online: false } : a
        );
        // If active agent went offline, try to select another
        if (activeAgentId === offlineAgentId) {
          const onlineAgent = agents.find(a => a.online);
          activeAgentId = onlineAgent?.agentId || null;
        }
        updateAgentOverlay();
        updateAgentsHud();
        // Mark panes belonging to the offline agent — debounced so brief
        // disconnects (agent relay churn) don't flash the UI.
        if (!window._agentOfflineTimers) window._agentOfflineTimers = new Map();
        {
          const existing = window._agentOfflineTimers.get(offlineAgentId);
          if (existing) clearTimeout(existing);
          window._agentOfflineTimers.set(offlineAgentId, setTimeout(() => {
            window._agentOfflineTimers.delete(offlineAgentId);
            // Only apply if agent is STILL offline
            const agent = agents.find(a => a.agentId === offlineAgentId);
            if (agent && !agent.online) {
              state.panes.filter(p => p.agentId === offlineAgentId).forEach(p => {
                const el = document.getElementById(`pane-${p.id}`);
                if (el) {
                  el.classList.add('agent-offline');
                  // Check if another online agent matches this pane's device
                  const alt = findOnlineAgentForDevice(p);
                  if (alt && p.type === 'terminal') {
                    setDisconnectOverlay(el, p.claudeSessionId ? 'resume' : 'reconnect');
                  } else {
                    setDisconnectOverlay(el, 'offline');
                  }
                  updateConnectionStatus(p.id, 'disconnected');
                }
              });
            }
          }, 5000));
        }
        break;
      }

      case 'update:available': {
        const { agentId: updateAgentId, currentVersion, latestVersion } = payload;
        agentUpdates.set(updateAgentId, { currentVersion, latestVersion });
        const agent = agents.find(a => a.agentId === updateAgentId);
        const hostname = agent?.hostname || updateAgentId.slice(0, 8);
        showUpdateToast(updateAgentId, hostname, currentVersion, latestVersion);
        updateAgentsHud();
        break;
      }

      case 'update:progress': {
        const { agentId: progAgentId, status: progStatus } = payload;
        const progAgent = agents.find(a => a.agentId === progAgentId);
        const progHostname = progAgent?.hostname || progAgentId.slice(0, 8);
        showUpdateProgressToast(progAgentId, progHostname, progStatus);
        updateAgentsHud();
        break;
      }

      case 'scan:partial': {
        // Streaming scan results — forward to registered callback
        const cb = pendingScanCallbacks.get(message.id);
        if (cb && payload?.repos) cb(payload.repos);
        break;
      }

      case 'response': {
        // REST-over-WS response
        pendingScanCallbacks.delete(message.id);
        const pending = pendingRequests.get(message.id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingRequests.delete(message.id);
          if (payload.status >= 400) {
            pending.reject(new Error(payload.body?.error || `HTTP ${payload.status}`));
          } else {
            pending.resolve(payload.body);
          }
        }
        break;
      }

      case 'tier:info':
        // Store tier info for UI display
        window.__tcTier = payload;
        break;

      case 'tier:limit':
        // Tier limit hit — show upgrade prompt
        showUpgradePrompt(payload.message);
        break;

      case 'notification:new':
        showAdminToast(payload);
        break;

      case 'notifications:pending':
        if (Array.isArray(payload)) {
          payload.forEach(n => showAdminToast(n));
        }
        break;

      case 'chat:message':
        if (window._chatHud) {
          const chatEl = document.getElementById('feedback-hud');
          const chatMsgList = chatEl?.querySelector('.chat-messages');
          if (chatMsgList) {
            const empty = chatMsgList.querySelector('.chat-empty');
            if (empty) empty.remove();
            window._chatHud.appendMessage(payload);
            window._chatHud.scrollToBottom();
          }
          if (!window._chatHud.isExpanded) {
            window._chatHud.unreadCount = window._chatHud.unreadCount + 1;
          } else {
            window._chatHud.markRead();
          }
        }
        break;

    }
  }

  // Show upgrade prompt with checkout button
  function showUpgradePrompt(message) {
    // Remove any existing prompt
    const existing = document.getElementById('upgrade-prompt');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'upgrade-prompt';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:100000;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#1a1a2e;border:1px solid #4ec9b0;border-radius:12px;padding:32px;max-width:420px;text-align:center;color:#e0e0e0;font-family:monospace;';

    dialog.innerHTML = `
      <div style="font-size:24px;margin-bottom:8px;">&#x26A1;</div>
      <h3 style="margin:0 0 12px;color:#4ec9b0;">Upgrade to Pro</h3>
      <p style="margin:0 0 20px;opacity:0.8;line-height:1.5;">${message}</p>
      <div style="display:flex;gap:12px;justify-content:center;">
        <button id="upgrade-checkout-btn" style="background:#4ec9b0;color:#0a0a1a;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-weight:bold;font-family:monospace;">Upgrade — $8/mo</button>
        <button id="upgrade-dismiss-btn" style="background:transparent;color:#6a6a8a;border:1px solid #6a6a8a;padding:10px 24px;border-radius:6px;cursor:pointer;font-family:monospace;">Maybe later</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    document.getElementById('upgrade-checkout-btn').addEventListener('click', async () => {
      try {
        const res = await fetch('/api/billing/checkout', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        const data = await res.json();
        if (data.checkoutUrl) {
          window.location.href = data.checkoutUrl;
        } else {
          showRelayNotification(data.error || 'Billing not available', 'warning', 3000);
          overlay.remove();
        }
      } catch (e) {
        showRelayNotification('Billing not available', 'warning', 3000);
        overlay.remove();
      }
    });

    document.getElementById('upgrade-dismiss-btn').addEventListener('click', () => {
      overlay.remove();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
  }

  // ============================================================================
  // SECTION 9: PREFERENCES & SETTINGS MODAL                      [Lines ~2390-2832]
  // User prefs (theme, font, canvas bg, night mode), settings modal UI,
  // theme/font pickers, hotkeys reference
  // ============================================================================

  // === Settings Modal ===
  let prefsSaveTimer = null;
  let currentCanvasBg = 'default';
  let currentTerminalFont = 'JetBrains Mono';

  // TERMINAL_FONTS, CANVAS_BACKGROUNDS — imported from modules/constants.js

  function getAllPrefs(overrides) {
    return {
      nightMode: !!document.getElementById('night-mode-overlay'),
      terminalTheme: currentTerminalTheme,
      notificationSound: notificationSoundEnabled,
      autoRemoveDone: autoRemoveDoneNotifs,
      canvasBg: currentCanvasBg,
      snoozeDuration: snoozeDurationMs / 1000,
      terminalFont: currentTerminalFont,
      focusMode: focusMode,
      hudState: {
        fleet_expanded: hudExpanded,
        agents_expanded: agentsHudExpanded,
        device_colors: deviceColorOverrides,
        hud_hidden: hudHidden,
      },
      tutorialsCompleted: tutorialsCompleted,
      projectsSidebarPosition: projectsSidebarPosition,
      teleportAnimation: teleportAnimation,
      ...overrides,
    };
  }

  // getTerminalFontFamily — imported from modules/utils.js

  function applyTerminalFont(fontName) {
    currentTerminalFont = fontName;
    const family = getTerminalFontFamily(fontName);
    terminals.forEach(({ xterm }) => {
      xterm.options.fontFamily = family;
    });
  }

  function savePrefsToCloud(overrides) {
    if (prefsSaveTimer) clearTimeout(prefsSaveTimer);
    prefsSaveTimer = setTimeout(() => {
      cloudFetch('PUT', '/api/preferences', getAllPrefs(overrides))
        .catch(e => console.error('[Prefs] Save failed:', e.message));
    }, 500);
  }

  function setCanvasBackground(key) {
    const bg = CANVAS_BACKGROUNDS[key] || CANVAS_BACKGROUNDS.default;
    currentCanvasBg = key;
    document.body.style.backgroundColor = bg.color;
    // Handle grid background
    if (bg.grid) {
      document.body.style.backgroundImage = 'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)';
      document.body.style.backgroundSize = '40px 40px';
    } else {
      document.body.style.backgroundImage = 'none';
      document.body.style.backgroundSize = '';
    }
  }

  function setNightMode(enabled) {
    let overlay = document.getElementById('night-mode-overlay');
    if (enabled && !overlay) {
      overlay = document.createElement('div');
      overlay.id = 'night-mode-overlay';
      document.body.appendChild(overlay);
    } else if (!enabled && overlay) {
      overlay.remove();
    }
  }

  function showSettingsModal() {
    _telemetry.track('feature.settings_open');
    const existing = document.getElementById('settings-modal');
    if (existing) { existing.remove(); return; }

    const user = window.__tcUser || {};
    const nightModeOn = !!document.getElementById('night-mode-overlay');

    const overlay = document.createElement('div');
    overlay.id = 'settings-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:100000;';

    const dialog = document.createElement('div');
    dialog.className = 'tc-scrollbar';
    dialog.style.cssText = 'background:#1a1a2e;border:1px solid rgba(var(--accent-rgb),0.3);border-radius:12px;padding:24px;max-width:400px;width:90%;color:#e0e0e0;font-family:Montserrat,sans-serif;max-height:80vh;overflow-y:auto;';

    // Helper: build a collapsible picker item
    function buildPickerItem(cls, dataAttr, dataVal, isSel, label, extra) {
      return `<div class="${cls}" data-${dataAttr}="${dataVal}" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;cursor:pointer;background:${isSel ? 'rgba(var(--accent-rgb),0.2)' : 'transparent'};border:1px solid ${isSel ? 'rgba(var(--accent-rgb),0.4)' : 'transparent'};transition:all 0.15s ease;">
        <span style="min-width:16px;text-align:center;font-size:12px;">${isSel ? '\u2713' : ''}</span>
        <span style="font-size:13px;flex:1;${extra || ''}">${label}</span>
      </div>`;
    }

    // Current theme/font info for collapsed preview
    const curTheme = TERMINAL_THEMES[currentTerminalTheme] || TERMINAL_THEMES.default || {};
    const curThemeDots = [curTheme.red, curTheme.green, curTheme.blue, curTheme.yellow, curTheme.magenta, curTheme.cyan].filter(Boolean)
      .map(c => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:2px;"></span>`).join('');

    dialog.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <h3 style="margin:0;font-size:16px;font-weight:400;color:#8b8bb0;">Settings</h3>
        <button id="settings-close-btn" style="background:none;border:none;color:#6a6a8a;font-size:20px;cursor:pointer;padding:4px 8px;border-radius:4px;line-height:1;">&times;</button>
      </div>

      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:14px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:12px;">
          ${user.avatar ? `<img src="${user.avatar}" style="width:40px;height:40px;border-radius:50%;border:1px solid rgba(255,255,255,0.1);" alt="">` : '<div style="width:40px;height:40px;border-radius:50%;background:rgba(var(--accent-rgb),0.3);display:flex;align-items:center;justify-content:center;font-size:18px;">U</div>'}
          <div style="flex:1;min-width:0;">
            <div style="font-size:14px;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${user.name || 'User'}</div>
            <div style="font-size:12px;color:#6a6a8a;">@${user.login || 'unknown'} &middot; <span style="color:${user.tier === 'poweruser' ? '#e0a0ff' : user.tier === 'pro' ? '#4ec9b0' : user.tier === 'team' ? '#569cd6' : '#6a6a8a'};text-transform:uppercase;font-size:10px;letter-spacing:0.5px;">${user.tier || 'free'}</span></div>
          </div>
          <button id="settings-logout-btn" style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);color:#ef4444;font-size:11px;padding:5px 12px;border-radius:6px;cursor:pointer;font-family:inherit;white-space:nowrap;">Logout</button>
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
        <div>
          <div style="font-size:13px;">Night Mode</div>
          <div style="font-size:11px;color:#6a6a8a;">Red overlay for low-light use</div>
        </div>
        <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;">
          <input type="checkbox" id="settings-night-toggle" ${nightModeOn ? 'checked' : ''} style="opacity:0;width:0;height:0;">
          <span style="position:absolute;inset:0;background:${nightModeOn ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.1)'};border-radius:11px;transition:0.2s;"></span>
          <span style="position:absolute;top:2px;left:${nightModeOn ? '20px' : '2px'};width:18px;height:18px;background:#fff;border-radius:50%;transition:0.2s;"></span>
        </label>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
        <div>
          <div style="font-size:13px;">Notification Sound</div>
          <div style="font-size:11px;color:#6a6a8a;">Play sound on state changes</div>
        </div>
        <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;">
          <input type="checkbox" id="settings-sound-toggle" ${notificationSoundEnabled ? 'checked' : ''} style="opacity:0;width:0;height:0;">
          <span style="position:absolute;inset:0;background:${notificationSoundEnabled ? 'rgba(var(--accent-rgb),0.5)' : 'rgba(255,255,255,0.1)'};border-radius:11px;transition:0.2s;"></span>
          <span style="position:absolute;top:2px;left:${notificationSoundEnabled ? '20px' : '2px'};width:18px;height:18px;background:#fff;border-radius:50%;transition:0.2s;"></span>
        </label>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
        <div>
          <div style="font-size:13px;">Auto-Remove Done Notifications</div>
          <div style="font-size:11px;color:#6a6a8a;">Automatically dismiss "Task complete" after 15s</div>
        </div>
        <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;">
          <input type="checkbox" id="settings-auto-remove-done-toggle" ${autoRemoveDoneNotifs ? 'checked' : ''} style="opacity:0;width:0;height:0;">
          <span style="position:absolute;inset:0;background:${autoRemoveDoneNotifs ? 'rgba(var(--accent-rgb),0.5)' : 'rgba(255,255,255,0.1)'};border-radius:11px;transition:0.2s;"></span>
          <span style="position:absolute;top:2px;left:${autoRemoveDoneNotifs ? '20px' : '2px'};width:18px;height:18px;background:#fff;border-radius:50%;transition:0.2s;"></span>
        </label>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
        <div>
          <div style="font-size:13px;">Focus on Hover</div>
          <div style="font-size:11px;color:#6a6a8a;">Hover to focus panes (off = click to focus)</div>
        </div>
        <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;">
          <input type="checkbox" id="settings-focus-mode-toggle" ${focusMode === 'hover' ? 'checked' : ''} style="opacity:0;width:0;height:0;">
          <span style="position:absolute;inset:0;background:${focusMode === 'hover' ? 'rgba(var(--accent-rgb),0.5)' : 'rgba(255,255,255,0.1)'};border-radius:11px;transition:0.2s;"></span>
          <span style="position:absolute;top:2px;left:${focusMode === 'hover' ? '20px' : '2px'};width:18px;height:18px;background:#fff;border-radius:50%;transition:0.2s;"></span>
        </label>
      </div>

      <div id="settings-telemetry-row" style="display:none;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
        <div>
          <div style="font-size:13px;">Usage Telemetry</div>
          <div style="font-size:11px;color:#6a6a8a;">Send anonymous usage data to improve 49Agents</div>
        </div>
        <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;">
          <input type="checkbox" id="settings-telemetry-toggle" style="opacity:0;width:0;height:0;">
          <span style="position:absolute;inset:0;background:rgba(255,255,255,0.1);border-radius:11px;transition:0.2s;"></span>
          <span style="position:absolute;top:2px;left:2px;width:18px;height:18px;background:#fff;border-radius:50%;transition:0.2s;"></span>
        </label>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
        <div>
          <div style="font-size:13px;">Teleport Animation</div>
          <div style="font-size:11px;color:#6a6a8a;">Animate when jumping to projects/checkpoints</div>
        </div>
        <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;">
          <input type="checkbox" id="settings-teleport-anim-toggle" ${teleportAnimation ? 'checked' : ''} style="opacity:0;width:0;height:0;">
          <span style="position:absolute;inset:0;background:${teleportAnimation ? 'rgba(var(--accent-rgb),0.5)' : 'rgba(255,255,255,0.1)'};border-radius:11px;transition:0.2s;"></span>
          <span style="position:absolute;top:2px;left:${teleportAnimation ? '20px' : '2px'};width:18px;height:18px;background:#fff;border-radius:50%;transition:0.2s;"></span>
        </label>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
        <div>
          <div style="font-size:13px;">Projects Sidebar Position</div>
          <div style="font-size:11px;color:#6a6a8a;">Where the sidebar appears (Tab+P)</div>
        </div>
        <div id="settings-sidebar-pos" style="display:flex;gap:4px;">
          ${['left', 'right'].map(pos => `<button class="settings-sidebar-pos-btn" data-pos="${pos}" style="padding:4px 10px;border-radius:4px;border:1px solid ${projectsSidebarPosition === pos ? 'rgba(var(--accent-rgb),0.4)' : 'rgba(255,255,255,0.08)'};background:${projectsSidebarPosition === pos ? 'rgba(var(--accent-rgb),0.2)' : 'transparent'};color:${projectsSidebarPosition === pos ? '#fff' : '#8b8bb0'};font-size:11px;cursor:pointer;font-family:inherit;">${pos}</button>`).join('')}
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
        <div>
          <div style="font-size:13px;">Snooze Duration</div>
          <div style="font-size:11px;color:#6a6a8a;">How long to mute per terminal</div>
        </div>
        <span id="settings-snooze-slot"></span>
      </div>

      <div style="padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
        <div style="font-size:13px;margin-bottom:8px;">Canvas Background</div>
        <div id="settings-bg-list" style="display:flex;gap:6px;flex-wrap:wrap;">
          ${Object.entries(CANVAS_BACKGROUNDS).map(([key, bg]) => {
            const isSel = key === currentCanvasBg;
            return `<div class="settings-bg-item" data-bg="${key}" style="display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:6px;cursor:pointer;background:${isSel ? 'rgba(var(--accent-rgb),0.2)' : 'rgba(255,255,255,0.03)'};border:1px solid ${isSel ? 'rgba(var(--accent-rgb),0.4)' : 'rgba(255,255,255,0.06)'};transition:all 0.15s ease;">
              <span style="width:16px;height:16px;border-radius:4px;border:1px solid rgba(255,255,255,0.15);background:${bg.color};${bg.grid ? 'background-image:linear-gradient(rgba(255,255,255,0.1) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.1) 1px,transparent 1px);background-size:4px 4px;' : ''}"></span>
              <span style="font-size:12px;">${bg.name}</span>
            </div>`;
          }).join('')}
        </div>
      </div>

      <div style="padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
        <div id="settings-theme-header" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;">
          <div style="font-size:13px;">Terminal Theme</div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="display:flex;gap:1px;">${curThemeDots}</span>
            <span style="font-size:12px;color:#6a6a8a;">${curTheme.name || currentTerminalTheme}</span>
            <span id="settings-theme-arrow" style="font-size:10px;color:#6a6a8a;transition:transform 0.2s;">\u25B6</span>
          </div>
        </div>
        <div id="settings-theme-body" style="display:none;margin-top:8px;">
          <input id="settings-theme-search" type="text" placeholder="Search themes..." style="width:100%;padding:5px 8px;margin-bottom:6px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:6px;color:#e0e0e0;font-size:12px;font-family:inherit;outline:none;box-sizing:border-box;" />
          <div id="settings-theme-list" style="max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;"></div>
        </div>
      </div>

      <div style="padding:12px 0;">
        <div id="settings-font-header" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;">
          <div style="font-size:13px;">Terminal Font</div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:12px;color:#6a6a8a;font-family:'${currentTerminalFont}',monospace;">${currentTerminalFont}</span>
            <span id="settings-font-arrow" style="font-size:10px;color:#6a6a8a;transition:transform 0.2s;">\u25B6</span>
          </div>
        </div>
        <div id="settings-font-body" style="display:none;margin-top:8px;">
          <input id="settings-font-search" type="text" placeholder="Search fonts..." style="width:100%;padding:5px 8px;margin-bottom:6px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:6px;color:#e0e0e0;font-size:12px;font-family:inherit;outline:none;box-sizing:border-box;" />
          <div id="settings-font-list" style="max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;"></div>
        </div>
      </div>

      <div style="padding:12px 0;border-top:1px solid rgba(255,255,255,0.06);">
        <div id="settings-hotkeys-header" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;">
          <div style="font-size:13px;">Keyboard Shortcuts</div>
          <span id="settings-hotkeys-arrow" style="font-size:10px;color:#6a6a8a;transition:transform 0.2s;">\u25B6</span>
        </div>
        <div id="settings-hotkeys-body" style="display:none;margin-top:10px;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;">
          <kbd style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-family:inherit;color:#ccc;">Tab Q</kbd><span style="color:#9999b8;">Cycle terminals</span>
          <kbd style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-family:inherit;color:#ccc;">Tab A</kbd><span style="color:#9999b8;">Add menu</span>
          <kbd style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-family:inherit;color:#ccc;">Tab D</kbd><span style="color:#9999b8;">Toggle fleet pane</span>
          <kbd style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-family:inherit;color:#ccc;">Tab U</kbd><span style="color:#9999b8;">Toggle usage pane</span>
          <kbd style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-family:inherit;color:#ccc;">Tab S</kbd><span style="color:#9999b8;">Settings</span>
          <kbd style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-family:inherit;color:#ccc;">Tab W</kbd><span style="color:#9999b8;">Close pane (all if broadcast)</span>
          <kbd style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-family:inherit;color:#ccc;">Shift+Click</kbd><span style="color:#9999b8;">Broadcast select</span>
          <kbd style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-family:inherit;color:#ccc;">Esc</kbd><span style="color:#9999b8;">Clear broadcast / cancel</span>
          <kbd style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-family:inherit;color:#ccc;">Ctrl+Shift+2</kbd><span style="color:#9999b8;">Mention</span>
          <kbd style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-family:inherit;color:#ccc;">Tab Tab</kbd><span style="color:#9999b8;">Enter move mode</span>
          <div style="grid-column:1/3;padding:4px 0 2px 8px;color:#7a7a9a;font-size:11px;border-left:2px solid rgba(255,255,255,0.06);">
            <div style="margin-bottom:3px;"><kbd style="background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:3px;font-family:inherit;color:#aaa;font-size:11px;">WASD</kbd> / <kbd style="background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:3px;font-family:inherit;color:#aaa;font-size:11px;">Arrows</kbd> Navigate between panes</div>
            <div style="margin-bottom:3px;"><kbd style="background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:3px;font-family:inherit;color:#aaa;font-size:11px;">Enter</kbd> / <kbd style="background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:3px;font-family:inherit;color:#aaa;font-size:11px;">Tab</kbd> Select pane &amp; keep zoom</div>
            <div><kbd style="background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:3px;font-family:inherit;color:#aaa;font-size:11px;">Esc</kbd> Cancel &amp; restore original zoom</div>
          </div>
          <kbd style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-family:inherit;color:#ccc;">Ctrl+Scroll</kbd><span style="color:#9999b8;">Zoom canvas</span>
          <kbd style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-family:inherit;color:#ccc;">Scroll</kbd><span style="color:#9999b8;">Pan canvas / scroll terminal</span>
          <kbd style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-family:inherit;color:#ccc;">Ctrl +/-/0</kbd><span style="color:#9999b8;">Zoom pane (focused) or canvas</span>
          <kbd style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-family:inherit;color:#ccc;">Shift+Scroll</kbd><span style="color:#9999b8;">Pan canvas (over panes)</span>
          <kbd style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-family:inherit;color:#ccc;">Middle-drag</kbd><span style="color:#9999b8;">Pan canvas (anywhere)</span>
        </div>
      </div>

      <div style="padding-top:14px;text-align:center;">
        <span style="font-size:10px;color:#3a3a5a;letter-spacing:0.5px;">49agents v${APP_VERSION}</span>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Close handlers
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('settings-close-btn').addEventListener('click', close);

    // Escape key
    const escHandler = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);

    // Logout
    document.getElementById('settings-logout-btn').addEventListener('click', async () => {
      try { await fetch('/auth/logout', { method: 'POST', credentials: 'include' }); } catch(e) {}
      window.location.href = '/login';
    });

    // Night mode toggle
    const nightToggle = document.getElementById('settings-night-toggle');
    nightToggle.addEventListener('change', () => {
      const on = nightToggle.checked;
      setNightMode(on);
      // Update toggle visual
      const track = nightToggle.nextElementSibling;
      const knob = track.nextElementSibling;
      track.style.background = on ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.1)';
      knob.style.left = on ? '20px' : '2px';
      savePrefsToCloud({ nightMode: on });
    });

    // Sound toggle
    const soundToggle = document.getElementById('settings-sound-toggle');
    soundToggle.addEventListener('change', () => {
      const on = soundToggle.checked;
      notificationSoundEnabled = on;
      _setSoundEnabled(on);
      const track = soundToggle.nextElementSibling;
      const knob = track.nextElementSibling;
      track.style.background = on ? 'rgba(var(--accent-rgb),0.5)' : 'rgba(255,255,255,0.1)';
      knob.style.left = on ? '20px' : '2px';
      savePrefsToCloud({ notificationSound: on });
    });

    // Auto-remove done notifications toggle
    const autoRemoveToggle = document.getElementById('settings-auto-remove-done-toggle');
    autoRemoveToggle.addEventListener('change', () => {
      const on = autoRemoveToggle.checked;
      autoRemoveDoneNotifs = on;
      const track = autoRemoveToggle.nextElementSibling;
      const knob = track.nextElementSibling;
      track.style.background = on ? 'rgba(var(--accent-rgb),0.5)' : 'rgba(255,255,255,0.1)';
      knob.style.left = on ? '20px' : '2px';
      savePrefsToCloud({ autoRemoveDone: on });
    });

    // Focus mode toggle (hover vs click)
    const focusModeToggle = document.getElementById('settings-focus-mode-toggle');
    focusModeToggle.addEventListener('change', () => {
      const hover = focusModeToggle.checked;
      focusMode = hover ? 'hover' : 'click';
      const track = focusModeToggle.nextElementSibling;
      const knob = track.nextElementSibling;
      track.style.background = hover ? 'rgba(var(--accent-rgb),0.5)' : 'rgba(255,255,255,0.1)';
      knob.style.left = hover ? '20px' : '2px';
      savePrefsToCloud({ focusMode: focusMode });
    });

    // Teleport animation toggle
    const teleportAnimToggle = document.getElementById('settings-teleport-anim-toggle');
    teleportAnimToggle.addEventListener('change', () => {
      const on = teleportAnimToggle.checked;
      teleportAnimation = on;
      const track = teleportAnimToggle.nextElementSibling;
      const knob = track.nextElementSibling;
      track.style.background = on ? 'rgba(var(--accent-rgb),0.5)' : 'rgba(255,255,255,0.1)';
      knob.style.left = on ? '20px' : '2px';
      savePrefsToCloud({ teleportAnimation: on });
    });

    // Sidebar position buttons
    document.querySelectorAll('.settings-sidebar-pos-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        projectsSidebarPosition = btn.dataset.pos;
        // Update button styles
        document.querySelectorAll('.settings-sidebar-pos-btn').forEach(b => {
          const isSel = b.dataset.pos === projectsSidebarPosition;
          b.style.borderColor = isSel ? 'rgba(var(--accent-rgb),0.4)' : 'rgba(255,255,255,0.08)';
          b.style.background = isSel ? 'rgba(var(--accent-rgb),0.2)' : 'transparent';
          b.style.color = isSel ? '#fff' : '#8b8bb0';
        });
        applyProjectsSidebarPosition();
        savePrefsToCloud({ projectsSidebarPosition: projectsSidebarPosition });
      });
    });

    // Telemetry toggle (local mode only)
    fetch('/api/auth/mode').then(r => r.json()).then(mode => {
      if (mode.mode !== 'local') return;
      const row = document.getElementById('settings-telemetry-row');
      if (!row) return;
      row.style.display = 'flex';
      const toggle = document.getElementById('settings-telemetry-toggle');
      const track = toggle.nextElementSibling;
      const knob = track.nextElementSibling;
      // Load current consent state
      fetch('/api/auth/telemetry-consent', { credentials: 'include' })
        .then(r => r.json())
        .then(data => {
          toggle.checked = data.consent;
          track.style.background = data.consent ? 'rgba(var(--accent-rgb),0.5)' : 'rgba(255,255,255,0.1)';
          knob.style.left = data.consent ? '20px' : '2px';
        }).catch(() => {});
      // Handle toggle changes
      toggle.addEventListener('change', () => {
        const on = toggle.checked;
        track.style.background = on ? 'rgba(var(--accent-rgb),0.5)' : 'rgba(255,255,255,0.1)';
        knob.style.left = on ? '20px' : '2px';
        fetch('/api/auth/telemetry-consent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ consent: on }),
          credentials: 'include',
        }).catch(() => {});
      });
    }).catch(() => {});

    // Snooze duration — custom dropdown
    const snoozeSlot = document.getElementById('settings-snooze-slot');
    const snoozeSelect = createCustomSelect(
      [
        { value: '30', label: '30s' },
        { value: '60', label: '60s' },
        { value: '90', label: '90s' },
        { value: '300', label: '5min' },
        { value: '600', label: '10min' }
      ],
      String(snoozeDurationMs / 1000),
      (val) => {
        snoozeDurationMs = parseInt(val) * 1000;
        savePrefsToCloud({ snoozeDuration: parseInt(val) });
      }
    );
    snoozeSlot.appendChild(snoozeSelect.el);

    // Canvas background selection
    document.getElementById('settings-bg-list').addEventListener('click', (e) => {
      const item = e.target.closest('.settings-bg-item');
      if (!item) return;
      const bgKey = item.dataset.bg;
      setCanvasBackground(bgKey);
      document.querySelectorAll('.settings-bg-item').forEach(el => {
        const isSel = el.dataset.bg === bgKey;
        el.style.background = isSel ? 'rgba(var(--accent-rgb),0.2)' : 'rgba(255,255,255,0.03)';
        el.style.borderColor = isSel ? 'rgba(var(--accent-rgb),0.4)' : 'rgba(255,255,255,0.06)';
      });
      savePrefsToCloud({ canvasBg: bgKey });
    });

    // === Collapsible Theme Picker ===
    const themeBody = document.getElementById('settings-theme-body');
    const themeArrow = document.getElementById('settings-theme-arrow');
    const themeSearch = document.getElementById('settings-theme-search');
    const themeList = document.getElementById('settings-theme-list');

    function renderThemeList(filter) {
      const f = (filter || '').toLowerCase();
      let html = '';
      for (const [key, t] of Object.entries(TERMINAL_THEMES)) {
        if (f && !t.name.toLowerCase().includes(f) && !key.includes(f)) continue;
        const isSel = key === currentTerminalTheme;
        const dots = [t.red, t.green, t.blue, t.yellow, t.magenta, t.cyan].filter(Boolean)
          .map(c => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:2px;"></span>`).join('');
        html += `<div class="settings-theme-item" data-theme="${key}" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;cursor:pointer;background:${isSel ? 'rgba(var(--accent-rgb),0.2)' : 'transparent'};border:1px solid ${isSel ? 'rgba(var(--accent-rgb),0.4)' : 'transparent'};transition:all 0.15s ease;">
          <span style="min-width:16px;text-align:center;font-size:12px;">${isSel ? '\u2713' : ''}</span>
          <span style="font-size:13px;flex:1;">${t.name}</span>
          <span style="display:flex;gap:1px;">${dots}</span>
        </div>`;
      }
      themeList.innerHTML = html || '<div style="font-size:12px;color:#6a6a8a;padding:6px;">No matching themes</div>';
    }

    document.getElementById('settings-theme-header').addEventListener('click', () => {
      const open = themeBody.style.display === 'none';
      themeBody.style.display = open ? 'block' : 'none';
      themeArrow.style.transform = open ? 'rotate(90deg)' : 'rotate(0deg)';
      if (open) { renderThemeList(''); themeSearch.value = ''; themeSearch.focus(); }
    });

    themeSearch.addEventListener('input', (e) => renderThemeList(e.target.value));
    themeSearch.addEventListener('click', (e) => e.stopPropagation());

    themeList.addEventListener('click', (e) => {
      const item = e.target.closest('.settings-theme-item');
      if (!item) return;
      const themeKey = item.dataset.theme;
      applyTerminalTheme(themeKey);
      _telemetry.track('feature.theme_change', { theme_name: themeKey });
      renderThemeList(themeSearch.value);
      // Update collapsed preview
      const t = TERMINAL_THEMES[themeKey] || {};
      const headerPreview = document.getElementById('settings-theme-header').querySelector('div:last-child');
      const dots = [t.red, t.green, t.blue, t.yellow, t.magenta, t.cyan].filter(Boolean)
        .map(c => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:2px;"></span>`).join('');
      headerPreview.innerHTML = `<span style="display:flex;gap:1px;">${dots}</span><span style="font-size:12px;color:#6a6a8a;">${t.name}</span><span id="settings-theme-arrow" style="font-size:10px;color:#6a6a8a;transform:rotate(90deg);transition:transform 0.2s;">\u25B6</span>`;
      savePrefsToCloud({ terminalTheme: themeKey });
    });

    // === Collapsible Font Picker ===
    const fontBody = document.getElementById('settings-font-body');
    const fontArrow = document.getElementById('settings-font-arrow');
    const fontSearch = document.getElementById('settings-font-search');
    const fontList = document.getElementById('settings-font-list');

    function renderFontList(filter) {
      const f = (filter || '').toLowerCase();
      let html = '';
      for (const font of TERMINAL_FONTS) {
        if (f && !font.toLowerCase().includes(f)) continue;
        const isSel = font === currentTerminalFont;
        html += `<div class="settings-font-item" data-font="${font}" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;cursor:pointer;background:${isSel ? 'rgba(var(--accent-rgb),0.2)' : 'transparent'};border:1px solid ${isSel ? 'rgba(var(--accent-rgb),0.4)' : 'transparent'};transition:all 0.15s ease;">
          <span style="min-width:16px;text-align:center;font-size:12px;">${isSel ? '\u2713' : ''}</span>
          <span style="font-size:13px;font-family:'${font}',monospace;">${font}</span>
        </div>`;
      }
      fontList.innerHTML = html || '<div style="font-size:12px;color:#6a6a8a;padding:6px;">No matching fonts</div>';
    }

    document.getElementById('settings-font-header').addEventListener('click', () => {
      const open = fontBody.style.display === 'none';
      fontBody.style.display = open ? 'block' : 'none';
      fontArrow.style.transform = open ? 'rotate(90deg)' : 'rotate(0deg)';
      if (open) { renderFontList(''); fontSearch.value = ''; fontSearch.focus(); }
    });

    fontSearch.addEventListener('input', (e) => renderFontList(e.target.value));
    fontSearch.addEventListener('click', (e) => e.stopPropagation());

    fontList.addEventListener('click', (e) => {
      const item = e.target.closest('.settings-font-item');
      if (!item) return;
      const fontName = item.dataset.font;
      applyTerminalFont(fontName);
      renderFontList(fontSearch.value);
      // Update collapsed preview
      const headerPreview = document.getElementById('settings-font-header').querySelector('div:last-child');
      headerPreview.innerHTML = `<span style="font-size:12px;color:#6a6a8a;font-family:'${fontName}',monospace;">${fontName}</span><span id="settings-font-arrow" style="font-size:10px;color:#6a6a8a;transform:rotate(90deg);transition:transform 0.2s;">\u25B6</span>`;
      savePrefsToCloud({ terminalFont: fontName });
    });

    // === Collapsible Keyboard Shortcuts ===
    const hotkeysBody = document.getElementById('settings-hotkeys-body');
    const hotkeysArrow = document.getElementById('settings-hotkeys-arrow');
    document.getElementById('settings-hotkeys-header').addEventListener('click', () => {
      const open = hotkeysBody.style.display === 'none';
      hotkeysBody.style.display = open ? 'grid' : 'none';
      hotkeysArrow.style.transform = open ? 'rotate(90deg)' : 'rotate(0deg)';
    });
  }

  // ============================================================================
  // SECTION 10: WS HELPERS & AGENT MANAGEMENT                    [Lines ~2835-3210]
  // sendWs(), relay notifications, agent update toasts, add-machine dialog,
  // agent overlay, device helpers
  // ============================================================================

  // Send WebSocket message (agentId defaults to activeAgentId for backward compat)
  function sendWs(type, payload, agentId) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload, agentId: agentId || activeAgentId }));
      if (type === 'terminal:input') _telemetry._terminalInputCount++;
    }
  }

  // Simple notification for relay messages (tier limits, etc.)
  function showRelayNotification(message, type, duration) {
    const el = document.createElement('div');
    el.style.cssText = `position:fixed; top:20px; left:50%; transform:translateX(-50%); z-index:100001; background:${type === 'warning' ? '#b58900' : '#333'}; color:#fff; padding:10px 20px; border-radius:8px; font-size:13px; font-family:inherit; box-shadow:0 4px 20px rgba(0,0,0,0.4); pointer-events:auto;`;
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => { el.remove(); }, duration || 5000);
  }

  async function fetchInstallCommand(hostname, platform = 'linux') {
    const res = await fetch('/api/agents/token', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostname, os: platform === 'windows' ? 'windows' : 'linux' })
    });
    const data = await res.json();
    if (!data.token) throw new Error(data.error || 'Unknown');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (platform === 'windows') {
      return `$env:TC_TOKEN="${data.token}"; irm ${location.origin}/dl/install.ps1 | iex`;
    }
    return `curl -fsSL ${location.origin}/dl/install.sh | TC_TOKEN=${data.token} TC_CLOUD_URL=${proto}//${location.host} sh`;
  }

  // --- Agent Update Notification Helpers ---

  // isAgentVersionOutdated — imported from modules/utils.js

  function showUpdateToast(agentId, hostname, currentVersion, latestVersion) {
    // Remove any existing update toast for this agent
    const existingToast = document.querySelector(`.update-toast[data-agent-id="${agentId}"]`);
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.className = 'notification-toast update-toast visible';
    toast.dataset.agentId = agentId;
    toast.style.borderLeft = '3px solid #f59e0b';
    toast.innerHTML = `
      <div class="notification-icon" style="color:#f59e0b;">⬆</div>
      <div class="notification-body">
        <div class="notification-title">Update available for ${escapeHtml(hostname)}</div>
        <div class="notification-device">v${escapeHtml(currentVersion)} → v${escapeHtml(latestVersion)}</div>
      </div>
      <button class="update-now-btn" style="background:#f59e0b;color:#000;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-family:monospace;font-size:11px;font-weight:bold;white-space:nowrap;margin-left:8px;">Update</button>
      <button class="notification-dismiss" title="Dismiss">&times;</button>
    `;

    const updateBtn = toast.querySelector('.update-now-btn');
    updateBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerAgentUpdate(agentId);
      updateBtn.textContent = 'Updating...';
      updateBtn.disabled = true;
      updateBtn.style.opacity = '0.6';
    });

    const dismissBtn = toast.querySelector('.notification-dismiss');
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toast.classList.add('dismissing');
      setTimeout(() => toast.remove(), 300);
    });

    if (getNotificationContainer()) {
      getNotificationContainer().prepend(toast);
    }
  }

  function showUpdateProgressToast(agentId, hostname, status) {
    const existingToast = document.querySelector(`.update-toast[data-agent-id="${agentId}"]`);
    const statusText = {
      downloading: 'Downloading update...',
      installing: 'Installing update...',
      restarting: 'Restarting agent...',
      failed: 'Update failed!',
    }[status] || status;

    if (existingToast) {
      const titleEl = existingToast.querySelector('.notification-title');
      const deviceEl = existingToast.querySelector('.notification-device');
      if (titleEl) titleEl.textContent = `${hostname}: ${statusText}`;
      if (deviceEl) deviceEl.textContent = status === 'failed' ? 'Please try again later' : '';
      const btn = existingToast.querySelector('.update-now-btn');
      if (btn) btn.style.display = 'none';
      if (status === 'failed') {
        existingToast.style.borderLeftColor = '#ef4444';
        const icon = existingToast.querySelector('.notification-icon');
        if (icon) { icon.textContent = '✗'; icon.style.color = '#ef4444'; }
        setTimeout(() => {
          existingToast.classList.add('dismissing');
          setTimeout(() => existingToast.remove(), 300);
        }, 5000);
      }
    }
  }

  function showUpdateCompleteToast(agentId, hostname, newVersion) {
    // Remove progress toast
    const existingToast = document.querySelector(`.update-toast[data-agent-id="${agentId}"]`);
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.className = 'notification-toast update-toast visible';
    toast.dataset.agentId = agentId;
    toast.style.borderLeft = '3px solid #10b981';
    toast.innerHTML = `
      <div class="notification-icon" style="color:#10b981;">✓</div>
      <div class="notification-body">
        <div class="notification-title">${escapeHtml(hostname)} updated</div>
        <div class="notification-device">Now running v${escapeHtml(newVersion)}</div>
      </div>
      <button class="notification-dismiss" title="Dismiss">&times;</button>
    `;

    const dismissBtn = toast.querySelector('.notification-dismiss');
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toast.classList.add('dismissing');
      setTimeout(() => toast.remove(), 300);
    });

    if (getNotificationContainer()) {
      getNotificationContainer().prepend(toast);
    }

    // Auto-dismiss after 8 seconds
    setTimeout(() => {
      if (toast.parentNode) {
        toast.classList.add('dismissing');
        setTimeout(() => toast.remove(), 300);
      }
    }, 8000);
  }

  function triggerAgentUpdate(agentId) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'update:install',
        agentId,
        payload: {},
      }));
    }
  }

  // "Connect a Machine" overlay
  function updateAgentOverlay() {
    let overlay = document.getElementById('agent-connect-overlay');
    const hasOnlineAgents = agents.some(a => a.online);

    // Suppress overlay when tutorial hasn't been completed (user will be redirected)
    const tutorialState = localStorage.getItem('tc_tutorial');
    if (!hasOnlineAgents && !tutorialState && !tutorialsCompleted['getting-started']) {
      if (overlay) overlay.style.display = 'none';
      return;
    }

    if (!hasOnlineAgents) {
      // Instead of auto-popup overlay, highlight the HUD add-machine button
      if (overlay) overlay.style.display = 'none';
      pulseAddMachineButton(true);
    } else {
      if (overlay) {
        overlay.style.display = 'none';
      }
      pulseAddMachineButton(false);
    }
  }

  // Inject pulse animation style once
  let pulseStyleInjected = false;
  function injectPulseStyle() {
    if (pulseStyleInjected) return;
    pulseStyleInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      @keyframes addMachinePulse {
        0% { box-shadow: 0 0 4px rgba(78, 201, 176, 0.4), 0 0 8px rgba(78, 201, 176, 0.2); }
        50% { box-shadow: 0 0 12px rgba(78, 201, 176, 0.7), 0 0 24px rgba(78, 201, 176, 0.3); }
        100% { box-shadow: 0 0 4px rgba(78, 201, 176, 0.4), 0 0 8px rgba(78, 201, 176, 0.2); }
      }
      .add-machine-fleet-btn.pulsing {
        animation: addMachinePulse 2s ease-in-out infinite !important;
        background: #4ec9b0 !important;
        border: 1px solid rgba(78, 201, 176, 0.6) !important;
        font-weight: 700 !important;
        transform: scale(1.02);
        transition: transform 0.2s ease;
      }
      .add-machine-fleet-btn.pulsing:hover {
        transform: scale(1.06);
        animation: none !important;
        box-shadow: 0 0 16px rgba(78, 201, 176, 0.8), 0 0 32px rgba(78, 201, 176, 0.4) !important;
      }
    `;
    document.head.appendChild(style);
  }

  function pulseAddMachineButton(enable) {
    if (enable) injectPulseStyle();
    // The HUD fleet button gets re-rendered, so we set a flag and apply in renderHud
    window.__pulseAddMachine = enable;
    // Also apply immediately if the button exists
    const btn = document.querySelector('.add-machine-fleet-btn');
    if (btn) {
      if (enable) btn.classList.add('pulsing');
      else btn.classList.remove('pulsing');
    }
  }

  // Show "Add Machine" dialog (can be called from HUD even when agents are connected)
  function showAddMachineDialog() {
    // Reuse the overlay logic but force-show it
    let overlay = document.getElementById('add-machine-overlay');
    if (overlay) { overlay.remove(); }

    overlay = document.createElement('div');
    overlay.id = 'add-machine-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:100000;';

    const card = document.createElement('div');
    card.style.cssText = 'background:#1a1a2e;border:1px solid #4ec9b0;border-radius:12px;padding:32px;max-width:560px;width:90%;color:#e0e0e0;font-family:monospace;';
    card.innerHTML = `
      <h3 style="margin:0 0 12px;color:#4ec9b0;">Add Machine</h3>
      <p style="opacity:0.8;margin:0 0 16px;">Copy the command below and paste it on the target machine.</p>
      <div style="margin-bottom:12px;">
        <label style="display:block;margin-bottom:4px;opacity:0.6;font-size:12px;">Platform</label>
        <div id="add-machine-platform" style="display:flex;gap:0;margin-bottom:12px;">
          <button data-platform="linux" style="flex:1;padding:8px;background:#4ec9b0;color:#0a0a1a;border:1px solid #4ec9b0;border-radius:4px 0 0 4px;cursor:pointer;font-family:monospace;font-size:12px;font-weight:bold;">Linux / macOS</button>
          <button data-platform="windows" style="flex:1;padding:8px;background:transparent;color:#6a6a8a;border:1px solid #333;border-radius:0 4px 4px 0;cursor:pointer;font-family:monospace;font-size:12px;">Windows (WSL2)</button>
        </div>
      </div>
      <div id="add-machine-cmd-box" style="margin-bottom:12px;">
        <label style="display:block;margin-bottom:4px;opacity:0.6;font-size:12px;">Install Command</label>
        <code id="add-machine-cmd" style="display:block;padding:12px;background:#0a0a1a;border-radius:6px;word-break:break-all;font-size:11px;cursor:pointer;user-select:all;border:1px solid #333;opacity:0.5;">Generating...</code>
      </div>
      <div style="display:flex;gap:12px;">
        <button id="add-machine-copy" style="background:transparent;color:#4ec9b0;border:1px solid #4ec9b0;padding:10px 24px;border-radius:6px;cursor:pointer;font-family:monospace;display:none;">Copy</button>
        <button id="add-machine-close" style="background:transparent;color:#6a6a8a;border:1px solid #6a6a8a;padding:10px 24px;border-radius:6px;cursor:pointer;font-family:monospace;margin-left:auto;">Close</button>
      </div>
    `;
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const copyBtn = document.getElementById('add-machine-copy');
    const closeBtn = document.getElementById('add-machine-close');

    copyBtn.style.transition = 'background 0.15s, color 0.15s, transform 0.1s';
    copyBtn.addEventListener('mouseenter', () => { copyBtn.style.background = '#4ec9b0'; copyBtn.style.color = '#0a0a1a'; copyBtn.style.transform = 'scale(1.03)'; });
    copyBtn.addEventListener('mouseleave', () => {
      if (!copyBtn.dataset.copied) { copyBtn.style.background = 'transparent'; copyBtn.style.color = '#4ec9b0'; }
      copyBtn.style.transform = '';
    });

    closeBtn.style.transition = 'background 0.15s, color 0.15s, transform 0.1s';
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = '#6a6a8a'; closeBtn.style.color = '#0a0a1a'; closeBtn.style.transform = 'scale(1.03)'; });
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = 'transparent'; closeBtn.style.color = '#6a6a8a'; closeBtn.style.transform = ''; });

    closeBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    // Platform toggle
    let selectedPlatform = 'linux';
    async function dialogGenerateCmd() {
      const cmdEl = document.getElementById('add-machine-cmd');
      cmdEl.textContent = 'Generating...';
      cmdEl.style.opacity = '0.5';
      copyBtn.style.display = 'none';
      try {
        const hostname = 'machine-' + Date.now().toString(36);
        const cmd = await fetchInstallCommand(hostname, selectedPlatform);
        cmdEl.textContent = cmd;
        cmdEl.style.opacity = '1';
        copyBtn.style.display = 'inline-block';
      } catch (e) {
        cmdEl.textContent = 'Error: ' + (e.message || 'try again');
        cmdEl.style.opacity = '1';
      }
    }

    const platformBtns = document.querySelectorAll('#add-machine-platform button');
    platformBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        selectedPlatform = btn.dataset.platform;
        platformBtns.forEach(b => {
          if (b.dataset.platform === selectedPlatform) {
            b.style.background = '#4ec9b0'; b.style.color = '#0a0a1a'; b.style.borderColor = '#4ec9b0'; b.style.fontWeight = 'bold';
          } else {
            b.style.background = 'transparent'; b.style.color = '#6a6a8a'; b.style.borderColor = '#333'; b.style.fontWeight = 'normal';
          }
        });
        dialogGenerateCmd();
      });
    });

    // Auto-generate immediately
    dialogGenerateCmd();

    copyBtn.addEventListener('click', () => {
      const cmd = document.getElementById('add-machine-cmd').textContent;
      navigator.clipboard.writeText(cmd).then(() => {
        copyBtn.dataset.copied = '1';
        copyBtn.textContent = 'Copied!';
        copyBtn.style.background = '#10b981';
        copyBtn.style.color = '#fff';
        copyBtn.style.borderColor = '#10b981';
        copyBtn.style.transform = 'scale(1.08)';
        setTimeout(() => { copyBtn.style.transform = ''; }, 150);
        setTimeout(() => {
          delete copyBtn.dataset.copied;
          copyBtn.textContent = 'Copy';
          copyBtn.style.background = 'transparent';
          copyBtn.style.color = '#4ec9b0';
          copyBtn.style.borderColor = '#4ec9b0';
        }, 2000);
      });
    });
  }

  // Update agents HUD with relay agent list
  function updateAgentsHud() {
    // Re-render the Machines HUD with agent data mapped to device format
    hudData.devices = agents.map(a => ({
      name: a.displayName || a.hostname || a.agentId,
      hostname: a.hostname,
      ip: a.agentId,
      os: a.os || 'linux',
      online: a.online !== false,
      isLocal: agents.length === 1
    }));
    if (hudHidden) updateHudDotColor();
    renderHud();

    // Start usage polling when any agent is available
    const hasOnline = agents.some(a => a.online);
    if (hasOnline && !agentsUsageIntervalId) {
      fetchAgentsUsage();
      agentsUsageIntervalId = setInterval(fetchAgentsUsage, 300000);
      // Refresh "ago" text every 60s so it stays current between fetches
      if (!agentsUsageAgoIntervalId) {
        agentsUsageAgoIntervalId = setInterval(renderAgentsHud, 60000);
      }
    } else if (!hasOnline && agentsUsageIntervalId) {
      clearInterval(agentsUsageIntervalId);
      agentsUsageIntervalId = null;
      if (agentsUsageAgoIntervalId) {
        clearInterval(agentsUsageAgoIntervalId);
        agentsUsageAgoIntervalId = null;
      }
    }
  }

  // Helper: get devices list from local agents array (replaces fetch('/api/devices'))
  function getDevicesFromAgents() {
    return agents.filter(a => a.online).map(a => ({
      name: a.displayName || a.hostname || a.agentId,
      hostname: a.hostname,
      ip: a.agentId,
      os: a.os || 'linux',
      online: a.online !== false,
      isLocal: agents.length === 1
    }));
  }

  // Helper: resolve the owning agentId for a given pane
  function getPaneAgentId(paneId) {
    const pane = state.panes.find(p => p.id === paneId);
    return (pane && pane.agentId) || activeAgentId;
  }

  // ============================================================================
  // SECTION 11: REST-OVER-WS API & CONNECTION STATUS              [Lines ~3212-3397]
  // agentRequest() RPC, pending request correlation, connection indicators,
  // offline placeholders, disconnect overlays
  // ============================================================================

  // Pending request/response correlation
  const pendingRequests = new Map();
  const pendingScanCallbacks = new Map(); // id -> onPartial callback for streaming scan results

  // REST-over-WS: replaces fetch() for agent-proxied endpoints
  // Falls back to direct fetch() when no relay/agent is available (local server mode)
  // Optional agentId param routes to a specific agent (defaults to activeAgentId)
  // options.onPartial: callback(repos[]) called as scan results stream in
  function agentRequest(method, path, body, agentId, options) {
    const { onPartial } = options || {};
    const resolvedAgentId = agentId || activeAgentId;
    // Local mode: no relay WebSocket or no agent — use direct fetch
    if (!ws || ws.readyState !== WebSocket.OPEN || !resolvedAgentId) {
      const opts = { method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' } };
      if (body && method !== 'GET') opts.body = JSON.stringify(body);
      return fetch(path, opts).then(r => {
        if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
        return r.json();
      });
    }

    // Relay mode: send through WebSocket
    return new Promise((resolve, reject) => {
      const id = (crypto.randomUUID ? crypto.randomUUID() : 'req_' + Math.random().toString(36).slice(2) + Date.now().toString(36));
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        pendingScanCallbacks.delete(id);
        reject(new Error('Agent request timeout'));
      }, 15000);

      pendingRequests.set(id, { resolve, reject, timeout });
      if (onPartial) pendingScanCallbacks.set(id, onPartial);

      ws.send(JSON.stringify({
        type: 'request',
        id,
        agentId: resolvedAgentId,
        payload: { method, path, body }
      }));
    });
  }

  // Update connection status indicator
  function updateConnectionStatus(paneId, status) {
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
  function findOnlineAgentForDevice(pane) {
    // First check if the pane's own agent is online
    const ownAgent = agents.find(a => a.agentId === pane.agentId && a.online);
    if (ownAgent) return ownAgent;
    // Match by device name → agent hostname
    if (pane.device) {
      return agents.find(a => a.online && a.hostname === pane.device);
    }
    return null;
  }

  // Show or hide disconnect overlay on a pane element
  // mode: 'offline' (device offline), 'resume' (claude terminal, device online), 'reconnect' (plain terminal, device online), or false to hide
  function setDisconnectOverlay(paneEl, mode) {
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
  function renderOfflinePlaceholder(paneData) {
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

    const deviceTag = paneData.device ? deviceLabelHtml(paneData.device) : '';
    const beadsTag = beadsTagHtml(paneData.beadsTag);

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

    if (!paneData.shortcutNumber) paneData.shortcutNumber = getNextShortcutNumber();
    pane.innerHTML = `
      <div class="pane-header">
        <span class="pane-title">${titleHtml}</span>
        ${paneNameHtml(paneData)}
        <div class="pane-header-right">
          ${shortcutBadgeHtml(paneData)}
          <span class="connection-status disconnected" data-tooltip="Disconnected"></span>
          <button class="pane-close" aria-label="Close pane"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
      </div>
      <div class="pane-content"></div>
      <div class="pane-resize-handle"></div>
    `;

    setupPaneListeners(pane, paneData);
    canvas.appendChild(pane);
    // Check if another online agent can handle this pane's device
    const altAgent = findOnlineAgentForDevice(paneData);
    if (altAgent && paneData.type === 'terminal') {
      setDisconnectOverlay(pane, paneData.claudeSessionId ? 'resume' : 'reconnect');
    } else {
      setDisconnectOverlay(pane, 'offline');
    }
  }

  // ============================================================================
  // SECTION 12: PANE CREATION & TYPE REGISTRY                    [Lines ~3398-4700]
  // PANE_TYPES config, loadAgentPanes(), createPane(), deletePane(),
  // createFilePane(), createNotePane(), createGitGraphPane(), createIframePane(),
  // createFolderPane(), createBeadsPane(), file/folder browser overlays,
  // custom select widget, device picker
  // ============================================================================

  // Load all 6 pane types from a single agent, tagging each with agentId
  // Pane type configuration for data-driven loading
  const PANE_TYPES = [
    { type: 'terminal', endpoint: '/api/terminals',
      defPos: { x: 50, y: 50 }, defSize: PANE_DEFAULTS['terminal'],
      extraFields: (t) => ({ tmuxSession: t.tmuxSession, device: t.device || null }),
      render: renderPane },
    { type: 'file', endpoint: '/api/file-panes',
      defPos: { x: 100, y: 100 }, defSize: PANE_DEFAULTS['file'],
      extraFields: (f) => ({ fileName: f.fileName, filePath: f.filePath, content: f.content, device: f.device || null }),
      render: renderFilePane },
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
      render: renderConversationsPane },
  ];

  async function loadPanesFromAgent(agentId, cloudLayoutMap) {
    const agent = agents.find(a => a.agentId === agentId);
    const agentHostname = agent && agent.hostname ? agent.hostname : null;

    const results = await Promise.all(
      PANE_TYPES.map(cfg => agentRequest('GET', cfg.endpoint, null, agentId).catch(() => []))
    );

    PANE_TYPES.forEach((cfg, i) => {
      for (const item of results[i]) {
        if (state.panes.some(p => p.id === item.id)) continue;
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
          zIndex: (cl && cl.z_index) ? cl.z_index : state.nextZIndex++,
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
        state.panes.push(pane); _telemetry.trackPaneOpen(pane);
        cfg.render(pane);
      }
    });
  }


  async function loadTerminalsFromServer() {
    try {
      // Fetch cloud layouts FIRST so panes render with correct positions immediately
      let cloudLayoutMap = new Map();
      let cloudLayouts = [];
      try {
        const cloudData = await cloudFetch('GET', '/api/layouts');
        if (cloudData.layouts && cloudData.layouts.length > 0) {
          cloudLayouts = cloudData.layouts;
          cloudLayoutMap = new Map(cloudLayouts.map(l => [l.id, l]));
        }
      } catch (e) {
        console.warn('[Cloud] Failed to pre-fetch cloud layouts:', e.message);
      }

      // Load panes from all online agents, passing cloud layout data for correct positioning
      const onlineAgents = agents.filter(a => a.online);
      if (onlineAgents.length > 0) {
        await Promise.all(onlineAgents.map(a => loadPanesFromAgent(a.agentId, cloudLayoutMap)));
      }

      // Apply cloud layout data to any panes that were already in state before this load
      // (e.g. panes added by earlier agent loads or other code paths)
      for (const pane of state.panes) {
        const cl = cloudLayoutMap.get(pane.id);
        if (cl) {
          if (cl.agent_id && !pane.agentId) pane.agentId = cl.agent_id;
        }
      }

      // Create offline placeholder panes for cloud layouts whose agents are not online.
      // This ensures panes from disconnected devices remain visible on the canvas.
      if (cloudLayouts.length > 0) {
        const existingIds = new Set(state.panes.map(p => p.id));
        for (const cl of cloudLayouts) {
            if (existingIds.has(cl.id)) continue; // already loaded from online agent
            const meta = cl.metadata ? (typeof cl.metadata === 'string' ? JSON.parse(cl.metadata) : cl.metadata) : {};
            // Resolve device name: metadata > agent hostname from DB > agents array
            const agentEntry = agents.find(a => a.agentId === cl.agent_id);
            const deviceName = meta.device || cl.agent_hostname || (agentEntry && agentEntry.hostname) || null;
            const pane = {
              id: cl.id,
              type: cl.pane_type,
              x: cl.position_x,
              y: cl.position_y,
              width: cl.width,
              height: cl.height,
              zIndex: cl.z_index || state.nextZIndex++,
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
            state.panes.push(pane); _telemetry.trackPaneOpen(pane);
            // Checkpoint panes are client-only — render them directly, not as offline placeholders
            if (pane.type === 'checkpoint') {
              pane._offlinePlaceholder = false;
              renderCheckpointPane(pane);
            } else {
              renderOfflinePlaceholder(pane);
            }
          }
      }

      // Fetch fresh beads tag statuses
      for (const pane of state.panes) {
        if (pane.beadsTag && pane.beadsTag.id) {
          refreshBeadsTagStatus(pane);
        }
      }
      // Sync any panes the cloud doesn't know about yet
      for (const pane of state.panes) {
        cloudSaveLayout(pane);
      }

      // Cloud Phase 4: Load cloud view state
      try {
        const vs = await cloudFetch('GET', '/api/view-state');
        if (vs && vs.zoom !== undefined) {
          state.zoom = vs.zoom;
          state.panX = vs.pan_x || 0;
          state.panY = vs.pan_y || 0;
          updateCanvasTransform();
        }
      } catch (e) {
        console.warn('[Cloud] Failed to load cloud view state:', e.message);
      }

    } catch (e) {
      console.error('[App] Failed to load panes:', e);
    }

    // Ensure nextTabGroupId is ahead of any restored groups
    for (const p of state.panes) {
      if (p.tabGroupId) {
        const match = p.tabGroupId.match(/^tg-(\d+)$/);
        if (match) nextTabGroupId = Math.max(nextTabGroupId, parseInt(match[1], 10) + 1);
      }
    }

    // Restore tab group UI for all panes that belong to a group.
    // renderOfflinePlaceholder and loadPanesFromAgent render panes individually
    // and never call refreshTabBars — so tab groups appear as separate panes
    // until we do this pass. We also ensure exactly one pane per group is active.
    {
      const seenGroups = new Set();
      for (const p of state.panes) {
        if (!p.tabGroupId || seenGroups.has(p.tabGroupId)) continue;
        seenGroups.add(p.tabGroupId);
        const groupPanes = state.panes.filter(g => g.tabGroupId === p.tabGroupId);
        // Guarantee exactly one active pane per group — pick the first if none is set
        const hasActive = groupPanes.some(g => g.tabGroupActive);
        if (!hasActive && groupPanes.length > 0) groupPanes[0].tabGroupActive = true;
        // Hide non-active panes, show active one
        for (const gp of groupPanes) {
          const el = document.getElementById(`pane-${gp.id}`);
          if (el) el.style.display = gp.tabGroupActive ? '' : 'none';
        }
        refreshTabBars(p.tabGroupId);
      }
    }

    // Re-apply cached claude states now that panes are rendered
    // (states may have arrived before DOM elements existed)
    if (lastReceivedClaudeStates) {
      updateClaudeStates(lastReceivedClaudeStates);
    }

    // Render project rectangles on canvas
    renderProjectRectangles();
    startProjectsSidebarRefresh();
  }

  /**
   * createCustomSelect — replaces a native select with a styled custom dropdown.
   * Returns { el, value (getter/setter) }.
   */
  function createCustomSelect(options, defaultValue, onChange) {
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

    // Prevent drag/pan on canvas
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
  function attachPickerKeyboardNav(container, { onEscape, onExtraKey } = {}) {
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

  async function showDevicePickerGeneric(onDeviceSelected, onFallback) {
    try {
      const devices = getDevicesFromAgents();

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
        const onlineColor = device.online ? '#4ec9b0' : '#6a6a8a';
        const numLabel = i < 9 ? `<span style="opacity:0.5; font-size:11px; margin-right:4px;">${i + 1}</span>` : '';
        btn.innerHTML = `${numLabel}<span style="font-size:16px;">${icon}</span><span style="flex:1;">${device.name}${localBadge}</span><span style="width:8px; height:8px; border-radius:50%; background:${onlineColor}; display:inline-block;"></span>`;
        btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,0.1)'; });
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

  async function showDevicePicker(placementPos) {
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
  function createPane(device, placementPos, targetAgentId) {
    const task = createPaneQueue.then(() => _createPaneImpl(device, placementPos, targetAgentId));
    createPaneQueue = task.catch(() => {});
    return task;
  }

  async function _createPaneImpl(device, placementPos, targetAgentId) {
    const resolvedAgentId = targetAgentId || activeAgentId;

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
        zIndex: state.nextZIndex++,
        tmuxSession: terminal.tmuxSession,
        device: terminal.device || device || null,
        agentId: resolvedAgentId
      };

      state.panes.push(pane); _telemetry.trackPaneOpen(pane);
      renderPane(pane);
      cloudSaveLayout(pane);
      // attachTerminal is called from initTerminal after a 100ms setTimeout.
      // Wait for that to fire before releasing the queue so the next terminal's
      // ttyd spawn doesn't contend with this one on the agent side.
      await new Promise(r => setTimeout(r, 200));

    } catch (e) {
      console.error('[App] Failed to create terminal:', e);
      alert('Failed to create terminal: ' + e.message);
    }
  }

  // Resume or reconnect a dead terminal in an existing pane
  async function resumeTerminalPane(paneId, isResume) {
    const pane = state.panes.find(p => p.id === paneId);
    if (!pane) return;

    const el = document.getElementById(`pane-${paneId}`);
    if (!el) return;

    // Find an online agent that can handle this pane (may differ from original agent)
    const targetAgent = findOnlineAgentForDevice(pane);
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
    setDisconnectOverlay(el, false);
    updateConnectionStatus(paneId, 'connecting');

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
      if (!terminals.has(paneId)) {
        el.remove();
        el.classList.remove('agent-offline');
        renderPane(pane);
      } else {
        // Already has xterm — just reattach
        el.classList.remove('agent-offline');
        attachTerminal(pane);
      }

      // Persist the agent reassignment to cloud
      cloudSaveLayout(pane);

    } catch (e) {
      console.error('[App] Failed to resume terminal:', e);
      if (pane.claudeSessionId) {
        setDisconnectOverlay(el, 'resume');
      } else {
        setDisconnectOverlay(el, 'reconnect');
      }
      updateConnectionStatus(paneId, 'error');
    }
  }

  // Show device picker for opening a file, then show file browser
  async function openFileWithDevicePicker(placementPos) {
    showDevicePickerGeneric(
      (d) => showFileBrowser(d.name, '~', placementPos, false, d.ip),
      (e) => alert('Failed to list devices: ' + e.message)
    );
  }

  // Show the file browser overlay for a given device
  // === Shared browser overlay infrastructure ===

  function createBrowserOverlay(id, headerContentHTML) {
    const existing = document.getElementById(id);
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; z-index:10001; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.7);';

    const browser = document.createElement('div');
    browser.style.cssText = 'width:500px; max-width:90vw; max-height:70vh; background:rgba(15,20,35,0.98); border:1px solid rgba(var(--accent-rgb),0.3); border-radius:12px; display:flex; flex-direction:column; overflow:hidden; box-shadow:0 20px 60px rgba(0,0,0,0.6);';

    const header = document.createElement('div');
    header.style.cssText = 'padding:12px 16px; background:rgba(0,0,0,0.3); border-bottom:1px solid rgba(255,255,255,0.08); display:flex; align-items:center; gap:10px; flex-shrink:0;';
    header.innerHTML = headerContentHTML + '<button class="browser-overlay-close" style="margin-left:auto; background:none; border:none; color:rgba(255,255,255,0.4); font-size:20px; cursor:pointer; padding:2px 6px; border-radius:4px;">&times;</button>';

    const breadcrumbBar = document.createElement('div');
    breadcrumbBar.style.cssText = 'padding:8px 16px; background:rgba(0,0,0,0.15); border-bottom:1px solid rgba(255,255,255,0.05); display:flex; align-items:center; gap:4px; flex-shrink:0; overflow-x:auto; font-size:12px;';

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
    rootBtn.style.cssText = 'background:none; border:none; color:rgba(255,255,255,0.6); cursor:pointer; font-size:12px; padding:2px 4px; border-radius:3px;';
    rootBtn.textContent = '/';
    rootBtn.addEventListener('click', () => onNavigate('/'));
    rootBtn.addEventListener('mouseenter', () => { rootBtn.style.color = '#fff'; });
    rootBtn.addEventListener('mouseleave', () => { rootBtn.style.color = 'rgba(255,255,255,0.6)'; });
    breadcrumbBar.appendChild(rootBtn);

    parts.forEach((part, i) => {
      const sep = document.createElement('span');
      sep.style.cssText = 'color:rgba(255,255,255,0.2); margin:0 2px;';
      sep.textContent = '/';
      breadcrumbBar.appendChild(sep);

      const btn = document.createElement('button');
      btn.style.cssText = 'background:none; border:none; color:rgba(255,255,255,0.6); cursor:pointer; font-size:12px; padding:2px 4px; border-radius:3px;';
      btn.textContent = part;
      const targetPath = '/' + parts.slice(0, i + 1).join('/');
      btn.addEventListener('click', () => onNavigate(targetPath));
      btn.addEventListener('mouseenter', () => { btn.style.color = '#fff'; });
      btn.addEventListener('mouseleave', () => { btn.style.color = 'rgba(255,255,255,0.6)'; });
      breadcrumbBar.appendChild(btn);
    });
  }

  function createFolderItem(name, onClick) {
    const item = document.createElement('div');
    item.setAttribute('data-nav-item', '');
    item.style.cssText = 'display:flex; align-items:center; gap:10px; padding:7px 16px; cursor:pointer; transition:background 0.1s; font-size:13px;';
    const icon = name === '..' ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>' : '\u{1F4C1}';
    item.innerHTML = `<span style="width:20px; text-align:center;">${icon}</span><span style="color:rgba(255,255,255,0.85); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(name)}</span>`;
    item.addEventListener('click', onClick);
    item.addEventListener('mouseenter', () => { item.style.background = 'rgba(var(--accent-rgb),0.15)'; });
    item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
    return item;
  }

  // Shared folder-browse-then-scan picker used by git and beads repo pickers.
  // config: { id, headerHTML, scanLabel, onScan(folderPath, contentArea, closeBrowser, navigateFolder, navRefresh), device, targetAgentId }
  function showFolderScanPicker(config) {
    const { id, headerHTML, scanLabel, onScan, device, targetAgentId } = config;
    const { overlay, header, breadcrumbBar, contentArea, closeBrowser, addCleanup } = createBrowserOverlay(id, headerHTML);

    // Attach keyboard nav to the overlay (lives for entire overlay lifetime)
    const nav = attachPickerKeyboardNav(overlay, { onEscape: closeBrowser });
    addCleanup(nav.cleanup);

    async function navigateFolder(path) {
      contentArea.innerHTML = '<div style="padding:40px; text-align:center; color:rgba(255,255,255,0.4); font-size:13px;">Loading...</div>';

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
        selectBtn.style.cssText = 'display:flex; align-items:center; gap:10px; padding:9px 16px; cursor:pointer; transition:background 0.1s; font-size:13px; background:rgba(var(--accent-rgb),0.1); border-bottom:1px solid rgba(255,255,255,0.05); margin-bottom:2px;';
        selectBtn.innerHTML = `<span style="width:20px; text-align:center; color:#da7756;">\u2713</span><span style="color:#e8a882; font-weight:500;">${escapeHtml(scanLabel)}</span>`;
        selectBtn.addEventListener('click', () => onScan(data.path, contentArea, closeBrowser, navigateFolder, () => nav.refresh()));
        selectBtn.addEventListener('mouseenter', () => { selectBtn.style.background = 'rgba(var(--accent-rgb),0.25)'; });
        selectBtn.addEventListener('mouseleave', () => { selectBtn.style.background = 'rgba(var(--accent-rgb),0.1)'; });
        contentArea.appendChild(selectBtn);

        const dirs = data.entries.filter(e => e.type === 'dir');
        if (dirs.length === 0) {
          const empty = document.createElement('div');
          empty.style.cssText = 'padding:20px; text-align:center; color:rgba(255,255,255,0.3); font-size:12px;';
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

  async function showFileBrowser(device, startPath = '~', placementPos, thenPlace = false, targetAgentId) {
    const headerHTML = `
      ${deviceLabelHtml(device, 'font-size:11px; padding:2px 8px;')}
      <span style="color:rgba(255,255,255,0.7); font-size:13px; font-weight:500;">Browse Files</span>
      <button id="file-browser-new" style="margin-left:auto; background:rgba(var(--accent-rgb),0.2); border:1px solid rgba(var(--accent-rgb),0.3); color:rgba(255,255,255,0.7); font-size:12px; cursor:pointer; padding:4px 10px; border-radius:6px; transition:all 0.15s;">+ New File</button>`;
    const { overlay, header, breadcrumbBar, contentArea, closeBrowser, addCleanup } = createBrowserOverlay('file-browser', headerHTML);

    // Attach keyboard nav to the overlay
    const nav = attachPickerKeyboardNav(overlay, { onEscape: closeBrowser });
    addCleanup(nav.cleanup);

    let currentBrowsePath = startPath;

    // New File button handler
    const newFileBtn = header.querySelector('#file-browser-new');
    newFileBtn.addEventListener('mouseenter', () => { newFileBtn.style.background = 'rgba(var(--accent-rgb),0.35)'; newFileBtn.style.color = '#fff'; });
    newFileBtn.addEventListener('mouseleave', () => { newFileBtn.style.background = 'rgba(var(--accent-rgb),0.2)'; newFileBtn.style.color = 'rgba(255,255,255,0.7)'; });
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
      input.style.cssText = 'flex:1; background:rgba(0,0,0,0.3); border:1px solid rgba(var(--accent-rgb),0.4); border-radius:4px; color:#fff; padding:5px 8px; font-size:12px; font-family:inherit; outline:none;';
      input.addEventListener('focus', () => { input.style.borderColor = 'rgba(var(--accent-rgb),0.7)'; });
      input.addEventListener('blur', () => { input.style.borderColor = 'rgba(var(--accent-rgb),0.4)'; });

      const createBtn = document.createElement('button');
      createBtn.textContent = 'Create';
      createBtn.style.cssText = 'background:rgba(var(--accent-rgb),0.4); border:none; color:#fff; font-size:11px; padding:5px 12px; border-radius:4px; cursor:pointer; transition:background 0.15s;';
      createBtn.addEventListener('mouseenter', () => { createBtn.style.background = 'rgba(var(--accent-rgb),0.6)'; });
      createBtn.addEventListener('mouseleave', () => { createBtn.style.background = 'rgba(var(--accent-rgb),0.4)'; });

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = '\u00D7';
      cancelBtn.style.cssText = 'background:none; border:none; color:rgba(255,255,255,0.4); font-size:16px; cursor:pointer; padding:2px 6px;';
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
            enterPlacementMode('file', (pos) => createFilePaneFromRemote(device, fullPath, pos, targetAgentId));
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
      contentArea.innerHTML = '<div style="padding:40px; text-align:center; color:rgba(255,255,255,0.4); font-size:13px;">Loading...</div>';

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
          contentArea.innerHTML = '<div style="padding:20px; text-align:center; color:rgba(255,255,255,0.3); font-size:12px;">Empty directory</div>';
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
                enterPlacementMode('file', (pos) => createFilePaneFromRemote(device, fullPath, pos, targetAgentId));
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
      const sizeStr = type === 'file' && size !== null ? `<span style="color:rgba(255,255,255,0.3); font-size:11px; margin-left:auto;">${formatBytes(size)}</span>` : '';
      item.innerHTML = `<span style="width:20px; text-align:center;">${icon}</span><span style="color:rgba(255,255,255,0.85); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(name)}</span>${sizeStr}`;
      item.addEventListener('click', onClick);
      item.addEventListener('mouseenter', () => { item.style.background = 'rgba(var(--accent-rgb),0.15)'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
      return item;
    }

    navigateTo(startPath);
  }

  // Create a file pane from a remote (or local) device + path
  async function createFilePaneFromRemote(device, filePath, placementPos, targetAgentId) {
    const resolvedAgentId = targetAgentId || activeAgentId;

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
        zIndex: state.nextZIndex++,
        fileName: filePane.fileName,
        filePath: filePane.filePath,
        content: filePane.content,
        device: filePane.device || device,
        agentId: resolvedAgentId
      };

      state.panes.push(pane); _telemetry.trackPaneOpen(pane);
      renderFilePane(pane);
      cloudSaveLayout(pane);
      saveRecentContext('file', pane.filePath, pane.fileName, resolvedAgentId);

    } catch (e) {
      console.error('[App] Failed to create file pane:', e);
      alert('Failed to open file: ' + e.message);
    }
  }



  // Create a new sticky note pane
  async function createNotePane(placementPos, initialContent, initialImages) {

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
        zIndex: state.nextZIndex++,
        content: initialContent || notePane.content || '',
        images: initialImages || notePane.images || [],
        fontSize: notePane.fontSize || 11,
        agentId: activeAgentId
      };

      state.panes.push(pane); _telemetry.trackPaneOpen(pane);
      renderNotePane(pane);
      cloudSaveLayout(pane);

      // If initial content or images provided, save immediately and focus the note
      if (initialContent || (initialImages && initialImages.length > 0)) {
        agentRequest('PATCH', `/api/notes/${pane.id}`, { content: initialContent || '', images: pane.images }, pane.agentId)
          .catch(e => console.error('Failed to save initial note content:', e));
        cloudSaveNote(pane.id, initialContent || '', pane.fontSize, pane.images);
      }

      // Focus the new note pane
      focusPane(pane);
      const noteInfo = noteEditors.get(pane.id);
      if (noteInfo?.monacoEditor) {
        noteInfo.monacoEditor.focus();
      } else {
        const paneEl = document.getElementById(`pane-${pane.id}`);
        const noteEditor = paneEl?.querySelector('.note-editor');
        if (noteEditor) noteEditor.focus();
      }

      return pane;

    } catch (e) {
      console.error('[App] Failed to create note pane:', e);
      alert('Failed to create note pane: ' + e.message);
    }
  }

  // Show device picker then git repo picker
  async function showGitRepoPickerWithDevice(placementPos) {
    showDevicePickerGeneric(
      (d) => showGitRepoPicker(d.name, placementPos, false, d.ip),
      () => showGitRepoPicker(undefined, placementPos)
    );
  }

  // Show folder browser then repo picker for git graph pane
  async function showGitRepoPicker(device, placementPos, thenPlace = false, targetAgentId) {
    const deviceLabel = device ? deviceLabelHtml(device, 'font-size:11px; padding:2px 8px;') : '';
    const headerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" style="color:rgba(255,255,255,0.6);">${ICON_GIT_GRAPH}</svg>
      ${deviceLabel}
      <span style="color:rgba(255,255,255,0.7); font-size:13px; font-weight:500;">Choose Folder</span>`;

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
        toggleBar.style.cssText = 'display:flex; align-items:center; gap:10px; padding:8px 16px; border-bottom:1px solid rgba(255,255,255,0.06); flex-shrink:0;';

        const backBtn = document.createElement('button');
        backBtn.setAttribute('data-nav-item', '');
        backBtn.style.cssText = 'background:none; border:none; color:rgba(255,255,255,0.5); cursor:pointer; font-size:12px; padding:2px 6px; border-radius:3px;';
        backBtn.textContent = '\u2190 Back';
        backBtn.addEventListener('click', () => navigateFolder(folderPath));
        backBtn.addEventListener('mouseenter', () => { backBtn.style.color = '#fff'; });
        backBtn.addEventListener('mouseleave', () => { backBtn.style.color = 'rgba(255,255,255,0.5)'; });
        toggleBar.appendChild(backBtn);

        const scanStatus = document.createElement('span');
        scanStatus.style.cssText = 'font-size:11px; color:rgba(255,255,255,0.3); margin-left:4px;';
        scanStatus.textContent = 'Scanning...';
        toggleBar.appendChild(scanStatus);

        const spacer = document.createElement('div');
        spacer.style.cssText = 'flex:1;';
        toggleBar.appendChild(spacer);

        const toggleWrap = document.createElement('label');
        toggleWrap.style.cssText = 'display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none;';

        const toggleTrack = document.createElement('div');
        toggleTrack.style.cssText = `width:32px; height:18px; border-radius:9px; position:relative; transition:background 0.2s; ${masterOnly ? 'background:rgba(255,255,255,0.15);' : 'background:rgba(var(--accent-rgb),0.6);'}`;

        const toggleThumb = document.createElement('div');
        toggleThumb.style.cssText = `width:14px; height:14px; border-radius:50%; background:#fff; position:absolute; top:2px; transition:left 0.2s; ${masterOnly ? 'left:2px;' : 'left:16px;'}`;
        toggleTrack.appendChild(toggleThumb);

        const toggleLabel = document.createElement('span');
        toggleLabel.style.cssText = 'font-size:11px; color:rgba(255,255,255,0.5);';
        toggleLabel.textContent = masterOnly ? 'master/main only' : 'all branches';

        toggleWrap.appendChild(toggleTrack);
        toggleWrap.appendChild(toggleLabel);
        toggleWrap.addEventListener('click', (e) => {
          e.preventDefault();
          masterOnly = !masterOnly;
          toggleTrack.style.background = masterOnly ? 'rgba(255,255,255,0.15)' : 'rgba(var(--accent-rgb),0.6)';
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
          const branchColor = (repo.branch === 'master' || repo.branch === 'main') ? '#4ec9b0' : '#b392f0';
          item.innerHTML = `
            <span style="color:#f97583; font-size:14px;">&#9679;</span>
            <span style="flex:1; overflow:hidden;">
              <strong style="color:rgba(255,255,255,0.9);">${escapeHtml(repo.name)}</strong><br>
              <span style="opacity:0.4; font-size:11px;">${escapeHtml(repo.path)}</span>
            </span>
            <span style="color:${branchColor}; font-size:11px; white-space:nowrap;">${escapeHtml(repo.branch)}</span>
          `;
          item.addEventListener('click', () => {
            closeBrowser();
            if (thenPlace) {
              enterPlacementMode('git-graph', (pos) => createGitGraphPane(repo.path, device, pos, targetAgentId));
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
            empty.style.cssText = 'padding:20px; text-align:center; color:rgba(255,255,255,0.3); font-size:12px;';
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
  async function createIframePane(placementPos) {
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
        zIndex: state.nextZIndex++,
        url: iframeData.url,
        agentId: activeAgentId
      };

      state.panes.push(pane); _telemetry.trackPaneOpen(pane);
      renderIframePane(pane);
      cloudSaveLayout(pane);
      try { saveRecentContext('iframe', pane.url, new URL(pane.url).hostname); } catch (_) { saveRecentContext('iframe', pane.url, pane.url); }
    } catch (e) {
      console.error('[App] Failed to create iframe pane:', e);
      alert('Failed to create iframe: ' + e.message);
    }
  }

  // Create iframe pane with a pre-known URL (skips prompt)
  async function createIframePaneWithUrl(url, placementPos) {
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
        zIndex: state.nextZIndex++,
        url: iframeData.url,
        agentId: activeAgentId
      };
      state.panes.push(pane); _telemetry.trackPaneOpen(pane);
      renderIframePane(pane);
      cloudSaveLayout(pane);
      try { saveRecentContext('iframe', pane.url, new URL(pane.url).hostname); } catch (_) { saveRecentContext('iframe', pane.url, pane.url); }
    } catch (e) {
      console.error('[App] Failed to create iframe pane:', e);
      alert('Failed to create iframe: ' + e.message);
    }
  }

  async function createGitGraphPane(repoPath, device, placementPos, targetAgentId) {
    const resolvedAgentId = targetAgentId || activeAgentId;

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
        zIndex: state.nextZIndex++,
        repoPath: ggPane.repoPath,
        repoName: ggPane.repoName,
        device: device || ggPane.device,
        agentId: resolvedAgentId
      };

      state.panes.push(pane); _telemetry.trackPaneOpen(pane);
      renderGitGraphPane(pane);
      cloudSaveLayout(pane);
      saveRecentContext('git-graph', pane.repoPath, pane.repoName, resolvedAgentId);

    } catch (e) {
      console.error('[App] Failed to create git graph pane:', e);
      alert('Failed to create git graph pane: ' + e.message);
    }
  }

  // renderGitGraphPane, setupGitGraphListeners, assignLanes, gitRelativeTime,
  // renderSvgGitGraph, fetchGitGraphData — imported from modules/git-graph.js

    // Delete a pane (terminal or file)
  async function deletePane(paneId) {

    // Remove from broadcast selection if present
    if (selectedPaneIds.delete(paneId)) {
      updateBroadcastIndicator();
    }

    // If this pane is expanded, collapse it first
    if (expandedPaneId === paneId) {
      collapsePane();
    }

    try {
      const pane = state.panes.find(p => p.id === paneId);
      const paneType = pane?.type || 'terminal';
      _telemetry.trackPaneClose(paneId, paneType);

      if (paneType === 'terminal') {
        // Close terminal via WebSocket
        sendWs('terminal:close', { terminalId: paneId }, getPaneAgentId(paneId));

        // Clean up xterm instance
        const termInfo = terminals.get(paneId);
        if (termInfo) {
          termInfo.xterm.dispose();
          terminals.delete(paneId);
          termDeferredBuffers.delete(paneId);
        }
      } else if (paneType === 'file') {
        // Check for unsaved changes
        const editorInfo = fileEditors.get(paneId);
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
        fileEditors.delete(paneId);
        fileHandles.delete(paneId); // Clean up file handle

        // Delete from server (best-effort — agent may be offline)
        agentRequest('DELETE', `/api/file-panes/${paneId}`, null, pane?.agentId).catch(() => {});
      } else if (paneType === 'note') {
        // Dispose Monaco editor if this is a note pane
        const noteInfo = noteEditors.get(paneId);
        if (noteInfo) {
          if (noteInfo.monacoEditor) noteInfo.monacoEditor.dispose();
          if (noteInfo.resizeObserver) noteInfo.resizeObserver.disconnect();
          noteEditors.delete(paneId);
        }
        // Delete from server (best-effort — agent may be offline)
        agentRequest('DELETE', `/api/notes/${paneId}`, null, pane?.agentId).catch(() => {});
      } else if (paneType === 'git-graph') {
        // Stop auto-refresh
        const ggInfo = gitGraphPanes.get(paneId);
        if (ggInfo?.refreshInterval) {
          clearInterval(ggInfo.refreshInterval);
        }
        gitGraphPanes.delete(paneId);
        // Delete from server (best-effort — agent may be offline)
        agentRequest('DELETE', `/api/git-graphs/${paneId}`, null, pane?.agentId).catch(() => {});
      } else if (paneType === 'iframe') {
        agentRequest('DELETE', `/api/iframes/${paneId}`, null, pane?.agentId).catch(() => {});
      } else if (paneType === 'beads') {
        // Stop auto-refresh
        const bInfo = beadsPanes.get(paneId);
        if (bInfo?.refreshInterval) {
          clearInterval(bInfo.refreshInterval);
        }
        beadsPanes.delete(paneId);
        agentRequest('DELETE', `/api/beads-panes/${paneId}`, null, pane?.agentId).catch(() => {});
      } else if (paneType === 'folder') {
        const fpInfo = folderPanes.get(paneId);
        if (fpInfo?.refreshInterval) clearInterval(fpInfo.refreshInterval);
        folderPanes.delete(paneId);
        agentRequest('DELETE', `/api/folder-panes/${paneId}`, null, pane?.agentId).catch(() => {});
      } else if (paneType === 'conversations') {
        agentRequest('DELETE', `/api/conversations-panes/${paneId}`, null, pane?.agentId).catch(() => {});
      } else if (paneType === 'checkpoint') {
        // Checkpoint panes are local-only, just remove from state
      }

      // Remove from state
      const index = state.panes.findIndex(p => p.id === paneId);
      if (index !== -1) {
        state.panes.splice(index, 1);
      }

      // Remove from DOM
      const paneEl = document.getElementById(`pane-${paneId}`);
      if (paneEl) {
        paneEl.remove();
      }
      if (lastFocusedPaneId === paneId) lastFocusedPaneId = null;

      // Remove from cloud layout
      cloudDeleteLayout(paneId);

    } catch (e) {
      console.error('[App] Error deleting pane:', e);
    }
  }

  // ============================================================================
  // SECTION 12b: TAB GROUPS                                       [Tab grouping]
  // Panes sharing a tabGroupId appear as tabs in a single window.
  // Only the active tab is visible; siblings are hidden (display:none).
  // ============================================================================

  function getTabGroupPanes(tabGroupId) {
    if (!tabGroupId) return [];
    return state.panes.filter(p => p.tabGroupId === tabGroupId);
  }

  function getActiveTabPane(tabGroupId) {
    return getTabGroupPanes(tabGroupId).find(p => p.tabGroupActive);
  }

  // Switch to a different tab within a group
  function switchTab(targetPaneId) {
    const targetPane = state.panes.find(p => p.id === targetPaneId);
    if (!targetPane || !targetPane.tabGroupId) return;

    const groupPanes = getTabGroupPanes(targetPane.tabGroupId);
    const currentActive = groupPanes.find(p => p.tabGroupActive);

    if (currentActive && currentActive.id === targetPaneId) return; // already active

    // Sync geometry from current active to target before switching
    if (currentActive) {
      targetPane.x = currentActive.x;
      targetPane.y = currentActive.y;
      targetPane.width = currentActive.width;
      targetPane.height = currentActive.height;
      targetPane.zIndex = currentActive.zIndex;
      currentActive.tabGroupActive = false;

      const currentEl = document.getElementById(`pane-${currentActive.id}`);
      if (currentEl) currentEl.style.display = 'none';
    }

    targetPane.tabGroupActive = true;
    const targetEl = document.getElementById(`pane-${targetPaneId}`);
    if (targetEl) {
      targetEl.style.display = '';
      targetEl.style.left = `${targetPane.x}px`;
      targetEl.style.top = `${targetPane.y}px`;
      targetEl.style.width = `${targetPane.width}px`;
      targetEl.style.height = `${targetPane.height}px`;
      targetEl.style.zIndex = targetPane.zIndex;
    }

    // Refit terminal after showing (dimensions may have changed while hidden)
    const termInfo = terminals.get(targetPaneId);
    if (termInfo) {
      setTimeout(() => {
        try {
          if (termInfo.safeFitAndSync) termInfo.safeFitAndSync();
          else termInfo.fitAddon.fit();
        } catch (e) { /* ignore */ }
      }, 50);
    }

    // Re-render tab bars for all panes in the group
    refreshTabBars(targetPane.tabGroupId);
    focusPane(targetPane);
    focusTerminalInput(targetPaneId);

    // Persist state
    groupPanes.forEach(p => cloudSaveLayout(p));
  }

  // Sync position/size from the active tab to all hidden siblings
  function syncTabGroupGeometry(paneData) {
    if (!paneData.tabGroupId) return;
    const siblings = getTabGroupPanes(paneData.tabGroupId);
    for (const sib of siblings) {
      if (sib.id === paneData.id) continue;
      sib.x = paneData.x;
      sib.y = paneData.y;
      sib.width = paneData.width;
      sib.height = paneData.height;
      // Don't update DOM for hidden panes — it'll sync when switchTab shows them
    }
  }

  // Create a new terminal tab in the same group as an existing pane
  async function createTabInGroup(sourcePaneId) {
    const sourcePane = state.panes.find(p => p.id === sourcePaneId);
    if (!sourcePane || sourcePane.type !== 'terminal') return;

    // If source pane has no group yet, assign one
    if (!sourcePane.tabGroupId) {
      sourcePane.tabGroupId = `tg-${nextTabGroupId++}`;
      sourcePane.tabGroupActive = true;
      cloudSaveLayout(sourcePane);
    }

    const groupId = sourcePane.tabGroupId;
    const agentId = sourcePane.agentId || activeAgentId;

    try {
      const reqBody = {
        workingDir: sourcePane.workingDir || '~',
        position: { x: sourcePane.x, y: sourcePane.y },
        size: { width: sourcePane.width, height: sourcePane.height }
      };
      if (sourcePane.device) reqBody.device = sourcePane.device;
      const terminal = await agentRequest('POST', '/api/terminals', reqBody, agentId);

      const pane = {
        id: terminal.id,
        type: 'terminal',
        x: sourcePane.x,
        y: sourcePane.y,
        width: sourcePane.width,
        height: sourcePane.height,
        zIndex: sourcePane.zIndex,
        tmuxSession: terminal.tmuxSession,
        device: terminal.device || sourcePane.device || null,
        agentId: agentId,
        tabGroupId: groupId,
        tabGroupActive: false, // will become active after switchTab
      };

      state.panes.push(pane);
      _telemetry.trackPaneOpen(pane);
      renderPane(pane);
      cloudSaveLayout(pane);

      // Hide immediately since it's not the active tab yet
      const newEl = document.getElementById(`pane-${pane.id}`);
      if (newEl) newEl.style.display = 'none';

      // Wait for terminal init, then switch to the new tab
      await new Promise(r => setTimeout(r, 200));
      switchTab(pane.id);

      // Refresh tab bars on the source pane too (it now has a tab bar)
      refreshTabBars(groupId);

    } catch (e) {
      console.error('[App] Failed to create tab:', e);
    }
  }

  // Re-render tab bars on all visible panes in a group
  function refreshTabBars(tabGroupId) {
    if (!tabGroupId) return;
    const groupPanes = getTabGroupPanes(tabGroupId);
    for (const p of groupPanes) {
      const paneEl = document.getElementById(`pane-${p.id}`);
      if (!paneEl) continue;
      renderTabBar(paneEl, p);
    }
  }

  // Render (or update) the tab bar inside a pane element
  function renderTabBar(paneEl, paneData) {
    // Remove existing tab bar if any
    const existing = paneEl.querySelector('.tab-bar');
    if (existing) existing.remove();

    if (!paneData.tabGroupId) return;

    const groupPanes = getTabGroupPanes(paneData.tabGroupId);
    if (groupPanes.length < 2) return; // no bar needed for single-tab groups

    const bar = document.createElement('div');
    bar.className = 'tab-bar';

    groupPanes.forEach((p, idx) => {
      const tab = document.createElement('div');
      tab.className = 'tab-bar-tab' + (p.tabGroupActive ? ' active' : '');
      tab.dataset.paneId = p.id;

      const label = document.createElement('span');
      label.className = 'tab-bar-label';
      label.textContent = p.paneName || `Terminal ${idx + 1}`;
      tab.appendChild(label);

      // Close button per tab
      const closeBtn = document.createElement('span');
      closeBtn.className = 'tab-bar-close';
      closeBtn.innerHTML = '&times;';
      closeBtn.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
      });
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTabInGroup(p.id);
      });
      tab.appendChild(closeBtn);

      // Click to switch tab
      tab.addEventListener('mousedown', (e) => {
        e.stopPropagation(); // don't start drag
      });
      tab.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!p.tabGroupActive) switchTab(p.id);
      });

      bar.appendChild(tab);
    });

    // Add "+" button at end of tab bar
    const addBtn = document.createElement('div');
    addBtn.className = 'tab-bar-add';
    addBtn.textContent = '+';
    addBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      createTabInGroup(paneData.id);
    });
    bar.appendChild(addBtn);

    // Insert after .pane-header
    const header = paneEl.querySelector('.pane-header');
    if (header) {
      header.insertAdjacentElement('afterend', bar);
    }
  }

  // Close a tab within a group
  function closeTabInGroup(paneId) {
    const pane = state.panes.find(p => p.id === paneId);
    if (!pane || !pane.tabGroupId) {
      deletePane(paneId);
      return;
    }

    const groupId = pane.tabGroupId;
    const groupPanes = getTabGroupPanes(groupId);

    if (groupPanes.length <= 1) {
      // Last tab in group — dissolve group and delete normally
      pane.tabGroupId = null;
      pane.tabGroupActive = false;
      deletePane(paneId);
      return;
    }

    const wasActive = pane.tabGroupActive;

    // If closing the active tab, switch to adjacent first
    if (wasActive) {
      const idx = groupPanes.findIndex(p => p.id === paneId);
      const nextIdx = idx < groupPanes.length - 1 ? idx + 1 : idx - 1;
      switchTab(groupPanes[nextIdx].id);
    }

    // Now delete the pane
    deletePane(paneId);

    // If only one tab remains, dissolve the group
    const remaining = getTabGroupPanes(groupId);
    if (remaining.length === 1) {
      remaining[0].tabGroupId = null;
      remaining[0].tabGroupActive = false;
      cloudSaveLayout(remaining[0]);
      // Remove the tab bar from the remaining pane
      const el = document.getElementById(`pane-${remaining[0].id}`);
      if (el) {
        const bar = el.querySelector('.tab-bar');
        if (bar) bar.remove();
      }
    } else {
      refreshTabBars(groupId);
    }
  }

  // ============================================================================
  // SECTION 13: TERMINAL LIFECYCLE & PANE RENDERING              [Lines ~4704-5086]
  // attachTerminal(), reattachTerminal(), renderPane() dispatcher,
  // renderFilePane(), Monaco file editor setup, device colors,
  // beads/claude session badges, deviceLabelHtml()
  // ============================================================================

  // Attach terminal to WebSocket
  function attachTerminal(pane) {
    const termInfo = terminals.get(pane.id);
    if (!termInfo) return;

    if (ws && ws.readyState === WebSocket.OPEN) {
      sendWs('terminal:attach', {
        terminalId: pane.id,
        tmuxSession: pane.tmuxSession,
        cols: termInfo.xterm.cols,
        rows: termInfo.xterm.rows
      }, pane.agentId);
    } else {
      pendingAttachments.add(pane.id);
    }
  }

  // Re-attach a terminal — equivalent to what a page reload does.
  // Clears xterm buffer, resets all flags, and sends terminal:attach
  // which triggers the full history capture + force redraw on the agent.
  function reattachTerminal(pane) {
    const termInfo = terminals.get(pane.id);
    if (!termInfo) return;

    // Clear xterm buffer (scrollback + visible area)
    termInfo.xterm.clear();
    termInfo.xterm.reset();

    // Reset flags so history injection runs again
    termInfo._historyLoaded = false;
    termInfo._initialAttachDone = false;

    // Re-attach — agent will re-capture history, send it, then force redraw.
    // Agent skips history capture when a TUI app is in alternate screen mode,
    // so no stale scrollback is created.
    attachTerminal(pane);
  }

  // Render a single pane with terminal
  function renderPane(paneData) {
    const existingPane = document.getElementById(`pane-${paneData.id}`);
    if (existingPane) {
      existingPane.remove();
    }

    const pane = document.createElement('div');
    pane.className = 'pane';
    pane.id = `pane-${paneData.id}`;
    pane.style.left = `${paneData.x}px`;
    pane.style.top = `${paneData.y}px`;
    pane.style.width = `${paneData.width}px`;
    pane.style.height = `${paneData.height}px`;
    pane.style.zIndex = paneData.zIndex;
    pane.dataset.paneId = paneData.id;

    if (!paneData.shortcutNumber) paneData.shortcutNumber = getNextShortcutNumber();
    const deviceTag = paneData.device ? deviceLabelHtml(paneData.device) : '';
    const beadsTag = beadsTagHtml(paneData.beadsTag);
    pane.innerHTML = `
      <div class="pane-header">
        <span class="pane-title">${deviceTag}${beadsTag}<span style="opacity:0.7;">Terminal</span></span>
        ${paneNameHtml(paneData)}
        <div class="pane-header-right">
          ${shortcutBadgeHtml(paneData)}
          <button class="beads-tag-btn" aria-label="Set beads issue" data-tooltip="Set beads issue"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="0">${ICON_BEADS}</svg></button>
          <button class="term-refresh-history" aria-label="Reload history" data-tooltip="Reload history"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 3a7 7 0 1 0 1 5"/><polyline points="14 1 14 5 10 5"/></svg></button>
          <div class="pane-zoom-controls">
            <button class="pane-zoom-btn zoom-out" data-tooltip="Zoom out">−</button>
            <button class="pane-zoom-btn zoom-in" data-tooltip="Zoom in">+</button>
          </div>
          <span class="connection-status connecting" data-tooltip="Connecting"></span>
          <button class="pane-new-tab" aria-label="New tab" data-tooltip="New tab (Tab+=)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
          <button class="pane-expand" aria-label="Expand pane" data-tooltip="Expand">⛶</button>
          <button class="pane-close" aria-label="Close pane"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
      </div>
      <div class="pane-content">
        <div class="terminal-container"></div>
        <div class="terminal-loading-overlay">Restoring history…</div>
      </div>
      <div class="pane-resize-handle"></div>
    `;

    // Fallback: remove loading overlay after 5s if terminal:attached never arrives
    setTimeout(() => {
      const overlay = pane.querySelector('.terminal-loading-overlay');
      if (overlay) {
        overlay.classList.add('fade-out');
        overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
      }
    }, 5000);

    setupPaneListeners(pane, paneData);
    canvas.appendChild(pane);

    // Initialize xterm.js
    initTerminal(pane, paneData);

    // Render tab bar if this pane is part of a tab group
    if (paneData.tabGroupId) {
      renderTabBar(pane, paneData);
      // Hide if not the active tab
      if (!paneData.tabGroupActive) {
        pane.style.display = 'none';
      }
    }
  }

  // Render a file pane
  function renderFilePane(paneData) {
    const existingPane = document.getElementById(`pane-${paneData.id}`);
    if (existingPane) {
      existingPane.remove();
    }

    const pane = document.createElement('div');
    pane.className = 'pane file-pane';
    pane.id = `pane-${paneData.id}`;
    pane.style.left = `${paneData.x}px`;
    pane.style.top = `${paneData.y}px`;
    pane.style.width = `${paneData.width}px`;
    pane.style.height = `${paneData.height}px`;
    pane.style.zIndex = paneData.zIndex;
    pane.dataset.paneId = paneData.id;

    if (!paneData.shortcutNumber) paneData.shortcutNumber = getNextShortcutNumber();
    const deviceTag = paneData.device ? deviceLabelHtml(paneData.device) : '';

    pane.innerHTML = `
      <div class="pane-header">
        <span class="pane-title">${deviceTag}📄 ${escapeHtml(paneData.fileName || 'Untitled')}</span>
        ${paneNameHtml(paneData)}
        <div class="pane-header-right">
          ${shortcutBadgeHtml(paneData)}
          <button class="pane-mention-btn" data-tooltip="Mention in Claude Code">@</button>
          <div class="pane-zoom-controls">
            <button class="pane-zoom-btn zoom-out" data-tooltip="Zoom out">−</button>
            <button class="pane-zoom-btn zoom-in" data-tooltip="Zoom in">+</button>
          </div>
          <button class="pane-expand" aria-label="Expand pane" data-tooltip="Expand">⛶</button>
          <button class="pane-close" aria-label="Close pane"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
      </div>
      <div class="pane-content">
        <div class="file-container">
          <div class="file-toolbar">
            <button class="file-toolbar-btn save-btn" data-tooltip="Save file">Save</button>
            <button class="file-toolbar-btn discard-btn" data-tooltip="Discard changes">Discard</button>
            <button class="file-toolbar-btn reload-btn" data-tooltip="Reload file">Reload</button>
            <span class="file-status"></span>
            <span class="file-refreshed"></span>
          </div>
          <div class="file-editor"></div>
        </div>
      </div>
      <div class="pane-resize-handle"></div>
    `;

    setupPaneListeners(pane, paneData);
    canvas.appendChild(pane);

    // Store original content for change detection (before Monaco init)
    fileEditors.set(paneData.id, {
      originalContent: paneData.content || '',
      hasChanges: false,
      monacoEditor: null
    });

    // Initialize Monaco editor
    initMonacoEditor(pane, paneData);
  }

  // Detect language from filename for Monaco
  function getLanguageFromFileName(fileName) {
    if (!fileName) return 'plaintext';
    const ext = fileName.split('.').pop().toLowerCase();
    const langMap = {
      js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
      ts: 'typescript', tsx: 'typescript',
      py: 'python', pyw: 'python',
      rb: 'ruby', rs: 'rust', go: 'go',
      java: 'java', kt: 'kotlin', scala: 'scala',
      c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
      cs: 'csharp', fs: 'fsharp',
      html: 'html', htm: 'html',
      css: 'css', scss: 'scss', less: 'less',
      json: 'json', jsonc: 'json',
      xml: 'xml', svg: 'xml',
      yaml: 'yaml', yml: 'yaml',
      md: 'markdown', mdx: 'markdown',
      sql: 'sql',
      sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
      ps1: 'powershell',
      php: 'php',
      swift: 'swift', m: 'objective-c',
      r: 'r', R: 'r',
      lua: 'lua', perl: 'perl', pl: 'perl',
      dockerfile: 'dockerfile',
      makefile: 'makefile', mk: 'makefile',
      toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
      vue: 'html', svelte: 'html',
      graphql: 'graphql', gql: 'graphql',
      proto: 'protobuf',
      tf: 'hcl',
      dart: 'dart', elixir: 'elixir', ex: 'elixir', exs: 'elixir',
      clj: 'clojure', cljs: 'clojure',
      zig: 'zig',
    };
    // Also check full filename for special files
    const baseName = fileName.split('/').pop().toLowerCase();
    if (baseName === 'dockerfile') return 'dockerfile';
    if (baseName === 'makefile' || baseName === 'gnumakefile') return 'makefile';
    if (baseName === '.gitignore' || baseName === '.dockerignore') return 'ignore';
    if (baseName === '.env' || baseName.startsWith('.env.')) return 'ini';
    return langMap[ext] || 'plaintext';
  }

  // Initialize Monaco Editor for a file pane
  async function initMonacoEditor(paneEl, paneData) {
    const container = paneEl.querySelector('.file-editor');
    if (!container) return;

    // Wait for Monaco to be ready
    const monaco = await window.monacoReady;

    const language = getLanguageFromFileName(paneData.fileName || paneData.filePath || '');
    const content = paneData.content || '';

    const editor = monaco.editor.create(container, {
      value: content,
      language: language,
      theme: '49agents-dark',
      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Monaco, monospace',
      fontSize: 13,
      lineHeight: 1.5,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: false,
      wordWrap: 'off',
      tabSize: 2,
      insertSpaces: true,
      renderLineHighlight: 'line',
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      smoothScrolling: true,
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      folding: true,
      glyphMargin: false,
      lineNumbersMinChars: 3,
      padding: { top: 8, bottom: 8 },
      scrollbar: {
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        useShadows: false,
      },
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      overviewRulerBorder: false,
      contextmenu: true,
      fixedOverflowWidgets: true,
    });

    // Store the Monaco instance
    const editorInfo = fileEditors.get(paneData.id);
    if (editorInfo) {
      editorInfo.monacoEditor = editor;
    }

    // Now setup file editor listeners (needs Monaco instance)
    setupFileEditorListeners(paneEl, paneData);

    // Handle layout on pane resize
    const resizeObserver = new ResizeObserver(() => {
      editor.layout();
    });
    resizeObserver.observe(container);
    if (editorInfo) {
      editorInfo.resizeObserver = resizeObserver;
    }

    // Prevent pane drag when clicking inside editor
    container.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });
    container.addEventListener('touchstart', (e) => {
      e.stopPropagation();
    }, { passive: true });
  }

  // DEVICE_COLORS — imported from modules/constants.js

  function getDeviceColor(deviceName) {
    if (!deviceName) return null;
    // User-chosen color takes priority
    if (deviceColorOverrides[deviceName] != null) {
      return DEVICE_COLORS[deviceColorOverrides[deviceName] % DEVICE_COLORS.length];
    }
    // Fall back to hash-based
    let hash = 0;
    for (let i = 0; i < deviceName.length; i++) {
      hash = ((hash << 5) - hash + deviceName.charCodeAt(i)) | 0;
    }
    return DEVICE_COLORS[Math.abs(hash) % DEVICE_COLORS.length];
  }

  function beadsStatusIcon(status, blocked) {
    if (blocked) return '<span class="beads-tag-status beads-status-blocked" data-tooltip="Blocked">\uD83D\uDD12</span>';
    if (status === 'in_progress') return '<span class="beads-tag-status beads-status-progress" data-tooltip="In Progress">\u25D0</span>';
    if (status === 'closed') return '<span class="beads-tag-status beads-status-closed" data-tooltip="Closed">\u25CF</span>';
    return '<span class="beads-tag-status beads-status-open" data-tooltip="Open">\u25CB</span>';
  }

  function claudeSessionBadgeHtml(sessionId, sessionName) {
    if (!sessionId) return '';
    const shortId = escapeHtml(sessionId.slice(0, 8));
    const nameHtml = sessionName
      ? `<span class="claude-session-sep">\u2009\u2014\u2009</span><span class="claude-session-name">${escapeHtml(sessionName.slice(0, 50))}</span>`
      : '';
    return `<span class="claude-session-badge" data-tooltip="${escapeHtml(sessionId)}">${CLAUDE_LOGO_SVG.replace('class="claude-logo"', 'class="claude-session-logo"')}<span class="claude-session-id">${shortId}</span>${nameHtml}</span>`;
  }

  function beadsTagHtml(beadsTag) {
    if (!beadsTag) return '';
    const shortId = beadsTag.id.replace(/^.*-/, '');
    const statusHtml = beadsStatusIcon(beadsTag.status, beadsTag.blocked);
    return `<span class="beads-tag-badge" data-beads-id="${escapeHtml(beadsTag.id)}" data-beads-title="${escapeHtml(beadsTag.title || '')}">${statusHtml}${escapeHtml(shortId)}<span class="beads-tag-remove" data-tooltip="Remove beads tag">&times;</span></span>`;
  }

  async function refreshBeadsTagStatus(pane) {
    try {
      const resp = await cloudFetch('GET', `/api/beads/status/${encodeURIComponent(pane.beadsTag.id)}`);
      if (resp && resp.status) {
        // Auto-remove tag when issue is closed
        if (resp.status === 'closed') {
          pane.beadsTag = undefined;
          cloudSaveLayout(pane);
          const paneEl = document.getElementById(`pane-${pane.id}`);
          if (paneEl) {
            const badge = paneEl.querySelector('.beads-tag-badge');
            if (badge) badge.remove();
          }
          return;
        }
        const blocked = resp.dependency_count > 0 && resp.status !== 'closed';
        if (pane.beadsTag.status !== resp.status || pane.beadsTag.blocked !== blocked) {
          pane.beadsTag.status = resp.status;
          pane.beadsTag.blocked = blocked;
          cloudSaveLayout(pane);
          // Update badge DOM
          const paneEl = document.getElementById(`pane-${pane.id}`);
          if (paneEl) {
            const badge = paneEl.querySelector('.beads-tag-badge');
            if (badge) {
              const statusEl = badge.querySelector('.beads-tag-status');
              if (statusEl) {
                const tmp = document.createElement('span');
                tmp.innerHTML = beadsStatusIcon(resp.status, blocked);
                statusEl.replaceWith(tmp.firstChild);
              }
            }
          }
        }
      }
    } catch (_) { /* silently fail — status will show default */ }
  }

  // Periodic refresh of beads tag statuses (every 30s)
  setInterval(() => {
    for (const pane of state.panes) {
      if (pane.beadsTag && pane.beadsTag.id) {
        refreshBeadsTagStatus(pane);
      }
    }
  }, 30000);

  function deviceLabelHtml(deviceName, extraStyle = '') {
    // Device identity is now shown via header background tint, not a label
    return '';
  }

  function applyDeviceHeaderColor(paneEl, deviceName) {
    if (!deviceName) return;
    const color = getDeviceColor(deviceName);
    if (!color || !color.rgb) return;
    const header = paneEl.querySelector('.pane-header');
    if (!header) return;
    header.style.background = `rgba(${color.rgb}, 0.15)`;
    header.style.borderBottom = `1px solid rgba(${color.rgb}, 0.2)`;
  }

  // escapeHtml — imported from modules/utils.js

  // Expand a pane to full screen
  // ============================================================================
  // SECTION 14: PANE-SPECIFIC RENDERERS                          [Lines ~5087-6427]
  // expandPane()/collapsePane(), renderNotePane() (Monaco markdown),
  // renderIframePane(), renderBeadsPane(), renderFolderPane() (tree view),
  // setupBeadsListeners(), setupIframeListeners(), folder tree operations
  // ============================================================================

  function expandPane(paneId) {
    if (expandedPaneId) return; // Already have an expanded pane
    clearMultiSelect();

    const pane = state.panes.find(p => p.id === paneId);
    if (!pane) return;

    const paneEl = document.getElementById(`pane-${paneId}`);
    if (!paneEl) return;

    expandedPaneId = paneId;
    document.body.classList.add('pane-expanded');

    // Store original position/size for restoration
    paneEl.dataset.originalStyle = paneEl.getAttribute('style') || '';

    // Create backdrop overlay
    const backdrop = document.createElement('div');
    backdrop.className = 'expand-backdrop';
    backdrop.id = 'expand-backdrop';
    backdrop.addEventListener('click', () => collapsePane());
    document.body.appendChild(backdrop);

    // Move pane to body (outside canvas transform) for proper fixed positioning
    document.body.appendChild(paneEl);

    // Add expanded class to pane (CSS will handle fullscreen positioning)
    paneEl.classList.add('expanded');

    // Hide close button, change expand button to collapse button
    const expandBtn = paneEl.querySelector('.pane-expand');
    const closeBtn = paneEl.querySelector('.pane-close');
    if (expandBtn) {
      expandBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 1v5H1"/><path d="M10 1v5h5"/><path d="M6 15v-5H1"/><path d="M10 15v-5h5"/></svg>';
      expandBtn.setAttribute('data-tooltip', 'Minimize (Esc)');
    }
    if (closeBtn) {
      closeBtn.style.display = 'none';
    }


    // Refit terminal if this is a terminal pane
    if (pane.type === 'terminal') {
      const termInfo = terminals.get(paneId);
      if (termInfo) {
        const doFit = () => {
          try {
            if (termInfo.safeFitAndSync) termInfo.safeFitAndSync();
            else termInfo.fitAddon.fit();
            termInfo.xterm.focus();
          } catch (e) {
            console.error('[App] Fit error on expand:', e);
          }
        };
        setTimeout(doFit, 50);
        setTimeout(doFit, 150);

        // Refresh terminal to enable scrolling
        termInfo.xterm.refresh(0, termInfo.xterm.rows - 1);
      }
    }

    // Refit and focus Monaco editor if this is a file pane
    if (pane.type === 'file') {
      const editorInfo = fileEditors.get(pane.id);
      if (editorInfo?.monacoEditor) {
        const doLayout = () => {
          editorInfo.monacoEditor.layout();
          editorInfo.monacoEditor.focus();
        };
        setTimeout(doLayout, 50);
        setTimeout(doLayout, 150);
      }
    }

  }

  // Collapse expanded pane back to normal
  function collapsePane() {
    if (!expandedPaneId) return;

    const paneId = expandedPaneId;
    const pane = state.panes.find(p => p.id === paneId);
    const paneEl = document.getElementById(`pane-${paneId}`);
    const backdrop = document.getElementById('expand-backdrop');


    // Remove backdrop
    if (backdrop) {
      backdrop.remove();
    }

    if (paneEl) {
      // Remove expanded class
      paneEl.classList.remove('expanded');

      // Restore original style
      const originalStyle = paneEl.dataset.originalStyle;
      if (originalStyle) {
        paneEl.setAttribute('style', originalStyle);
      }
      delete paneEl.dataset.originalStyle;

      // Move pane back to canvas
      canvas.appendChild(paneEl);

      // Restore expand button and close button
      const expandBtn = paneEl.querySelector('.pane-expand');
      const closeBtn = paneEl.querySelector('.pane-close');
      if (expandBtn) {
        expandBtn.innerHTML = '⛶';
        expandBtn.setAttribute('data-tooltip', 'Expand');
      }
      if (closeBtn) {
        closeBtn.style.display = '';
      }
    }

    // Clear expanded state
    expandedPaneId = null;
    document.body.classList.remove('pane-expanded');


    // Refit terminal if this is a terminal pane
    if (pane && pane.type === 'terminal') {
      const termInfo = terminals.get(paneId);
      if (termInfo) {
        setTimeout(() => {
          try {
            if (termInfo.safeFitAndSync) termInfo.safeFitAndSync();
            else termInfo.fitAddon.fit();
          } catch (e) {
            console.error('[App] Fit error on collapse:', e);
          }
        }, 50);
      }
    }

    // Relayout Monaco editor if this is a file pane
    if (pane && pane.type === 'file') {
      const editorInfo = fileEditors.get(paneId);
      if (editorInfo?.monacoEditor) {
        setTimeout(() => editorInfo.monacoEditor.layout(), 50);
      }
    }
  }

  // Render a sticky note pane
  function renderNotePane(paneData) {
    const existingPane = document.getElementById(`pane-${paneData.id}`);
    if (existingPane) {
      const oldInfo = noteEditors.get(paneData.id);
      if (oldInfo) {
        if (oldInfo.monacoEditor) oldInfo.monacoEditor.dispose();
        if (oldInfo.resizeObserver) oldInfo.resizeObserver.disconnect();
        noteEditors.delete(paneData.id);
      }
      existingPane.remove();
    }

    const pane = document.createElement('div');
    pane.className = 'pane note-pane';
    pane.id = `pane-${paneData.id}`;
    pane.style.left = `${paneData.x}px`;
    pane.style.top = `${paneData.y}px`;
    pane.style.width = `${paneData.width}px`;
    pane.style.height = `${paneData.height}px`;
    pane.style.zIndex = paneData.zIndex;
    pane.dataset.paneId = paneData.id;

    if (!paneData.shortcutNumber) paneData.shortcutNumber = getNextShortcutNumber();
    const fontSize = paneData.fontSize || 14;

    // Build images HTML
    const images = paneData.images || [];
    let imagesHtml = '';
    if (images.length > 0) {
      imagesHtml = '<div class="note-images">' + images.map((src, idx) =>
        `<div class="note-image-wrapper" data-img-idx="${idx}">
          <img src="${src}" class="note-image" draggable="false" />
          <button class="note-image-copy" data-tooltip="Copy image" data-img-idx="${idx}">⧉</button>
          <button class="note-image-download" data-tooltip="Download image" data-img-idx="${idx}"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 1v5M3 4.5L5 7l2-2.5"/><path d="M1 8.5h8"/></svg></button>
          <button class="note-image-remove" data-tooltip="Remove image" data-img-idx="${idx}">&times;</button>
        </div>`
      ).join('') + '</div>';
    }

    pane.innerHTML = `
      <div class="pane-header">
        <span class="pane-title">\u{1F4DD} Note</span>
        ${paneNameHtml(paneData)}
        <div class="pane-header-right">
          ${shortcutBadgeHtml(paneData)}
          <div class="pane-zoom-controls">
            <button class="pane-zoom-btn zoom-out" data-tooltip="Zoom out">\u2212</button>
            <button class="pane-zoom-btn zoom-in" data-tooltip="Zoom in">+</button>
          </div>
          <button class="note-text-only-btn" aria-label="Preview markdown" data-tooltip="Preview markdown">\u{1F441}</button>
          <button class="pane-close" aria-label="Close pane"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
      </div>
      <div class="pane-content">
        <div class="note-container">
          ${imagesHtml}
          <div class="note-editor-mount"></div>
          <div class="note-markdown-preview" style="display:none;"></div>
        </div>
      </div>
      <div class="pane-resize-handle"></div>
    `;

    setupPaneListeners(pane, paneData);
    canvas.appendChild(pane);

    initNoteMonaco(pane, paneData);
    setupTextOnlyToggle(pane, paneData);
  }

  // Initialize Monaco editor for a note pane (markdown mode)
  async function initNoteMonaco(paneEl, paneData) {
    const mountEl = paneEl.querySelector('.note-editor-mount');
    if (!mountEl) return;

    const monaco = await window.monacoReady;
    const fontSize = paneData.fontSize || 14;

    const editor = monaco.editor.create(mountEl, {
      value: paneData.content || '',
      language: 'markdown',
      theme: '49agents-dark',
      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Monaco, monospace',
      fontSize: fontSize,
      lineHeight: 1.6,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: false,
      wordWrap: 'on',
      tabSize: 2,
      insertSpaces: true,
      renderLineHighlight: 'none',
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      smoothScrolling: true,
      folding: false,
      glyphMargin: false,
      lineNumbers: 'off',
      lineDecorationsWidth: 0,
      lineNumbersMinChars: 0,
      padding: { top: 8, bottom: 8 },
      scrollbar: {
        verticalScrollbarSize: 6,
        horizontalScrollbarSize: 6,
        useShadows: false,
      },
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      overviewRulerBorder: false,
      contextmenu: false,
      fixedOverflowWidgets: true,
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      wordBasedSuggestions: 'off',
      parameterHints: { enabled: false },
      suggest: { enabled: false },
      placeholder: 'Quick notes... (markdown supported)',
    });

    const resizeObserver = new ResizeObserver(() => { editor.layout(); });
    resizeObserver.observe(mountEl);

    noteEditors.set(paneData.id, { monacoEditor: editor, resizeObserver });

    // Auto-save on content change (debounced)
    let saveTimeout = null;
    editor.onDidChangeModelContent(() => {
      const content = editor.getValue();
      paneData.content = content;
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        agentRequest('PATCH', `/api/notes/${paneData.id}`, { content }, paneData.agentId)
          .catch(e => console.error('Failed to save note:', e));
      }, 500);
      cloudSaveNote(paneData.id, content, paneData.fontSize, paneData.images);
    });

    // Prevent pane drag when clicking in editor
    mountEl.addEventListener('mousedown', (e) => e.stopPropagation());
    mountEl.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

    // Image paste handling on Monaco's DOM
    editor.getDomNode().addEventListener('paste', (e) => {
      if (!e.clipboardData || !e.clipboardData.items) return;
      const imageFiles = [];
      for (const item of e.clipboardData.items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const tier = window.__tcTier;
      if (tier && tier.limits && tier.limits.noteImages !== undefined && tier.limits.noteImages !== null) {
        const total = state.panes.filter(p => p.type === 'note' && p.images).reduce((s, p) => s + p.images.length, 0);
        if (total + imageFiles.length > tier.limits.noteImages) {
          showUpgradePrompt(
            `Your ${(tier.tier || 'free').charAt(0).toUpperCase() + (tier.tier || 'free').slice(1)} plan allows ${tier.limits.noteImages} images across all notes. You have ${total}. Upgrade for more.`
          );
          return;
        }
      }
      if (!paneData.images) paneData.images = [];
      Promise.all(imageFiles.map(file => new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      }))).then(dataUrls => {
        const validUrls = dataUrls.filter(Boolean);
        if (validUrls.length === 0) return;
        paneData.images.push(...validUrls);
        refreshNoteImages(paneEl, paneData);
        agentRequest('PATCH', `/api/notes/${paneData.id}`, { images: paneData.images }, paneData.agentId)
          .catch(e => console.error('Failed to save note images:', e));
        cloudSaveNote(paneData.id, paneData.content, paneData.fontSize, paneData.images);
      });
    });

    setupImageButtonHandlers(paneEl, paneData);
  }

  // Helper to refresh images in note pane
  function refreshNoteImages(paneEl, paneData) {
    const container = paneEl.querySelector('.note-container');
    const mountEl = paneEl.querySelector('.note-editor-mount');
    const existing = container.querySelector('.note-images');
    if (existing) existing.remove();
    if (paneData.images && paneData.images.length > 0) {
      const imagesDiv = document.createElement('div');
      imagesDiv.className = 'note-images';
      imagesDiv.innerHTML = paneData.images.map((src, idx) =>
        `<div class="note-image-wrapper" data-img-idx="${idx}">
          <img src="${src}" class="note-image" draggable="false" />
          <button class="note-image-copy" data-tooltip="Copy image" data-img-idx="${idx}">⧉</button>
          <button class="note-image-download" data-tooltip="Download image" data-img-idx="${idx}"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 1v5M3 4.5L5 7l2-2.5"/><path d="M1 8.5h8"/></svg></button>
          <button class="note-image-remove" data-tooltip="Remove image" data-img-idx="${idx}">&times;</button>
        </div>`
      ).join('');
      container.insertBefore(imagesDiv, mountEl);
      setupImageButtonHandlers(paneEl, paneData);
    }
  }

  // Render markdown to HTML for preview mode (sanitized to prevent XSS)
  async function renderMarkdownPreview(markdown) {
    if (window.marked) {
      const raw = await window.marked.parse(markdown || '', { breaks: true, gfm: true });
      return window.DOMPurify ? window.DOMPurify.sanitize(raw) : raw;
    }
    // Fallback: escape HTML and convert newlines
    return escapeHtml(markdown || '').replace(/\n/g, '<br>');
  }

  // Truncate URL for display in pane header
  // truncateUrl — imported from modules/utils.js

  // Render an iframe pane
  function renderIframePane(paneData) {

    const existingPane = document.getElementById(`pane-${paneData.id}`);
    if (existingPane) existingPane.remove();

    const pane = document.createElement('div');
    pane.className = 'pane iframe-pane';
    pane.id = `pane-${paneData.id}`;
    pane.style.left = `${paneData.x}px`;
    pane.style.top = `${paneData.y}px`;
    pane.style.width = `${paneData.width}px`;
    pane.style.height = `${paneData.height}px`;
    pane.style.zIndex = paneData.zIndex;
    pane.dataset.paneId = paneData.id;

    if (!paneData.shortcutNumber) paneData.shortcutNumber = getNextShortcutNumber();
    pane.innerHTML = `
      <div class="pane-header">
        <span class="pane-title">🌐 ${escapeHtml(truncateUrl(paneData.url))}</span>
        ${paneNameHtml(paneData)}
        <div class="pane-header-right">
          ${shortcutBadgeHtml(paneData)}
          <button class="pane-mention-btn" data-tooltip="Mention in Claude Code">@</button>
          <button class="iframe-refresh" aria-label="Refresh" data-tooltip="Refresh"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 3a7 7 0 1 0 1 5"/><polyline points="14 1 14 5 10 5"/></svg></button>
          <button class="iframe-open-external" aria-label="Open in browser" data-tooltip="Open in browser"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 2h4v4"/><path d="M14 2L7 9"/><path d="M13 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4"/></svg></button>
          <button class="iframe-edit-url" aria-label="Edit URL" data-tooltip="Edit URL"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 2l3 3-8 8H3v-3z"/></svg></button>
          <button class="pane-expand" aria-label="Expand pane">⛶</button>
          <button class="pane-close" aria-label="Close pane"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
      </div>
      <div class="pane-content">
        <iframe class="iframe-embed" src="${escapeHtml(paneData.url)}"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                loading="lazy"></iframe>
        <div class="iframe-overlay"></div>
      </div>
      <div class="pane-resize-handle"></div>
    `;

    setupPaneListeners(pane, paneData);
    setupIframeListeners(pane, paneData);
    canvas.appendChild(pane);
  }

  // Setup iframe-specific event listeners
  function setupIframeListeners(paneEl, paneData) {
    const overlay = paneEl.querySelector('.iframe-overlay');
    const iframe = paneEl.querySelector('.iframe-embed');
    const editUrlBtn = paneEl.querySelector('.iframe-edit-url');

    // Mention button
    const mentionBtn = paneEl.querySelector('.pane-mention-btn');
    if (mentionBtn) {
      mentionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        enterMentionMode({
          type: 'iframe',
          text: paneData.url,
          sourceAgentId: paneData.agentId
        });
      });
    }

    // Refresh button
    paneEl.querySelector('.iframe-refresh').addEventListener('click', (e) => {
      e.stopPropagation();
      iframe.src = paneData.url;
    });

    // Open in browser button
    paneEl.querySelector('.iframe-open-external').addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(paneData.url, '_blank');
    });

    editUrlBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      let newUrl = prompt('Enter new URL:', paneData.url);
      if (!newUrl || !newUrl.trim() || newUrl.trim() === paneData.url) return;
      newUrl = newUrl.trim();
      if (!/^https?:\/\//i.test(newUrl)) newUrl = 'http://' + newUrl;

      try {
        new URL(newUrl);
      } catch {
        alert('Invalid URL format');
        return;
      }

      try {
        await agentRequest('PATCH', `/api/iframes/${paneData.id}`, { url: newUrl }, paneData.agentId);
        paneData.url = newUrl;
        iframe.src = newUrl;
        const title = paneEl.querySelector('.pane-title');
        if (title) title.textContent = `🌐 ${truncateUrl(newUrl)}`;
      } catch (err) {
        console.error('Failed to update iframe URL:', err);
      }
    });

    // Click on overlay = user wants to interact with iframe — hide overlay
    paneEl.querySelector('.pane-content').addEventListener('mousedown', (e) => {
      if (e.target === overlay) {
        overlay.style.display = 'none';
      }
    });
  }

  // Show/hide iframe overlays during drag/resize/pan operations
  function showIframeOverlays() {
    document.querySelectorAll('.iframe-overlay').forEach(o => o.style.display = 'block');
  }
  function hideIframeOverlays() {
    document.querySelectorAll('.iframe-overlay').forEach(o => o.style.display = 'none');
  }

  // ==================== Beads Issues Pane ====================

  async function createFolderPane(folderPath, placementPos, targetAgentId, device) {
    const resolvedAgentId = targetAgentId || activeAgentId;
    const position = calcPlacementPos(placementPos, 200, 250);

    try {
      const reqBody = { folderPath, position, size: PANE_DEFAULTS['folder'] };
      if (device) reqBody.device = device;
      const fpPane = await agentRequest('POST', '/api/folder-panes', reqBody, resolvedAgentId);

      const pane = {
        id: fpPane.id,
        type: 'folder',
        x: fpPane.position.x,
        y: fpPane.position.y,
        width: fpPane.size.width,
        height: fpPane.size.height,
        zIndex: state.nextZIndex++,
        folderPath: fpPane.folderPath,
        device: device || fpPane.device || null,
        agentId: resolvedAgentId
      };

      state.panes.push(pane); _telemetry.trackPaneOpen(pane);
      renderFolderPane(pane);
      cloudSaveLayout(pane);
      saveRecentContext('folder', pane.folderPath, pane.folderPath.split('/').filter(Boolean).pop() || pane.folderPath, resolvedAgentId);
    } catch (e) {
      console.error('[App] Failed to create folder pane:', e);
      alert('Failed to create folder pane: ' + e.message);
    }
  }

  async function createBeadsPane(projectPath, placementPos, targetAgentId, device) {
    const resolvedAgentId = targetAgentId || activeAgentId;
    const position = calcPlacementPos(placementPos, 260, 250);

    try {
      const reqBody = { projectPath, position, size: PANE_DEFAULTS['beads'] };
      if (device) reqBody.device = device;
      const bpData = await agentRequest('POST', '/api/beads-panes', reqBody, resolvedAgentId);

      const pane = {
        id: bpData.id,
        type: 'beads',
        x: bpData.position.x,
        y: bpData.position.y,
        width: bpData.size.width,
        height: bpData.size.height,
        zIndex: state.nextZIndex++,
        projectPath: bpData.projectPath,
        device: device || bpData.device || null,
        agentId: resolvedAgentId
      };

      state.panes.push(pane); _telemetry.trackPaneOpen(pane);
      renderBeadsPane(pane);
      cloudSaveLayout(pane);
      saveRecentContext('beads', pane.projectPath, pane.projectPath.split('/').filter(Boolean).pop() || pane.projectPath, resolvedAgentId);
    } catch (e) {
      console.error('[App] Failed to create beads pane:', e);
      alert('Failed to create beads pane: ' + e.message);
    }
  }

  function renderBeadsPane(paneData) {
    const existingPane = document.getElementById(`pane-${paneData.id}`);
    if (existingPane) existingPane.remove();

    const pane = document.createElement('div');
    pane.className = 'pane beads-pane';
    pane.id = `pane-${paneData.id}`;
    pane.style.left = `${paneData.x}px`;
    pane.style.top = `${paneData.y}px`;
    pane.style.width = `${paneData.width}px`;
    pane.style.height = `${paneData.height}px`;
    pane.style.zIndex = paneData.zIndex;
    pane.dataset.paneId = paneData.id;

    if (!paneData.shortcutNumber) paneData.shortcutNumber = getNextShortcutNumber();
    const deviceTag = paneData.device ? deviceLabelHtml(paneData.device) : '';
    pane.innerHTML = `
      <div class="pane-header">
        <span class="pane-title beads-title">
          ${deviceTag}<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align: middle; margin-right: 4px;">${ICON_BEADS}</svg>
          Beads Issues
        </span>
        ${paneNameHtml(paneData)}
        <div class="pane-header-right">
          ${shortcutBadgeHtml(paneData)}
          <div class="pane-zoom-controls">
            <button class="pane-zoom-btn zoom-out" data-tooltip="Zoom out">\u2212</button>
            <button class="pane-zoom-btn zoom-in" data-tooltip="Zoom in">+</button>
          </div>
          <button class="pane-expand" aria-label="Expand pane" data-tooltip="Expand">\u26F6</button>
          <button class="pane-close" aria-label="Close pane"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
      </div>
      <div class="pane-content">
        <div class="beads-container">
          <div class="beads-header">
            <div class="beads-counts">
              <span class="beads-filter-btn beads-badge beads-badge-open active" data-filter="open" data-tooltip="Toggle open issues">\u25CB 0</span>
              <span class="beads-filter-btn beads-badge beads-badge-progress active" data-filter="in_progress" data-tooltip="Toggle in-progress issues">\u25D0 0</span>
              <span class="beads-filter-btn beads-badge beads-badge-blocked active" data-filter="blocked" data-tooltip="Toggle blocked issues">\uD83D\uDD12 0</span>
            </div>
            <div class="beads-search-wrap">
              <input type="text" class="beads-search" placeholder="Search issues..." />
            </div>
            <button class="beads-add-btn" data-tooltip="Create issue">+</button>
          </div>
          <div class="beads-create-form" style="display:none">
            <input type="text" class="beads-create-title" placeholder="Issue title..." />
            <span class="beads-create-type-slot"></span>
            <span class="beads-create-priority-slot"></span>
            <button class="beads-create-submit">\u2714</button>
          </div>
          <div class="beads-table-wrap">
            <table class="beads-table">
              <colgroup>
                <col style="width:24px">
                <col style="width:52px">
                <col style="width:42px">
                <col style="width:58px">
                <col>
              </colgroup>
              <thead>
                <tr>
                  <th class="beads-col-status"><div class="beads-col-resize"></div></th>
                  <th class="beads-col-id">ID<div class="beads-col-resize"></div></th>
                  <th class="beads-col-priority">P<div class="beads-col-resize"></div></th>
                  <th class="beads-col-type">Type<div class="beads-col-resize"></div></th>
                  <th class="beads-col-title">Title</th>
                </tr>
              </thead>
              <tbody class="beads-table-body">
                <tr><td colspan="5" class="beads-loading">Loading issues...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="pane-resize-handle"></div>
    `;

    setupPaneListeners(pane, paneData);
    setupBeadsListeners(pane, paneData);
    canvas.appendChild(pane);

    // Initial data fetch
    fetchBeadsData(pane, paneData);
  }

  function renderFolderPane(paneData) {
    const existingPane = document.getElementById(`pane-${paneData.id}`);
    if (existingPane) existingPane.remove();

    const pane = document.createElement('div');
    pane.className = 'pane folder-pane';
    pane.id = `pane-${paneData.id}`;
    pane.style.left = `${paneData.x}px`;
    pane.style.top = `${paneData.y}px`;
    pane.style.width = `${paneData.width}px`;
    pane.style.height = `${paneData.height}px`;
    pane.style.zIndex = paneData.zIndex;
    pane.dataset.paneId = paneData.id;

    if (!paneData.shortcutNumber) paneData.shortcutNumber = getNextShortcutNumber();
    const shortPath = paneData.folderPath.replace(/^\/home\/[^/]+/, '~');
    const deviceTag = paneData.device ? deviceLabelHtml(paneData.device) : '';

    pane.innerHTML = `
      <div class="pane-header">
        <span class="pane-title folder-title">
          ${deviceTag}<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align: middle; margin-right: 4px;">${ICON_FOLDER}</svg>
          <span class="folder-path-label">${escapeHtml(shortPath)}</span>
        </span>
        ${paneNameHtml(paneData)}
        <div class="pane-header-right">
          ${shortcutBadgeHtml(paneData)}
          <button class="folder-toolbar-btn folder-new-file-btn" data-tooltip="New File">
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" fill="none" stroke="currentColor" stroke-width="2"/><line x1="12" y1="11" x2="12" y2="17" stroke="currentColor" stroke-width="2"/><line x1="9" y1="14" x2="15" y2="14" stroke="currentColor" stroke-width="2"/></svg>
          </button>
          <button class="folder-toolbar-btn folder-new-dir-btn" data-tooltip="New Folder">
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" fill="none" stroke="currentColor" stroke-width="2"/><line x1="12" y1="11" x2="12" y2="17" stroke="currentColor" stroke-width="2"/><line x1="9" y1="14" x2="15" y2="14" stroke="currentColor" stroke-width="2"/></svg>
          </button>
          <button class="folder-toolbar-btn folder-toggle-hidden-btn" data-tooltip="Toggle hidden files">
            <svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" fill="none" stroke="currentColor" stroke-width="2"/></svg>
          </button>
          <button class="folder-toolbar-btn folder-refresh-btn" data-tooltip="Refresh">
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M23 4v6h-6M1 20v-6h6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" fill="none" stroke="currentColor" stroke-width="2"/></svg>
          </button>
          <div class="pane-zoom-controls">
            <button class="pane-zoom-btn zoom-out" data-tooltip="Zoom out">\u2212</button>
            <button class="pane-zoom-btn zoom-in" data-tooltip="Zoom in">+</button>
          </div>
          <button class="pane-expand" aria-label="Expand pane" data-tooltip="Expand">\u26F6</button>
          <button class="pane-close" aria-label="Close pane"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
      </div>
      <div class="folder-git-bar" style="display:none;">
        <svg viewBox="0 0 24 24" width="12" height="12" class="folder-git-icon">
          <circle cx="7" cy="6" r="2" fill="currentColor"/><circle cx="17" cy="6" r="2" fill="currentColor"/><circle cx="7" cy="18" r="2" fill="currentColor"/>
          <line x1="7" y1="8" x2="7" y2="16" stroke="currentColor" stroke-width="1.5"/>
          <path d="M17 8c0 3.5-10 3.5-10 6" stroke="currentColor" stroke-width="1.5" fill="none"/>
        </svg>
        <span class="folder-git-branch"></span>
        <span class="folder-git-status"></span>
        <span class="folder-git-counts"></span>
      </div>
      <div class="pane-content">
        <div class="folder-tree-container">
          <div class="folder-tree-loading">Loading...</div>
        </div>
      </div>
      <div class="pane-resize-handle"></div>
    `;

    const canvas = document.getElementById('canvas');
    canvas.appendChild(pane);
    setupPaneListeners(pane, paneData);

    // Runtime state
    const treeCache = {};
    const expandedPaths = new Set();
    let showHidden = false;
    let gitFileStatus = {}; // absolute path -> 'modified'|'added'|'deleted'|'untracked'|'renamed'
    const treeContainer = pane.querySelector('.folder-tree-container');
    const gitBar = pane.querySelector('.folder-git-bar');

    function getDirGitStatus(dirPath) {
      // A directory inherits the "worst" status of any child file
      const priority = { deleted: 4, added: 3, modified: 2, renamed: 2, untracked: 1 };
      let worst = null, worstP = 0;
      for (const [fp, st] of Object.entries(gitFileStatus)) {
        if (fp.startsWith(dirPath + '/')) {
          const p = priority[st] || 0;
          if (p > worstP) { worstP = p; worst = st; }
        }
      }
      return worst;
    }

    async function fetchGitStatus() {
      try {
        const gs = await agentRequest('GET', `/api/git-status?path=${encodeURIComponent(paneData.folderPath)}`, null, paneData.agentId);
        if (gs.isGit) {
          gitBar.style.display = '';
          gitBar.querySelector('.folder-git-branch').textContent = gs.branch;
          const statusEl = gitBar.querySelector('.folder-git-status');
          if (gs.clean) {
            statusEl.textContent = '\u2713';
            statusEl.className = 'folder-git-status folder-git-clean';
          } else {
            statusEl.textContent = '\u25CF';
            statusEl.className = 'folder-git-status folder-git-dirty';
          }
          const u = gs.uncommitted;
          const parts = [];
          if (u.staged > 0) parts.push(`+${u.staged}`);
          if (u.unstaged > 0) parts.push(`~${u.unstaged}`);
          if (u.untracked > 0) parts.push(`?${u.untracked}`);
          gitBar.querySelector('.folder-git-counts').textContent = parts.join(' ');
          gitFileStatus = gs.files || {};
          renderTree();
        } else {
          gitBar.style.display = 'none';
          gitFileStatus = {};
        }
      } catch {
        gitBar.style.display = 'none';
        gitFileStatus = {};
      }
    }

    async function fetchDir(dirPath) {
      const qs = showHidden ? `?path=${encodeURIComponent(dirPath)}&showHidden=1` : `?path=${encodeURIComponent(dirPath)}`;
      const result = await agentRequest('GET', `/api/files/browse${qs}`, null, paneData.agentId);
      treeCache[dirPath] = result.entries;
      return result.entries;
    }

    function renderTree() {
      treeContainer.innerHTML = '';
      const rootEntries = treeCache[paneData.folderPath];
      if (!rootEntries) {
        treeContainer.innerHTML = '<div class="folder-tree-loading">Loading...</div>';
        return;
      }
      renderEntries(rootEntries, paneData.folderPath, 0, treeContainer);
    }

    function renderEntries(entries, parentPath, depth, container) {
      for (const entry of entries) {
        const fullPath = parentPath + '/' + entry.name;
        const row = document.createElement('div');
        const gitSt = entry.type === 'dir' ? getDirGitStatus(fullPath) : (gitFileStatus[fullPath] || null);
        row.className = 'folder-tree-item' + (entry.type === 'dir' ? ' folder-tree-dir' : ' folder-tree-file') + (gitSt ? ` git-${gitSt}` : '');
        row.style.paddingLeft = `${8 + depth * 16}px`;
        row.dataset.path = fullPath;
        row.dataset.entryType = entry.type;

        const isExpanded = expandedPaths.has(fullPath);

        if (entry.type === 'dir') {
          row.innerHTML = `
            <span class="folder-tree-chevron">${isExpanded ? '&#9660;' : '&#9654;'}</span>
            <svg viewBox="0 0 24 24" width="14" height="14" class="folder-tree-icon"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" fill="none" stroke="currentColor" stroke-width="2"/></svg>
            <span class="folder-tree-name">${escapeHtml(entry.name)}</span>
            <span class="folder-tree-actions">
              <button class="folder-tree-action-btn folder-rename-btn" data-tooltip="Rename">&#9998;</button>
              <button class="folder-tree-action-btn folder-delete-btn" data-tooltip="Delete">&#128465;</button>
            </span>
          `;
        } else {
          const sizeStr = entry.size != null ? formatFileSize(entry.size) : '';
          row.innerHTML = `
            <span class="folder-tree-chevron" style="visibility:hidden">&#9654;</span>
            <svg viewBox="0 0 24 24" width="14" height="14" class="folder-tree-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" fill="none" stroke="currentColor" stroke-width="2"/><polyline points="14 2 14 8 20 8" fill="none" stroke="currentColor" stroke-width="2"/></svg>
            <span class="folder-tree-name">${escapeHtml(entry.name)}</span>
            <span class="folder-tree-size">${sizeStr}</span>
            <span class="folder-tree-actions">
              <button class="folder-tree-action-btn folder-rename-btn" data-tooltip="Rename">&#9998;</button>
              <button class="folder-tree-action-btn folder-delete-btn" data-tooltip="Delete">&#128465;</button>
            </span>
          `;
        }

        container.appendChild(row);

        row.addEventListener('click', async (e) => {
          if (e.target.closest('.folder-tree-action-btn')) return;
          if (entry.type === 'dir') {
            if (isExpanded) {
              expandedPaths.delete(fullPath);
            } else {
              expandedPaths.add(fullPath);
              if (!treeCache[fullPath]) {
                try { await fetchDir(fullPath); } catch(err) { console.error('[Folder] Failed to load', fullPath, err); }
              }
            }
            renderTree();
          } else {
            openFileFromFolder(fullPath, paneData.agentId);
          }
        });

        row.querySelector('.folder-rename-btn')?.addEventListener('click', (e) => {
          e.stopPropagation();
          startInlineRename(row, entry, parentPath);
        });

        row.querySelector('.folder-delete-btn')?.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete "${entry.name}"?`)) return;
          try {
            await agentRequest('DELETE', '/api/files/delete', { path: fullPath }, paneData.agentId);
            if (treeCache[parentPath]) {
              treeCache[parentPath] = treeCache[parentPath].filter(e2 => e2.name !== entry.name);
            }
            if (entry.type === 'dir') {
              delete treeCache[fullPath];
              expandedPaths.delete(fullPath);
            }
            renderTree();
          } catch (err) {
            alert('Delete failed: ' + err.message);
          }
        });

        if (entry.type === 'dir' && isExpanded && treeCache[fullPath]) {
          renderEntries(treeCache[fullPath], fullPath, depth + 1, container);
        }
      }
    }

    function startInlineRename(row, entry, parentPath) {
      const nameSpan = row.querySelector('.folder-tree-name');
      const oldName = entry.name;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = oldName;
      input.className = 'folder-rename-input';
      nameSpan.replaceWith(input);
      input.focus();
      input.select();

      const finish = async (commit) => {
        if (commit && input.value && input.value !== oldName) {
          const oldPath = parentPath + '/' + oldName;
          const newPath = parentPath + '/' + input.value;
          try {
            await agentRequest('POST', '/api/files/rename', { oldPath, newPath }, paneData.agentId);
            entry.name = input.value;
            if (entry.type === 'dir' && treeCache[oldPath]) {
              treeCache[newPath] = treeCache[oldPath];
              delete treeCache[oldPath];
              for (const p of [...expandedPaths]) {
                if (p === oldPath || p.startsWith(oldPath + '/')) {
                  expandedPaths.delete(p);
                  expandedPaths.add(p.replace(oldPath, newPath));
                }
              }
            }
          } catch (err) {
            alert('Rename failed: ' + err.message);
          }
        }
        renderTree();
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
    }

    function formatFileSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' K';
      return (bytes / (1024 * 1024)).toFixed(1) + ' M';
    }

    async function openFileFromFolder(filePath, agentId) {
      try {
        const reqBody = { filePath, position: { x: paneData.x + paneData.width + 20, y: paneData.y }, size: PANE_DEFAULTS['file'] };
        const fp = await agentRequest('POST', '/api/file-panes', reqBody, agentId);
        const newPane = {
          id: fp.id,
          type: 'file',
          x: fp.position.x,
          y: fp.position.y,
          width: fp.size.width,
          height: fp.size.height,
          zIndex: state.nextZIndex++,
          fileName: fp.fileName,
          filePath: fp.filePath,
          content: fp.content,
          device: fp.device || null,
          agentId: agentId
        };
        state.panes.push(newPane); _telemetry.trackPaneOpen(newPane);
        renderFilePane(newPane);
        cloudSaveLayout(newPane);
      } catch (e) {
        alert('Failed to open file: ' + e.message);
      }
    }

    // Toolbar: New File
    pane.querySelector('.folder-new-file-btn').addEventListener('click', async () => {
      const name = prompt('New file name:');
      if (!name) return;
      try {
        await agentRequest('POST', '/api/files/create', { path: paneData.folderPath + '/' + name }, paneData.agentId);
        await refreshTree();
      } catch (e) { alert('Create file failed: ' + e.message); }
    });

    // Toolbar: New Folder
    pane.querySelector('.folder-new-dir-btn').addEventListener('click', async () => {
      const name = prompt('New folder name:');
      if (!name) return;
      try {
        await agentRequest('POST', '/api/files/mkdir', { path: paneData.folderPath + '/' + name }, paneData.agentId);
        await refreshTree();
      } catch (e) { alert('Create folder failed: ' + e.message); }
    });

    // Toolbar: Toggle hidden
    pane.querySelector('.folder-toggle-hidden-btn').addEventListener('click', async () => {
      showHidden = !showHidden;
      pane.querySelector('.folder-toggle-hidden-btn').classList.toggle('active', showHidden);
      Object.keys(treeCache).forEach(k => delete treeCache[k]);
      await refreshTree();
    });

    // Toolbar: Refresh
    pane.querySelector('.folder-refresh-btn').addEventListener('click', () => refreshTree());

    async function refreshTree() {
      const pathsToRefresh = [paneData.folderPath, ...expandedPaths];
      await Promise.all(
        pathsToRefresh.map(p => fetchDir(p).catch(() => null))
      );
      renderTree();
    }

    const refreshInterval = setInterval(() => {
      refreshTree().catch(() => {});
      fetchGitStatus();
    }, 5000);

    folderPanes.set(paneData.id, { refreshInterval });

    fetchDir(paneData.folderPath).then(() => renderTree()).catch(err => {
      treeContainer.innerHTML = `<div style="padding:20px; text-align:center; color:#f44747; font-size:12px;">Error: ${escapeHtml(err.message)}</div>`;
    });
    fetchGitStatus();
  }

  function setupBeadsListeners(paneEl, paneData) {
    // Track issues being closed so refreshes don't bring them back
    if (!paneEl._closedIssues) paneEl._closedIssues = new Set();

    const tableWrap = paneEl.querySelector('.beads-table-wrap');
    const searchInput = paneEl.querySelector('.beads-search');
    // Filter toggle buttons
    paneEl.querySelectorAll('.beads-filter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        btn.classList.toggle('active');
        applyBeadsFilters(paneEl);
      });
      btn.addEventListener('mousedown', (e) => e.stopPropagation());
    });

    // Prevent drag/pan when interacting with scrollable table
    tableWrap.addEventListener('mousedown', (e) => e.stopPropagation());
    tableWrap.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    tableWrap.addEventListener('wheel', (e) => { if (!tabHeld) e.stopPropagation(); }, { passive: true });

    // Search input shouldn't trigger drag
    searchInput.addEventListener('mousedown', (e) => e.stopPropagation());
    searchInput.addEventListener('keydown', (e) => e.stopPropagation());

    // Create issue form
    const addBtn = paneEl.querySelector('.beads-add-btn');
    const createForm = paneEl.querySelector('.beads-create-form');
    const createTitle = paneEl.querySelector('.beads-create-title');
    const typeSlot = paneEl.querySelector('.beads-create-type-slot');
    const createType = createCustomSelect(
      [{ value: 'task', label: 'task' }, { value: 'feature', label: 'feature' }, { value: 'bug', label: 'bug' }],
      'task'
    );
    typeSlot.appendChild(createType.el);

    const prioritySlot = paneEl.querySelector('.beads-create-priority-slot');
    const createPriority = createCustomSelect(
      [{ value: '0', label: 'P0' }, { value: '1', label: 'P1' }, { value: '2', label: 'P2' }, { value: '3', label: 'P3' }, { value: '4', label: 'P4' }],
      '2'
    );
    prioritySlot.appendChild(createPriority.el);
    const createSubmit = paneEl.querySelector('.beads-create-submit');

    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const visible = createForm.style.display !== 'none';
      createForm.style.display = visible ? 'none' : 'flex';
      if (!visible) createTitle.focus();
    });
    addBtn.addEventListener('mousedown', (e) => e.stopPropagation());

    createForm.addEventListener('mousedown', (e) => e.stopPropagation());
    createTitle.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') createSubmit.click();
      if (e.key === 'Escape') { createForm.style.display = 'none'; }
    });

    createSubmit.addEventListener('click', async (e) => {
      e.stopPropagation();
      const title = createTitle.value.trim();
      if (!title) return;
      createSubmit.disabled = true;
      try {
        await agentRequest('POST', `/api/beads-panes/${paneData.id}/issues`, { title, type: createType.value, priority: Number(createPriority.value) }, paneData.agentId);
        createTitle.value = '';
        createForm.style.display = 'none';
        fetchBeadsData(paneEl, paneData);
      } catch (err) {
        console.error('[Beads] Failed to create issue:', err);
      }
      createSubmit.disabled = false;
    });

    // Search filter — reuses shared filter logic
    searchInput.addEventListener('input', () => applyBeadsFilters(paneEl));

    // Row click → expand/collapse detail
    paneEl.addEventListener('click', async (e) => {
      // Done button in detail row
      const doneBtn = e.target.closest('.beads-done-btn');
      if (doneBtn) {
        e.stopPropagation();
        const issueId = doneBtn.dataset.issueId;
        // Remove the row and its detail row immediately
        const detailRow = doneBtn.closest('tr.beads-detail-row');
        const beadsRow = detailRow?.previousElementSibling;
        if (detailRow) detailRow.remove();
        if (beadsRow && beadsRow.classList.contains('beads-row')) beadsRow.remove();
        // Track as closed so refreshes won't bring it back
        paneEl._closedIssues.add(issueId);
        // Close the issue in the background
        agentRequest('POST', `/api/beads-panes/${paneData.id}/issues/${encodeURIComponent(issueId)}/close`, {}, paneData.agentId)
          .catch(err => console.error('[Beads] Failed to close issue:', err));
        return;
      }
      // Beads mention button (@ on row)
      const mentionBtn = e.target.closest('.beads-mention-btn');
      if (mentionBtn) {
        e.stopPropagation();
        const issueId = mentionBtn.dataset.issueId;
        const row = mentionBtn.closest('tr.beads-row');
        const issueTitle = row?.querySelector('.beads-title-text')?.textContent?.trim() || '';
        const issueStatus = row?.dataset.status || 'open';
        const issueBlocked = row?.dataset.blocked === 'true';
        enterMentionMode({
          type: 'beads',
          text: `work on this beads issue: ${issueId}, abide claude.md rules!!!`,
          sourceAgentId: paneData.agentId,
          issueId,
          issueTitle,
          issueStatus,
          issueBlocked
        });
        return;
      }
      const row = e.target.closest('tr.beads-row');
      if (!row) return;
      // In mention mode stage 1, clicking a beads row selects that issue
      if (mentionStage === 1) {
        e.stopPropagation();
        const issueId = row.dataset.issueId;
        if (issueId) {
          const issueTitle = row.querySelector('.beads-title-text')?.textContent?.trim() || '';
          const issueStatus = row.dataset.status || 'open';
          const issueBlocked = row.dataset.blocked === 'true';
          enterMentionMode({
            type: 'beads',
            text: `work on this beads issue: ${issueId}, abide claude.md rules!!!`,
            sourceAgentId: paneData.agentId,
            issueId,
            issueTitle,
            issueStatus,
            issueBlocked
          });
        }
        return;
      }
      const detailRow = row.nextElementSibling;
      if (detailRow && detailRow.classList.contains('beads-detail-row')) {
        detailRow.classList.toggle('expanded');
      }
    });

    // Column resize drag handles
    const cols = paneEl.querySelectorAll('.beads-table colgroup col');
    paneEl.querySelectorAll('.beads-col-resize').forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const th = handle.parentElement;
        const colIndex = Array.from(th.parentElement.children).indexOf(th);
        const col = cols[colIndex];
        if (!col) return;
        const startX = e.clientX;
        const startWidth = th.offsetWidth;

        const onMove = (ev) => {
          const delta = ev.clientX - startX;
          const newWidth = Math.max(16, startWidth + delta);
          col.style.width = newWidth + 'px';
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });

    // Auto-refresh every 10 seconds
    const refreshInterval = setInterval(() => {
      fetchBeadsData(paneEl, paneData);
    }, 10000);

    beadsPanes.set(paneData.id, { refreshInterval });
  }

  async function fetchBeadsData(paneEl, paneData) {
    try {
      const data = await agentRequest('GET', `/api/beads-panes/${paneData.id}/data`, null, paneData.agentId);

      const tbody = paneEl.querySelector('.beads-table-body');

      if (data.error) {
        tbody.innerHTML = `<tr><td colspan="5" class="beads-error">${escapeHtml(data.error)}</td></tr>`;
        return;
      }

      // Filter out issues closed via the done button
      const closedIssues = paneEl._closedIssues || new Set();
      if (closedIssues.size > 0) {
        data.issues = (data.issues || []).filter(i => !closedIssues.has(i.id));
      }

      // Count by status and blocked state (blocked is mutually exclusive with open/in_progress)
      let openCount = 0, progressCount = 0, closedCount = 0, blockedCount = 0;
      for (const issue of (data.issues || [])) {
        const isBlocked = issue.dependency_count > 0 && issue.status !== 'closed';
        if (isBlocked) {
          blockedCount++;
        } else if (issue.status === 'open') {
          openCount++;
        } else if (issue.status === 'in_progress') {
          progressCount++;
        } else if (issue.status === 'closed') {
          closedCount++;
        }
      }

      // Update filter badge counts (preserve active state)
      const openBtn = paneEl.querySelector('.beads-filter-btn[data-filter="open"]');
      const progressBtn = paneEl.querySelector('.beads-filter-btn[data-filter="in_progress"]');
      const blockedBtn = paneEl.querySelector('.beads-filter-btn[data-filter="blocked"]');
      if (openBtn) openBtn.textContent = '\u25CB ' + openCount;
      if (progressBtn) progressBtn.textContent = '\u25D0 ' + progressCount;
      if (blockedBtn) blockedBtn.textContent = '\uD83D\uDD12 ' + blockedCount;

      if (!data.issues || data.issues.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="beads-empty">No issues found</td></tr>';
        return;
      }

      // Sort: non-blocked in_progress first, then non-blocked open, then blocked, then closed; by priority within each group
      const sorted = [...data.issues].sort((a, b) => {
        const aBlocked = a.dependency_count > 0 && a.status !== 'closed';
        const bBlocked = b.dependency_count > 0 && b.status !== 'closed';
        const orderA = aBlocked ? 2 : a.status === 'in_progress' ? 0 : a.status === 'closed' ? 3 : 1;
        const orderB = bBlocked ? 2 : b.status === 'in_progress' ? 0 : b.status === 'closed' ? 3 : 1;
        if (orderA !== orderB) return orderA - orderB;
        const priDiff = (a.priority ?? 2) - (b.priority ?? 2);
        if (priDiff !== 0) return priDiff;
        const typeOrder = { bug: 0, task: 1, feature: 2 };
        return (typeOrder[a.issue_type] ?? 1) - (typeOrder[b.issue_type] ?? 1);
      });

      const searchInput = paneEl.querySelector('.beads-search');
      const currentQuery = (searchInput?.value || '').toLowerCase().trim();

      // Get active filters
      const activeFilters = new Set();
      paneEl.querySelectorAll('.beads-filter-btn.active').forEach(btn => activeFilters.add(btn.dataset.filter));

      let html = '';
      for (const issue of sorted) {
        const isBlocked = issue.dependency_count > 0 && issue.status !== 'closed';
        const statusIcon = isBlocked
          ? '<span class="beads-status-icon beads-status-blocked" data-tooltip="Blocked">\uD83D\uDD12</span>'
          : issue.status === 'in_progress'
          ? '<span class="beads-status-icon beads-status-progress" data-tooltip="In Progress">\u25D0</span>'
          : issue.status === 'closed'
          ? '<span class="beads-status-icon beads-status-closed" data-tooltip="Closed">\u25CF</span>'
          : '<span class="beads-status-icon beads-status-open" data-tooltip="Open">\u25CB</span>';
        const priorityClass = `beads-p${issue.priority ?? 2}`;
        const shortId = issue.id.replace(/^.*-/, '');
        const typeLabel = issue.issue_type || 'task';
        const typeClass = `beads-type-${typeLabel}`;
        const title = escapeHtml(issue.title || '');
        const desc = escapeHtml(issue.description || '');
        const searchText = `${issue.id} ${issue.title || ''} ${issue.description || ''} ${typeLabel}`.toLowerCase();

        // Determine visibility: must pass both search and status filter
        // Blocked issues are a separate category — only shown by the "blocked" filter
        const passesSearch = !currentQuery || searchText.includes(currentQuery);
        let passesFilter;
        if (isBlocked) {
          passesFilter = activeFilters.has('blocked');
        } else if (issue.status === 'closed') {
          passesFilter = false;
        } else {
          passesFilter = activeFilters.has(issue.status);
        }
        const hidden = (!passesSearch || !passesFilter) ? ' style="display:none"' : '';

        const deps = issue.dependency_count ? `<span class="beads-deps" data-tooltip="Dependencies">\u2191${issue.dependency_count}</span>` : '';
        const depnts = issue.dependent_count ? `<span class="beads-depnts" data-tooltip="Dependents">\u2193${issue.dependent_count}</span>` : '';

        html += `<tr class="beads-row" data-issue-id="${escapeHtml(issue.id)}" data-status="${issue.status}" data-blocked="${isBlocked}" data-search-text="${escapeHtml(searchText)}"${hidden}>
          <td class="beads-col-status">${statusIcon}</td>
          <td class="beads-col-id"><span class="beads-id">${escapeHtml(shortId)}</span></td>
          <td class="beads-col-priority"><span class="beads-priority ${priorityClass}">P${issue.priority ?? 2}</span></td>
          <td class="beads-col-type"><span class="beads-type ${typeClass}">${typeLabel}</span></td>
          <td class="beads-col-title"><span class="beads-title-text">${title} ${deps}${depnts}</span><button class="beads-mention-btn" data-issue-id="${escapeHtml(issue.id)}" data-tooltip="Mention in Claude Code">@</button></td>
        </tr>
        <tr class="beads-detail-row" data-status="${issue.status}" data-blocked="${isBlocked}">
          <td colspan="5">
            <div class="beads-detail-content">
              <div class="beads-detail-left">
                <div class="beads-detail-id">${escapeHtml(issue.id)}</div>
                ${desc ? `<div class="beads-detail-desc">${desc}</div>` : '<div class="beads-detail-desc beads-no-desc">No description</div>'}
              </div>
              ${issue.status !== 'closed' ? `<button class="beads-done-btn" data-issue-id="${escapeHtml(issue.id)}" data-tooltip="Close issue">\u2714</button>` : ''}
            </div>
          </td>
        </tr>`;
      }

      // Preserve expanded state across refresh
      const expandedIds = new Set();
      tbody.querySelectorAll('.beads-detail-row.expanded').forEach(row => {
        const beadsRow = row.previousElementSibling;
        if (beadsRow) expandedIds.add(beadsRow.dataset.issueId);
      });

      tbody.innerHTML = html;

      // Restore expanded state
      if (expandedIds.size > 0) {
        tbody.querySelectorAll('.beads-row').forEach(row => {
          if (expandedIds.has(row.dataset.issueId)) {
            const detailRow = row.nextElementSibling;
            if (detailRow && detailRow.classList.contains('beads-detail-row')) {
              detailRow.classList.add('expanded');
            }
          }
        });
      }
    } catch (e) {
      console.error('[App] Failed to fetch beads data:', e);
    }
  }

  function applyBeadsFilters(paneEl) {
    const searchInput = paneEl.querySelector('.beads-search');
    const query = (searchInput?.value || '').toLowerCase().trim();
    const activeFilters = new Set();
    paneEl.querySelectorAll('.beads-filter-btn.active').forEach(btn => activeFilters.add(btn.dataset.filter));

    const rows = paneEl.querySelectorAll('.beads-table-body tr.beads-row');
    rows.forEach(row => {
      const status = row.dataset.status;
      const isBlocked = row.dataset.blocked === 'true';
      const searchText = (row.dataset.searchText || '').toLowerCase();

      const passesSearch = !query || searchText.includes(query);
      let passesFilter;
      if (isBlocked) {
        passesFilter = activeFilters.has('blocked');
      } else if (status === 'closed') {
        passesFilter = false;
      } else {
        passesFilter = activeFilters.has(status);
      }

      const visible = passesSearch && passesFilter;
      row.style.display = visible ? '' : 'none';
      // Also hide/show the detail row that follows
      const detailRow = row.nextElementSibling;
      if (detailRow && detailRow.classList.contains('beads-detail-row')) {
        if (!visible) {
          detailRow.style.display = 'none';
          detailRow.classList.remove('expanded');
        } else {
          detailRow.style.display = '';
        }
      }
    });
  }

  // Setup note editor event listeners
  // ============================================================================
  // SECTION 15: EDITOR & INPUT SETUP                             [Lines ~6428-7203]
  // setupNoteEditorListeners(), setupImageButtonHandlers(),
  // setupTextOnlyToggle(), setupFileEditorListeners(),
  // initTerminal() (~320 lines: xterm config, resize, input forwarding,
  //   paste/clipboard, link detection, mouse reporting for tmux)
  // ============================================================================

  function setupNoteEditorListeners(paneEl, paneData) {
    const editor = paneEl.querySelector('.note-editor');
    const fontSizeEl = paneEl.querySelector('.note-font-size');
    const decreaseBtn = paneEl.querySelector('.font-decrease');
    const increaseBtn = paneEl.querySelector('.font-increase');

    let saveTimeout = null;

    // Helper to save note images (and re-render image area)
    function saveNoteImages() {
      agentRequest('PATCH', `/api/notes/${paneData.id}`, { images: paneData.images }, paneData.agentId)
        .catch(e => console.error('Failed to save note images:', e));
      cloudSaveNote(paneData.id, paneData.content, paneData.fontSize, paneData.images);
    }

    // Helper to re-render the images area in the note
    function refreshNoteImages() {
      const container = paneEl.querySelector('.note-container');
      // Remove existing images section
      const existing = container.querySelector('.note-images');
      if (existing) existing.remove();
      // Re-render if there are images
      if (paneData.images && paneData.images.length > 0) {
        const imagesDiv = document.createElement('div');
        imagesDiv.className = 'note-images';
        imagesDiv.innerHTML = paneData.images.map((src, idx) =>
          `<div class="note-image-wrapper" data-img-idx="${idx}">
            <img src="${src}" class="note-image" draggable="false" />
            <button class="note-image-copy" data-tooltip="Copy image" data-img-idx="${idx}">⧉</button>
          <button class="note-image-download" data-tooltip="Download image" data-img-idx="${idx}"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 1v5M3 4.5L5 7l2-2.5"/><path d="M1 8.5h8"/></svg></button>
          <button class="note-image-remove" data-tooltip="Remove image" data-img-idx="${idx}">&times;</button>
          </div>`
        ).join('');
        // Insert before the textarea
        container.insertBefore(imagesDiv, editor);
        // Attach remove handlers
        setupImageButtonHandlers(paneEl, paneData);
      }
    }

    // Handle image paste within focused note editor
    editor.addEventListener('paste', (e) => {
      if (!e.clipboardData || !e.clipboardData.items) return;
      const imageFiles = [];
      for (const item of e.clipboardData.items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      // Check image limit
      const tier = window.__tcTier;
      if (tier && tier.limits && tier.limits.noteImages !== undefined && tier.limits.noteImages !== null) {
        const total = state.panes.filter(p => p.type === 'note' && p.images).reduce((s, p) => s + p.images.length, 0);
        if (total + imageFiles.length > tier.limits.noteImages) {
          showUpgradePrompt(
            `Your ${(tier.tier || 'free').charAt(0).toUpperCase() + (tier.tier || 'free').slice(1)} plan allows ${tier.limits.noteImages} images across all notes. You have ${total}. Upgrade for more.`
          );
          return;
        }
      }
      if (!paneData.images) paneData.images = [];
      Promise.all(imageFiles.map(file => new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      }))).then(dataUrls => {
        const validUrls = dataUrls.filter(Boolean);
        if (validUrls.length === 0) return;
        paneData.images.push(...validUrls);
        refreshNoteImages();
        saveNoteImages();
      });
    });

    // Auto-save on input (debounced)
    editor.addEventListener('input', () => {
      paneData.content = editor.value;
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        agentRequest('PATCH', `/api/notes/${paneData.id}`, { content: editor.value }, paneData.agentId)
          .catch(e => console.error('Failed to save note:', e));
      }, 500);
      cloudSaveNote(paneData.id, editor.value, paneData.fontSize, paneData.images);
    });

    // Font size controls
    decreaseBtn.addEventListener('click', () => {
      const newSize = Math.max(10, (paneData.fontSize || 16) - 2);
      paneData.fontSize = newSize;
      editor.style.fontSize = `${newSize}px`;
      fontSizeEl.textContent = `${newSize}px`;
      agentRequest('PATCH', `/api/notes/${paneData.id}`, { fontSize: newSize }, paneData.agentId)
        .catch(e => console.error('Failed to save font size:', e));
      cloudSaveNote(paneData.id, paneData.content, newSize, paneData.images);
    });

    increaseBtn.addEventListener('click', () => {
      const newSize = Math.min(90, (paneData.fontSize || 16) + 2);
      paneData.fontSize = newSize;
      editor.style.fontSize = `${newSize}px`;
      fontSizeEl.textContent = `${newSize}px`;
      agentRequest('PATCH', `/api/notes/${paneData.id}`, { fontSize: newSize }, paneData.agentId)
        .catch(e => console.error('Failed to save font size:', e));
      cloudSaveNote(paneData.id, paneData.content, newSize, paneData.images);
    });

    // Spellcheck only when focused
    editor.addEventListener('focus', () => { editor.spellcheck = true; });
    editor.addEventListener('blur', () => { editor.spellcheck = false; });

    // Allow text selection in editor
    editor.addEventListener('mousedown', (e) => e.stopPropagation());
    editor.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

    // Setup image remove handlers
    setupImageButtonHandlers(paneEl, paneData);
  }

  // Setup click handlers for image buttons (copy + remove) in a note pane
  function setupImageButtonHandlers(paneEl, paneData) {
    // Copy buttons
    paneEl.querySelectorAll('.note-image-copy').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.imgIdx, 10);
        if (isNaN(idx) || !paneData.images || !paneData.images[idx]) return;
        const dataUrl = paneData.images[idx];
        // Convert data URL to blob and copy to clipboard
        fetch(dataUrl).then(r => r.blob()).then(blob => {
          const item = new ClipboardItem({ [blob.type]: blob });
          navigator.clipboard.write([item]).then(() => {
            btn.textContent = '✓';
            setTimeout(() => { btn.textContent = '⧉'; }, 1000);
          }).catch(() => {
            btn.textContent = '✗';
            setTimeout(() => { btn.textContent = '⧉'; }, 1000);
          });
        });
      });
    });

    // Download buttons
    paneEl.querySelectorAll('.note-image-download').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.imgIdx, 10);
        if (isNaN(idx) || !paneData.images || !paneData.images[idx]) return;
        const dataUrl = paneData.images[idx];
        const ext = dataUrl.match(/^data:image\/(\w+)/)?.[1] || 'png';
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `note-image-${idx + 1}.${ext}`;
        a.click();
      });
    });

    // Remove buttons
    paneEl.querySelectorAll('.note-image-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.imgIdx, 10);
        if (isNaN(idx) || !paneData.images) return;
        paneData.images.splice(idx, 1);
        // Re-render the images area
        const container = paneEl.querySelector('.note-container');
        const imagesDiv = container.querySelector('.note-images');
        if (imagesDiv) {
          if (paneData.images.length === 0) {
            imagesDiv.remove();
          } else {
            imagesDiv.innerHTML = paneData.images.map((src, i) =>
              `<div class="note-image-wrapper" data-img-idx="${i}">
                <img src="${src}" class="note-image" draggable="false" />
                <button class="note-image-copy" data-tooltip="Copy image" data-img-idx="${i}">⧉</button>
                <button class="note-image-download" data-tooltip="Download image" data-img-idx="${i}"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 1v5M3 4.5L5 7l2-2.5"/><path d="M1 8.5h8"/></svg></button>
                <button class="note-image-remove" data-tooltip="Remove image" data-img-idx="${i}">&times;</button>
              </div>`
            ).join('');
            setupImageButtonHandlers(paneEl, paneData);
          }
        }
        // Save
        agentRequest('PATCH', `/api/notes/${paneData.id}`, { images: paneData.images }, paneData.agentId)
          .catch(e => console.error('Failed to save note images:', e));
        cloudSaveNote(paneData.id, paneData.content, paneData.fontSize, paneData.images);
      });
    });
  }

  // Setup text-only mode toggle for note panes (markdown preview)
  function setupTextOnlyToggle(paneEl, paneData) {
    const eyeBtn = paneEl.querySelector('.note-text-only-btn');
    const mountEl = paneEl.querySelector('.note-editor-mount');
    const previewEl = paneEl.querySelector('.note-markdown-preview');

    async function enterTextOnly() {
      paneEl.classList.add('text-only');
      paneData.textOnly = true;

      // Sync content from Monaco before switching
      const noteInfo = noteEditors.get(paneData.id);
      if (noteInfo?.monacoEditor) {
        paneData.content = noteInfo.monacoEditor.getValue();
      }

      // Hide Monaco, show rendered preview
      mountEl.style.display = 'none';
      previewEl.style.display = 'block';
      previewEl.innerHTML = await renderMarkdownPreview(paneData.content);
      const baseFontSize = paneData.fontSize || 14;
      const scale = (paneData.zoomLevel || 100) / 100;
      previewEl.style.fontSize = `${Math.round(baseFontSize * scale)}px`;

      cloudSaveLayout(paneData);

      // Add floating exit button
      let exitBtn = paneEl.querySelector('.text-only-exit');
      if (!exitBtn) {
        exitBtn = document.createElement('button');
        exitBtn.className = 'text-only-exit';
        exitBtn.innerHTML = '\u{1F441}';
        exitBtn.setAttribute('data-tooltip', 'Back to edit mode');
        exitBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          exitTextOnly();
        });
        paneEl.appendChild(exitBtn);
      }
    }

    function exitTextOnly() {
      paneEl.classList.remove('text-only');
      paneData.textOnly = false;

      // Show Monaco, hide preview
      mountEl.style.display = '';
      previewEl.style.display = 'none';

      const noteInfo = noteEditors.get(paneData.id);
      if (noteInfo?.monacoEditor) {
        noteInfo.monacoEditor.layout();
        noteInfo.monacoEditor.focus();
      }

      cloudSaveLayout(paneData);

      const exitBtn = paneEl.querySelector('.text-only-exit');
      if (exitBtn) exitBtn.remove();
    }

    // Eye button → toggle text-only
    eyeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (paneEl.classList.contains('text-only')) {
        exitTextOnly();
      } else {
        enterTextOnly();
      }
    });

    // Restore text-only mode if previously persisted
    if (paneData.textOnly) {
      paneEl.classList.add('text-only');
      mountEl.style.display = 'none';
      previewEl.style.display = 'block';
      renderMarkdownPreview(paneData.content).then(html => { previewEl.innerHTML = html; });
      const baseFontSize = paneData.fontSize || 14;
      const scale = (paneData.zoomLevel || 100) / 100;
      previewEl.style.fontSize = `${Math.round(baseFontSize * scale)}px`;

      let exitBtn = paneEl.querySelector('.text-only-exit');
      if (!exitBtn) {
        exitBtn = document.createElement('button');
        exitBtn.className = 'text-only-exit';
        exitBtn.innerHTML = '\u{1F441}';
        exitBtn.setAttribute('data-tooltip', 'Back to edit mode');
        exitBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          exitTextOnly();
        });
        paneEl.appendChild(exitBtn);
      }
    }
  }

  // Setup file editor event listeners
  function setupFileEditorListeners(paneEl, paneData) {
    const editorInfo = fileEditors.get(paneData.id);
    const monacoEditor = editorInfo?.monacoEditor;
    if (!monacoEditor) return;

    const saveBtn = paneEl.querySelector('.save-btn');
    const discardBtn = paneEl.querySelector('.discard-btn');
    const reloadBtn = paneEl.querySelector('.reload-btn');
    const statusEl = paneEl.querySelector('.file-status');

    // Mention button
    const mentionBtn = paneEl.querySelector('.pane-mention-btn');
    if (mentionBtn) {
      mentionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        enterMentionMode({
          type: 'file',
          text: paneData.filePath || paneData.fileName || 'untitled',
          sourceAgentId: paneData.agentId
        });
      });
    }

    // Track changes via Monaco's content change event
    monacoEditor.onDidChangeModelContent(() => {
      if (editorInfo) {
        const hasChanges = monacoEditor.getValue() !== editorInfo.originalContent;
        editorInfo.hasChanges = hasChanges;
        saveBtn.classList.toggle('has-changes', hasChanges);
        discardBtn.classList.toggle('has-changes', hasChanges);
        statusEl.textContent = hasChanges ? 'Modified' : '';
      }
    });

    // Save with Ctrl+S / Cmd+S inside editor
    monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveBtn.click();
    });

    // Save button
    saveBtn.addEventListener('click', async () => {
      try {
        const content = monacoEditor.getValue();

        // Check if we have a native file handle for direct save
        const fileHandle = fileHandles.get(paneData.id);
        if (fileHandle) {
          const writable = await fileHandle.createWritable();
          await writable.write(content);
          await writable.close();
        }

        // Also save to server for persistence
        await agentRequest('PATCH', `/api/file-panes/${paneData.id}`, { content }, paneData.agentId);

        // Update state
        paneData.content = content;
        if (editorInfo) {
          editorInfo.originalContent = content;
          editorInfo.hasChanges = false;
        }
        saveBtn.classList.remove('has-changes');
        discardBtn.classList.remove('has-changes');
        statusEl.textContent = 'Saved';
        setTimeout(() => {
          statusEl.textContent = '';
        }, 2000);
      } catch (e) {
        console.error('[App] Failed to save file:', e);
        statusEl.textContent = 'Save failed!';
      }
    });

    // Discard changes button
    discardBtn.addEventListener('click', () => {
      if (editorInfo) {
        monacoEditor.setValue(editorInfo.originalContent);
        editorInfo.hasChanges = false;
        saveBtn.classList.remove('has-changes');
        discardBtn.classList.remove('has-changes');
        statusEl.textContent = 'Discarded';
        setTimeout(() => {
          statusEl.textContent = '';
        }, 2000);
      }
    });

    // Reload button
    reloadBtn.addEventListener('click', async () => {
      try {
        const data = await agentRequest('GET', `/api/file-panes/${paneData.id}?refresh=true`, null, paneData.agentId);

        monacoEditor.setValue(data.content || '');
        paneData.content = data.content;
        if (editorInfo) {
          editorInfo.originalContent = data.content || '';
          editorInfo.hasChanges = false;
        }
        saveBtn.classList.remove('has-changes');
        discardBtn.classList.remove('has-changes');
        statusEl.textContent = 'Reloaded';
        setTimeout(() => {
          statusEl.textContent = '';
        }, 2000);
      } catch (e) {
        console.error('[App] Failed to reload file:', e);
        statusEl.textContent = 'Reload failed!';
      }
    });

    // Refresh file content from server
    const refreshedEl = paneEl.querySelector('.file-refreshed');
    let lastRefreshTime = Date.now();

    function updateRefreshedLabel() {
      const seconds = Math.floor((Date.now() - lastRefreshTime) / 1000);
      if (seconds < 60) {
        refreshedEl.textContent = `${seconds}s ago`;
      } else {
        refreshedEl.textContent = `${Math.floor(seconds / 60)}m ago`;
      }
    }

    async function doRefresh() {
      if (!editorInfo || editorInfo.hasChanges) return;

      try {
        const data = await agentRequest('GET', `/api/file-panes/${paneData.id}?refresh=true`, null, paneData.agentId);

        lastRefreshTime = Date.now();
        updateRefreshedLabel();

        // Only update if content changed and user hasn't modified
        if (data.content !== editorInfo.originalContent && !editorInfo.hasChanges) {
          monacoEditor.setValue(data.content || '');
          paneData.content = data.content;
          editorInfo.originalContent = data.content || '';
        }
      } catch (e) {
        // Silently ignore refresh errors
      }
    }

    // Refresh every 1s if pane is focused, every 30s otherwise
    let refreshInterval = setInterval(doRefresh, 30000);
    const labelInterval = setInterval(updateRefreshedLabel, 1000);

    function setRefreshRate(focused) {
      clearInterval(refreshInterval);
      refreshInterval = setInterval(doRefresh, focused ? 1000 : 30000);
      if (focused) doRefresh();
    }

    monacoEditor.onDidFocusEditorText(() => setRefreshRate(true));
    monacoEditor.onDidBlurEditorText(() => setRefreshRate(false));

    // Store intervals for cleanup
    if (editorInfo) {
      editorInfo.refreshInterval = refreshInterval;
      editorInfo.labelInterval = labelInterval;
      editorInfo._setRefreshRate = setRefreshRate;
    }
  }

  // Initialize xterm.js for a pane
  function initTerminal(paneEl, paneData) {
    const container = paneEl.querySelector('.terminal-container');

    const xterm = new Terminal({
      allowTransparency: true,
      theme: { ...TERMINAL_THEMES[currentTerminalTheme] },
      fontFamily: getTerminalFontFamily(currentTerminalFont),
      fontSize: 13,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 50000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);

    const webLinksAddon = new WebLinksAddon();
    xterm.loadAddon(webLinksAddon);

    xterm.open(container);

    // xterm v6 sets inline background-color on its scrollable element via JS,
    // overriding our transparent theme. Force all direct children transparent.
    container.querySelectorAll('.xterm > div').forEach(el => {
      el.style.backgroundColor = 'transparent';
    });

    // Block middle-click paste on xterm's hidden textarea (Linux X11 primary selection)
    // Only preventDefault — no stopPropagation so middle-mouse panning still works
    const xtermTextarea = container.querySelector('.xterm-helper-textarea');
    if (xtermTextarea) {
      xtermTextarea.addEventListener('mouseup', (e) => {
        if (e.button === 1) e.preventDefault();
      }, true);
    }

    // --- Clipboard support for terminal panes ---
    // xterm.js renders to a <canvas>, so native browser copy doesn't work.
    // Copy: right-click with text selected.
    // Paste: xterm handles natively — its hidden textarea receives paste events,
    // which fire onData and send through WebSocket.

    // --- Drag-and-drop image support ---
    // xterm's paste path only ever forwards text/plain (bracketed-paste
    // wraps whatever getData('text/plain') returns), so image bytes can't
    // ride through a synthesized paste event — Chrome also won't let a
    // script-constructed ClipboardEvent carry real clipboardData anyway.
    // Instead we ship the raw bytes to the agent over the existing
    // websocket; the agent writes a temp file and types its path, which
    // Claude Code's own path auto-detection picks up as an image — the
    // same mechanism a real OS-level drag-drop onto a native terminal uses.
    if (xtermTextarea) {
      let dragDepth = 0;

      const isFileDrag = (e) =>
        e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

      container.addEventListener('dragenter', (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dragDepth++;
        paneEl.classList.add('terminal-drop-target');
      });

      container.addEventListener('dragover', (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      });

      container.addEventListener('dragleave', (e) => {
        if (!isFileDrag(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) paneEl.classList.remove('terminal-drop-target');
      });

      container.addEventListener('drop', async (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dragDepth = 0;
        paneEl.classList.remove('terminal-drop-target');

        const imageFiles = Array.from(e.dataTransfer.files || [])
          .filter(f => f.type.startsWith('image/'));
        if (imageFiles.length === 0) return;

        for (const file of imageFiles) {
          const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1] || '');
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          }).catch(() => null);
          if (!base64) continue;

          sendWs('terminal:pasteImage', {
            terminalId: paneData.id,
            imageData: base64,
            mimeType: file.type,
          }, paneData.agentId);

          // Space each drop apart so the agent's temp-file writes and the
          // typed paths land in the pty in a sane order for multi-image drops.
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      });
    }

    // Track last selection — right-click clears xterm selection before contextmenu fires
    let lastTerminalSelection = '';
    xterm.onSelectionChange(() => {
      const sel = xterm.getSelection();
      if (sel && sel.length > 0) lastTerminalSelection = sel;
    });

    // Pause terminal output writes while mouse is held down so that
    // xterm.js selection can start without being destroyed by incoming
    // tmux redraws (especially in scroll/copy-mode).
    container.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        terminalMouseDown = true;
        console.log(`[DBG-MOUSE] mousedown on ${paneData.id.slice(0,8)} → terminalMouseDown=true`);
      }
    }, true); // capture phase — must fire before zoom interceptor's stopImmediatePropagation
    window.addEventListener('mouseup', () => {
      if (terminalMouseDown) console.log(`[DBG-MOUSE] mouseup → terminalMouseDown=false`);
      terminalMouseDown = false;
    }, true);

    // Right-click on terminal: copy last selected text, always suppress context menu
    container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (lastTerminalSelection && lastTerminalSelection.length > 0) {
        // execCommand fallback works on HTTP; clipboard API for HTTPS
        const textarea = document.createElement('textarea');
        textarea.value = lastTerminalSelection;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(lastTerminalSelection).catch(() => {});
        }
        lastTerminalSelection = '';
        xterm.clearSelection();
      }
    });

    // Fix mouse coordinate offset caused by CSS transforms/zoom.
    // Canvas transform: scale() does NOT affect offsetWidth, so xterm's cell
    // measurements are in unscaled CSS pixels while mouse coords are in scaled
    // viewport pixels. Pane CSS zoom has the same effect — getBoundingClientRect()
    // of xterm's children is scaled but their offsetWidth is not.
    // We correct by dividing by the combined scale (canvas zoom * pane zoom).
    const ZOOM_ADJUSTED = '__zoomAdjusted';
    ['mousemove', 'mousedown', 'mouseup', 'click', 'dblclick'].forEach(evType => {
      container.addEventListener(evType, (e) => {
        const paneZoom = parseFloat(container.style.zoom) || 1;
        const totalZoom = state.zoom * paneZoom;
        if (e[ZOOM_ADJUSTED] || Math.abs(totalZoom - 1) < 0.001 || expandedPaneId || isResizing || isDragging) return;
        // Don't intercept right-click — let contextmenu event fire for copy
        if (e.button === 2) return;

        const rect = container.getBoundingClientRect();
        const adjustedX = rect.left + (e.clientX - rect.left) / totalZoom;
        const adjustedY = rect.top + (e.clientY - rect.top) / totalZoom;

        e.stopImmediatePropagation();
        e.preventDefault();

        const corrected = new MouseEvent(evType, {
          clientX: adjustedX,
          clientY: adjustedY,
          screenX: e.screenX + (adjustedX - e.clientX),
          screenY: e.screenY + (adjustedY - e.clientY),
          button: e.button,
          buttons: e.buttons,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          detail: e.detail,
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(corrected, ZOOM_ADJUSTED, { value: true });
        e.target.dispatchEvent(corrected);
      }, true); // capture phase
    });

    // Ctrl+scroll = canvas zoom. Normal scroll = xterm buffer scroll.
    // When a TUI app (opencode, vim, htop, etc.) enables mouse reporting,
    // re-dispatch the wheel event on xterm's viewport so xterm.js sends
    // mouse escape sequences to the running application.
    // When a TUI app is in alternate screen (reported by tmux via claude:states),
    // send arrow keys so the app receives scroll as navigation.
    const XTERM_WHEEL = Symbol('xterm-wheel');
    container.addEventListener('wheel', (e) => {
      // Skip re-dispatched events from ourselves
      if (e[XTERM_WHEEL]) return;

      // Tab+Scroll: let it bubble to canvas for panning
      if (tabHeld) return;

      e.preventDefault();
      e.stopPropagation();

      if (e.ctrlKey) {
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        setZoom(state.zoom * delta, e.clientX, e.clientY);
        return;
      }

      // TUI app has mouse reporting enabled (htop, opencode, vim with mouse=a)
      // — re-dispatch to xterm's element so it sends mouse sequences to the app
      if (xterm._core?.coreMouseService?.areMouseEventsActive) {
        const xtermEl = container.querySelector('.xterm-screen');
        if (xtermEl) {
          const clone = new WheelEvent('wheel', e);
          Object.defineProperty(clone, XTERM_WHEEL, { value: true });
          xtermEl.dispatchEvent(clone);
        }
        return;
      }

      const lines = e.deltaMode === 1
        ? Math.round(e.deltaY * 1.125)
        : Math.round(e.deltaY / 33) || (e.deltaY > 0 ? 1 : -1);

      // TUI app in alternate screen (tmux reports this via claude:states polling)
      // — send arrow keys so the app scrolls its content
      const termRef = terminals.get(paneData.id);
      if (termRef?._alternateOn) {
        const count = Math.abs(lines);
        const arrow = e.deltaY > 0 ? '\x1b[B' : '\x1b[A';
        if (termRef._attached) {
          const seq = arrow.repeat(count);
          const encoded = btoa(unescape(encodeURIComponent(seq)));
          sendWs('terminal:input', { terminalId: paneData.id, data: encoded }, paneData.agentId);
        }
        return;
      }

      // Normal shell — scroll through xterm's buffer
      xterm.scrollLines(lines);
    }, { passive: false, capture: true });

    // Store terminal info first
    terminals.set(paneData.id, { xterm, fitAddon });

    // Handle terminal input — send immediately for lowest latency.
    xterm.onData((data) => {
      // Don't forward ANY input until terminal:attached is received.
      // During the ttyd/tmux handshake the pty is still in cooked mode
      // (echo ON), so any xterm auto-responses (DA, CPR, etc.) would be
      // echoed back as visible garbage. The user can't type during this
      // window anyway (loading overlay is showing).
      const termRef = terminals.get(paneData.id);
      if (!termRef || !termRef._attached) return;
      const encoded = btoa(unescape(encodeURIComponent(data)));
      // Broadcast mode: send to all selected terminal panes
      if (selectedPaneIds.size > 1) {
        for (const selectedId of selectedPaneIds) {
          const p = state.panes.find(x => x.id === selectedId);
          if (p && p.type === 'terminal') {
            sendWs('terminal:input', { terminalId: selectedId, data: encoded }, getPaneAgentId(selectedId));
          }
        }
      } else {
        sendWs('terminal:input', { terminalId: paneData.id, data: encoded }, paneData.agentId);
      }
    });

    // Handle terminal resize — send to server and track last-sent size
    // for desync detection. No debounce: we always want the server to
    // know xterm's actual dimensions immediately after a fit().
    let lastSentCols = 0, lastSentRows = 0;
    let resizeTimeout = null;
    xterm.onResize(({ cols, rows }) => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        lastSentCols = cols;
        lastSentRows = rows;
        sendWs('terminal:resize', { terminalId: paneData.id, cols, rows }, paneData.agentId);
      }, 100);
    });

    // Guard flag: prevent ResizeObserver from re-triggering fit() when
    // fit() itself changes the terminal element size.
    let fitting = false;

    function safeFit() {
      if (fitting) return;
      fitting = true;
      try {
        fitAddon.fit();
      } catch (e) {
        // Ignore fit errors
      } finally {
        // Release guard after a microtask so the ResizeObserver callback
        // (which fires asynchronously) still sees fitting=true.
        Promise.resolve().then(() => { fitting = false; });
      }
    }

    // After any fit, make sure the server knows the final size.
    // This catches cases where rapid fits cancel each other's debounced
    // onResize, leaving tmux with a stale row/col count.
    function safeFitAndSync() {
      safeFit();
      // Schedule a sync after the debounce window settles
      scheduleSizeSync();
    }

    let syncTimeout = null;
    function scheduleSizeSync() {
      if (syncTimeout) clearTimeout(syncTimeout);
      syncTimeout = setTimeout(() => {
        const cols = xterm.cols, rows = xterm.rows;
        if (cols !== lastSentCols || rows !== lastSentRows) {
          lastSentCols = cols;
          lastSentRows = rows;
          sendWs('terminal:resize', { terminalId: paneData.id, cols, rows }, paneData.agentId);
        }
      }, 250); // after the 100ms onResize debounce settles
    }

    // Expose safeFitAndSync on termInfo so external code (expand, zoom,
    // manual resize) can use the guarded fit instead of raw fitAddon.fit()
    terminals.get(paneData.id).safeFitAndSync = safeFitAndSync;

    // Fit after container is ready, then attach
    setTimeout(() => {
      try {
        safeFit();
        // Now attach terminal after fit
        const pane = state.panes.find(p => p.id === paneData.id);
        if (pane) {
          attachTerminal(pane);
        }
      } catch (e) {
        console.error('[App] Fit error:', e);
      }
    }, 100);

    // Second fit after container layout fully settles — fixes race
    // where initial fit calculates wrong row count, leaving the
    // bottom 100-200px of the terminal unreachable.
    setTimeout(() => {
      safeFitAndSync();
    }, 2000);

    // Setup debounced resize observer — guarded against fit() feedback
    let observerTimeout = null;
    const resizeObserver = new ResizeObserver(() => {
      if (fitting) return; // skip: this was triggered by fit() itself
      if (observerTimeout) clearTimeout(observerTimeout);
      observerTimeout = setTimeout(() => {
        safeFitAndSync();
      }, 100);
    });
    resizeObserver.observe(container);

    // Periodic desync recovery: every 10s, if xterm's size doesn't match
    // what we last told the server, re-send the resize and force a full
    // terminal refresh so tmux repaints all rows.
    const desyncInterval = setInterval(() => {
      if (!terminals.has(paneData.id)) { clearInterval(desyncInterval); return; }
      const cols = xterm.cols, rows = xterm.rows;
      if (cols !== lastSentCols || rows !== lastSentRows) {
        console.log(`[DESYNC] Terminal ${paneData.id.slice(0,8)}: xterm=${cols}x${rows} server=${lastSentCols}x${lastSentRows} — resyncing`);
        lastSentCols = cols;
        lastSentRows = rows;
        sendWs('terminal:resize', { terminalId: paneData.id, cols, rows }, paneData.agentId);
        // Force xterm to repaint all visible rows
        xterm.refresh(0, rows - 1);
      }
    }, 10000);
  }

  // Setup pane event listeners
  // Shared pane zoom function — handles ALL pane types
  // ============================================================================
  // SECTION 16: PANE INTERACTION & LAYOUT                        [Lines ~7204-8183]
  // applyPaneZoom(), setupPaneListeners() (~500 lines: click, drag, resize,
  //   context menu, header actions, broadcast selection, renaming),
  // findSnapTargets(), findResizeSnapTargets(), snap guides,
  // startDrag(), startResizeHold()/activateResize()
  // ============================================================================

  function applyPaneZoom(paneData, paneEl) {
    const scale = (paneData.zoomLevel || 100) / 100;
    if (paneData.type === 'terminal') {
      // Use CSS zoom instead of xterm fontSize — changing fontSize corrupts
      // xterm v6's selection rendering (stale cell dimension cache). CSS zoom
      // scales at browser layout level so xterm internals stay consistent.
      const container = paneEl.querySelector('.terminal-container');
      const termInfo = terminals.get(paneData.id);
      if (container && termInfo) {
        container.style.zoom = scale === 1 ? '' : scale;
        if (termInfo.safeFitAndSync) termInfo.safeFitAndSync();
        else termInfo.fitAddon.fit();
      }
    } else if (paneData.type === 'file') {
      const edInfo = fileEditors.get(paneData.id);
      if (edInfo?.monacoEditor) edInfo.monacoEditor.updateOptions({ fontSize: Math.round(13 * scale) });
    } else if (paneData.type === 'note') {
      const noteInfo = noteEditors.get(paneData.id);
      if (noteInfo?.monacoEditor) {
        noteInfo.monacoEditor.updateOptions({ fontSize: Math.round((paneData.fontSize || 14) * scale) });
      }
      const preview = paneEl.querySelector('.note-markdown-preview');
      if (preview) preview.style.fontSize = `${Math.round((paneData.fontSize || 14) * scale)}px`;
    } else if (paneData.type === 'git-graph') {
      const graphContent = paneEl.querySelector('.git-graph-output');
      if (graphContent) graphContent.style.fontSize = `${Math.round(12 * scale)}px`;
    } else if (paneData.type === 'beads') {
      const beadsContainer = paneEl.querySelector('.beads-container');
      if (beadsContainer) beadsContainer.style.zoom = scale === 1 ? '' : scale;
    } else if (paneData.type === 'folder') {
      const treeContainer = paneEl.querySelector('.folder-tree-container');
      if (treeContainer) treeContainer.style.fontSize = `${Math.round(13 * scale)}px`;
    }
  }

  function setupPaneListeners(paneEl, paneData) {
    const header = paneEl.querySelector('.pane-header');
    const closeBtn = paneEl.querySelector('.pane-close');
    const expandBtn = paneEl.querySelector('.pane-expand');
    const resizeHandle = paneEl.querySelector('.pane-resize-handle');
    const zoomInBtn = paneEl.querySelector('.zoom-in');
    const zoomOutBtn = paneEl.querySelector('.zoom-out');

    // New tab button
    const newTabBtn = paneEl.querySelector('.pane-new-tab');
    if (newTabBtn) {
      newTabBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        createTabInGroup(paneData.id);
      });
      newTabBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    }

    // Apply device color to header
    applyDeviceHeaderColor(paneEl, paneData.device);

    // Initialize zoom level for this pane
    if (!paneData.zoomLevel) paneData.zoomLevel = 100;
    if (paneData.zoomLevel !== 100) {
      applyPaneZoom(paneData, paneEl);
    }

    const applyZoom = () => applyPaneZoom(paneData, paneEl);

    // Pane name: double-click to edit
    const paneNameEl = paneEl.querySelector('.pane-name');
    if (paneNameEl) {
      paneNameEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (paneEl.querySelector('.pane-name-input')) return;

        const input = document.createElement('input');
        input.className = 'pane-name-input';
        input.type = 'text';
        input.value = paneData.paneName || '';
        input.placeholder = 'Name';
        input.maxLength = 50;

        paneNameEl.style.display = 'none';
        header.appendChild(input);
        input.focus();
        input.select();

        const commit = () => {
          const val = input.value.trim();
          paneData.paneName = val || '';
          input.remove();
          paneNameEl.style.display = '';
          if (val) {
            paneNameEl.textContent = val;
            paneNameEl.classList.remove('empty');
          } else {
            paneNameEl.textContent = 'Name';
            paneNameEl.classList.add('empty');
          }
          cloudSaveLayout(paneData);
          if (paneData.tabGroupId) refreshTabBars(paneData.tabGroupId);
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (ke) => {
          if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
          if (ke.key === 'Escape') {
            input.removeEventListener('blur', commit);
            input.remove();
            paneNameEl.style.display = '';
          }
          ke.stopPropagation();
        });
        // Prevent header drag while typing
        input.addEventListener('mousedown', (me) => me.stopPropagation());
      });
      // Single click should not start drag
      paneNameEl.addEventListener('mousedown', (e) => e.stopPropagation());
    }

    // Shortcut badge click: open assign popup (delegated so it works after badge replacement)
    paneEl.addEventListener('click', (e) => {
      const badge = e.target.closest('.pane-shortcut-badge');
      if (!badge) return;
      e.stopPropagation();
      showShortcutAssignPopup(paneData);
    });
    paneEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('.pane-shortcut-badge')) {
        e.stopPropagation();
      }
    });

    if (zoomInBtn) {
      zoomInBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        paneData.zoomLevel = Math.min(500, paneData.zoomLevel + 10);
        applyZoom();
        cloudSaveLayout(paneData);
      });
    }

    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        paneData.zoomLevel = Math.max(20, paneData.zoomLevel - 10);
        applyZoom();
        cloudSaveLayout(paneData);
      });
    }

    // Refresh history button (terminal panes only) — re-runs the full
    // attach cycle: clears xterm, resets flags, sends terminal:attach.
    // The agent re-captures tmux history, sends it, then force-redraws.
    // This is equivalent to what happens on a page reload.
    const refreshHistoryBtn = paneEl.querySelector('.term-refresh-history');
    if (refreshHistoryBtn) {
      refreshHistoryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        reattachTerminal(paneData);
      });
    }

    // Beads tag removal via X button
    paneEl.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.beads-tag-remove');
      if (!removeBtn) return;
      e.stopPropagation();
      const badge = removeBtn.closest('.beads-tag-badge');
      if (badge) {
        paneData.beadsTag = undefined;
        badge.remove();
        cloudSaveLayout(paneData);
      }
    });

    // Pane header hover — show overlay with beads + Claude session info
    if (header) {
      header.addEventListener('mouseenter', () => {
        if (paneEl.querySelector('.pane-hover-overlay')) return;
        const hasBeads = !!paneData.beadsTag;
        const hasSession = !!paneData.claudeSessionId;
        if (!hasBeads && !hasSession) return;

        const overlay = document.createElement('div');
        overlay.className = 'pane-hover-overlay';
        let html = '';

        // Claude session card (above beads)
        if (hasSession) {
          const nameText = paneData.claudeSessionName ? escapeHtml(paneData.claudeSessionName.slice(0, 50)) : '';
          html += `<div class="claude-session-card">
            <div class="claude-session-card-id">${CLAUDE_LOGO_SVG.replace('class="claude-logo"', 'class="claude-session-card-logo"')}${escapeHtml(paneData.claudeSessionId)}</div>
            ${nameText ? `<div class="claude-session-card-name">${nameText}</div>` : ''}
          </div>`;
        }

        // Beads card
        if (hasBeads) {
          html += `<div class="beads-hover-card">
            <div class="beads-hover-id"><svg viewBox="0 0 24 24" width="14" height="14">${ICON_BEADS}</svg>${escapeHtml(paneData.beadsTag.id)}</div>
            <div class="beads-hover-title">${escapeHtml((paneData.beadsTag.title || '').slice(0, 100))}</div>
          </div>`;
        }

        overlay.innerHTML = html;
        paneEl.appendChild(overlay);
      });

      header.addEventListener('mouseleave', () => {
        const overlay = paneEl.querySelector('.pane-hover-overlay');
        if (overlay) overlay.remove();
      });
    }

    // Beads tag icon button — add or edit beads issue tag (with autocomplete)
    const beadsBtn = paneEl.querySelector('.beads-tag-btn');
    if (beadsBtn) {
      beadsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (paneEl.querySelector('.beads-tag-input')) return;

        const input = document.createElement('input');
        input.className = 'beads-tag-input';
        input.type = 'text';
        input.value = paneData.beadsTag?.id || '';
        input.placeholder = 'search issues...';
        input.maxLength = 80;

        const titleEl = paneEl.querySelector('.pane-title');
        const terminalSpan = titleEl.querySelector('span[style*="opacity"]') || titleEl.querySelector('.claude-header');
        if (terminalSpan) {
          titleEl.insertBefore(input, terminalSpan);
        } else {
          titleEl.appendChild(input);
        }

        // Autocomplete dropdown
        const dropdown = document.createElement('div');
        dropdown.className = 'beads-autocomplete';
        paneEl.appendChild(dropdown);

        let allIssues = [];
        let highlightIdx = -1;
        let selectedIssue = null;

        // Fetch issues for autocomplete
        cloudFetch('GET', '/api/beads/issues').then(issues => {
          allIssues = issues || [];
          renderDropdown();
        }).catch(() => {});

        function renderDropdown() {
          const query = input.value.trim().toLowerCase();
          const filtered = query
            ? allIssues.filter(i => i.id.toLowerCase().includes(query) || (i.title || '').toLowerCase().includes(query))
            : allIssues;
          if (filtered.length === 0) {
            dropdown.innerHTML = '<div class="beads-autocomplete-empty">No matching issues</div>';
            highlightIdx = -1;
            return;
          }
          highlightIdx = Math.min(highlightIdx, filtered.length - 1);
          dropdown.innerHTML = filtered.map((issue, idx) => {
            const shortId = issue.id.replace(/^.*-/, '');
            const blocked = issue.dependency_count > 0;
            const statusIcon = blocked ? '\uD83D\uDD12' : issue.status === 'in_progress' ? '\u25D0' : '\u25CB';
            const statusClass = blocked ? 'beads-status-blocked' : issue.status === 'in_progress' ? 'beads-status-progress' : 'beads-status-open';
            const active = idx === highlightIdx ? ' beads-autocomplete-active' : '';
            return `<div class="beads-autocomplete-row${active}" data-idx="${idx}" data-issue-id="${escapeHtml(issue.id)}"><span class="beads-tag-status ${statusClass}">${statusIcon}</span><span class="beads-ac-id">${escapeHtml(shortId)}</span><span class="beads-ac-title">${escapeHtml((issue.title || '').slice(0, 50))}</span></div>`;
          }).join('');
          // Scroll active into view
          const activeEl = dropdown.querySelector('.beads-autocomplete-active');
          if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
        }

        function selectIssue(issue) {
          selectedIssue = issue;
          input.value = issue.id;
          commitBeadsTag();
        }

        dropdown.addEventListener('mousedown', (ev) => {
          ev.preventDefault(); // Prevent blur
          const row = ev.target.closest('.beads-autocomplete-row');
          if (row) {
            const issueId = row.dataset.issueId;
            const issue = allIssues.find(i => i.id === issueId);
            if (issue) selectIssue(issue);
          }
        });

        input.addEventListener('input', () => {
          highlightIdx = -1;
          selectedIssue = null;
          renderDropdown();
        });

        input.focus();
        input.select();

        function commitBeadsTag() {
          const val = input.value.trim();
          input.remove();
          dropdown.remove();
          const oldId = paneData.beadsTag?.id || '';
          if (val !== oldId) {
            if (val) {
              if (selectedIssue) {
                const blocked = selectedIssue.dependency_count > 0 && selectedIssue.status !== 'closed';
                paneData.beadsTag = { id: selectedIssue.id, title: selectedIssue.title || '', status: selectedIssue.status, blocked };
              } else {
                paneData.beadsTag = { id: val, title: '' };
              }
            } else {
              paneData.beadsTag = undefined;
            }
            const existing = titleEl.querySelector('.beads-tag-badge');
            if (existing) existing.remove();
            if (val) {
              const temp = document.createElement('span');
              temp.innerHTML = beadsTagHtml(paneData.beadsTag);
              const badge = temp.firstChild;
              const insertBefore = titleEl.querySelector('span[style*="opacity"]') || titleEl.querySelector('.claude-header');
              if (insertBefore) titleEl.insertBefore(badge, insertBefore);
              else titleEl.appendChild(badge);
              if (!selectedIssue) refreshBeadsTagStatus(paneData);
            }
            cloudSaveLayout(paneData);
          }
        }

        input.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          const rows = dropdown.querySelectorAll('.beads-autocomplete-row');
          if (ev.key === 'ArrowDown') {
            ev.preventDefault();
            highlightIdx = Math.min(highlightIdx + 1, rows.length - 1);
            renderDropdown();
          } else if (ev.key === 'ArrowUp') {
            ev.preventDefault();
            highlightIdx = Math.max(highlightIdx - 1, 0);
            renderDropdown();
          } else if (ev.key === 'Enter') {
            if (highlightIdx >= 0 && rows[highlightIdx]) {
              const issueId = rows[highlightIdx].dataset.issueId;
              const issue = allIssues.find(i => i.id === issueId);
              if (issue) { selectIssue(issue); return; }
            }
            commitBeadsTag();
          } else if (ev.key === 'Escape') {
            input.remove();
            dropdown.remove();
          }
        });

        input.addEventListener('blur', () => {
          setTimeout(() => {
            if (input.parentElement) commitBeadsTag();
          }, 150);
        });
      });
    }

    // Use capture phase to intercept events before xterm.js handles them
    // This ensures focus works even when clicking inside the terminal
    paneEl.addEventListener('mousedown', (e) => {

      // In Quick View or device hover, the overlay handles all interactions — don't intercept
      if (quickViewActive || deviceHoverActive) return;
      // Don't steal focus from HUD inputs or other external interactive elements
      if (isExternalInputFocused()) return;
      if (moveModeActive) return;
      // Ctrl+Shift+Click: toggle fullscreen
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (expandedPaneId === paneData.id) {
          collapsePane();
        } else {
          expandPane(paneData.id);
        }
        return;
      }
      // Shift+Click: toggle broadcast selection (any pane type)
      if (e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        togglePaneSelection(paneData.id);
        updateBroadcastIndicator();
        if (selectedPaneIds.has(paneData.id)) {
          focusPane(paneData);
          focusTerminalInput(paneData.id);
        }
        return;
      }
      // Normal click on a broadcast-selected pane: keep selection, just focus
      if (selectedPaneIds.has(paneData.id)) {
        focusPane(paneData);
        focusTerminalInput(paneData.id);
        return;
      }
      // Normal click outside broadcast group: clear selection
      if (selectedPaneIds.size > 0) {
        clearMultiSelect();
      }
      focusPane(paneData);
      focusTerminalInput(paneData.id);
    }, true); // capture phase

    // Track touch start position for tap-vs-drag detection
    let _touchStartX = 0;
    let _touchStartY = 0;
    let _touchStartTime = 0;

    paneEl.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches.length === 1) {
        _touchStartX = e.touches[0].clientX;
        _touchStartY = e.touches[0].clientY;
        _touchStartTime = Date.now();
      }
      focusPane(paneData);
      focusTerminalInput(paneData.id);
    }, { passive: true, capture: true });

    // Auto-fullscreen panes on phone tap (all pane types)
    paneEl.addEventListener('touchend', (e) => {
      if (window.innerWidth > 768) return;
      if (expandedPaneId) return;
      if (quickViewActive || deviceHoverActive) return;
      const touch = e.changedTouches && e.changedTouches[0];
      if (!touch) return;
      const dx = Math.abs(touch.clientX - _touchStartX);
      const dy = Math.abs(touch.clientY - _touchStartY);
      const elapsed = Date.now() - _touchStartTime;
      if (dx < 15 && dy < 15 && elapsed < 400) {
        expandPane(paneData.id);
      }
    }, { passive: true });

    // Focus pane and terminal input on hover
    paneEl.addEventListener('mouseenter', () => {
      // In Quick View or device hover: no focus, no overlay removal — just a hover hint
      if (quickViewActive || deviceHoverActive) {
        paneEl.classList.add('qv-hover');
        return;
      }
      if (isPanning) return; // middle-mouse panning — skip focus changes
      if (moveModeActive) return;
      // Don't steal focus from interactive elements outside panes (e.g. HUD search inputs)
      if (isExternalInputFocused()) return;
      if (focusMode !== 'hover') return; // click-to-focus mode: hover doesn't focus
      paneEl.classList.add('focused');
      focusPane(paneData);
      focusTerminalInput(paneData.id);

      // Focus note editor and place cursor at end
      const noteEditor = paneEl.querySelector('.note-editor');
      if (noteEditor) {
        noteEditor.focus();
        noteEditor.scrollTop = noteEditor.scrollHeight;
        noteEditor.selectionStart = noteEditor.selectionEnd = noteEditor.value.length;
      }
    });

    paneEl.addEventListener('mouseleave', (e) => {
      // In Quick View or device hover: just remove hover hint
      if (quickViewActive || deviceHoverActive) {
        paneEl.classList.remove('qv-hover');
        return;
      }
      if (moveModeActive) return;
      if (focusMode !== 'hover') return; // click-to-focus: don't blur on leave
      if (!isDragging && !isResizing && !isPanning) {
        const termInfo = terminals.get(paneData.id);
        const hasSelection = termInfo && termInfo.xterm && termInfo.xterm.hasSelection();
        const isSelectDrag = (e.buttons & 1) !== 0; // primary button still held

        // Don't blur terminal if the user has selected text or is mid-drag —
        // xterm.blur() clears the canvas selection highlight, which breaks
        // right-click copy. Focus transfers naturally on the next mousedown.
        if (!hasSelection && !isSelectDrag) {
          if (termInfo && termInfo.xterm) termInfo.xterm.blur();

          // Blur any other focused element inside the pane
          if (document.activeElement && paneEl.contains(document.activeElement)) {
            document.activeElement.blur();
          }
        }

        paneEl.classList.remove('focused');
      }
    });

    // Header drag - immediate, no hold needed
    header.addEventListener('mousedown', (e) => {
      if (e.target === closeBtn || e.target.classList.contains('connection-status')) return;
      // Ctrl+Shift+Click on header also triggers fullscreen (handled by capture listener above)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) return;
      e.stopPropagation();
      startDrag(e, paneEl, paneData);
    });
    header.addEventListener('touchstart', (e) => {
      if (e.target === closeBtn || e.target.classList.contains('connection-status')) return;
      e.stopPropagation();
      startDrag(e, paneEl, paneData);
    }, { passive: false });

    // Close button
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (paneData.tabGroupId) closeTabInGroup(paneData.id);
      else deletePane(paneData.id);
    });
    closeBtn.addEventListener('touchend', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (paneData.tabGroupId) closeTabInGroup(paneData.id);
      else deletePane(paneData.id);
    });

    // Expand/Collapse button (only for terminal and file panes, not notes)
    if (expandBtn) {
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (expandedPaneId === paneData.id) {
          collapsePane();
        } else {
          expandPane(paneData.id);
        }
      });
      expandBtn.addEventListener('touchend', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (expandedPaneId === paneData.id) {
          collapsePane();
        } else {
          expandPane(paneData.id);
        }
      });
    }

    // Resize handle - short hold then drag
    resizeHandle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      startResizeHold(e, paneEl, paneData);
    });
    resizeHandle.addEventListener('touchstart', (e) => {
      e.stopPropagation();
      startResizeHold(e, paneEl, paneData);
    }, { passive: false });
  }

  // Find closest snap targets for a pane being dragged (independent X and Y)
  function findSnapTargets(draggedPane, draggedX, draggedY, excludeIds) {
    const dRight = draggedX + draggedPane.width;
    const dBottom = draggedY + draggedPane.height;

    let bestX = null;
    let bestDistX = SNAP_THRESHOLD + 1;
    let bestY = null;
    let bestDistY = SNAP_THRESHOLD + 1;

    for (const other of state.panes) {
      if (other.id === draggedPane.id) continue;
      if (excludeIds && excludeIds.has(other.id)) continue;
      const el = document.getElementById(`pane-${other.id}`);
      if (!el || el.style.display === 'none') continue;

      const oLeft = other.x;
      const oRight = other.x + other.width;
      const oTop = other.y;
      const oBottom = other.y + other.height;

      // Check vertical overlap (needed for left/right snapping)
      const vOverlap = draggedY < oBottom && dBottom > oTop;
      // Check horizontal overlap (needed for top/bottom snapping)
      const hOverlap = draggedX < oRight && dRight > oLeft;

      // Right edge of dragged -> Left edge of other
      if (vOverlap) {
        const dist = Math.abs(dRight + SNAP_GAP - oLeft);
        if (dist < bestDistX) {
          bestDistX = dist;
          bestX = { adjustX: oLeft - draggedPane.width - SNAP_GAP, edge: oLeft - SNAP_GAP / 2, orientation: 'vertical',
            top: Math.max(draggedY, oTop), bottom: Math.min(dBottom, oBottom), otherId: other.id };
        }
      }

      // Left edge of dragged -> Right edge of other
      if (vOverlap) {
        const dist = Math.abs(draggedX - SNAP_GAP - oRight);
        if (dist < bestDistX) {
          bestDistX = dist;
          bestX = { adjustX: oRight + SNAP_GAP, edge: oRight + SNAP_GAP / 2, orientation: 'vertical',
            top: Math.max(draggedY, oTop), bottom: Math.min(dBottom, oBottom), otherId: other.id };
        }
      }

      // Bottom edge of dragged -> Top edge of other
      if (hOverlap) {
        const dist = Math.abs(dBottom + SNAP_GAP - oTop);
        if (dist < bestDistY) {
          bestDistY = dist;
          bestY = { adjustY: oTop - draggedPane.height - SNAP_GAP, edge: oTop - SNAP_GAP / 2, orientation: 'horizontal',
            left: Math.max(draggedX, oLeft), right: Math.min(dRight, oRight), otherId: other.id };
        }
      }

      // Top edge of dragged -> Bottom edge of other
      if (hOverlap) {
        const dist = Math.abs(draggedY - SNAP_GAP - oBottom);
        if (dist < bestDistY) {
          bestDistY = dist;
          bestY = { adjustY: oBottom + SNAP_GAP, edge: oBottom + SNAP_GAP / 2, orientation: 'horizontal',
            left: Math.max(draggedX, oLeft), right: Math.min(dRight, oRight), otherId: other.id };
        }
      }
    }

    const snapX = bestDistX <= SNAP_THRESHOLD ? bestX : null;
    let snapY = bestDistY <= SNAP_THRESHOLD ? bestY : null;

    // Same-edge alignment: when snapped side-by-side (X), align top/bottom edges
    if (snapX && !snapY) {
      const other = state.panes.find(p => p.id === snapX.otherId);
      if (other) {
        const topDist = Math.abs(draggedY - other.y);
        const bottomDist = Math.abs(dBottom - (other.y + other.height));
        if (topDist < SNAP_THRESHOLD && topDist <= bottomDist) {
          snapY = { adjustY: other.y, edge: other.y, orientation: 'horizontal',
            left: Math.min(draggedX, other.x), right: Math.max(dRight, other.x + other.width), otherId: other.id };
        } else if (bottomDist < SNAP_THRESHOLD) {
          snapY = { adjustY: other.y + other.height - draggedPane.height, edge: other.y + other.height, orientation: 'horizontal',
            left: Math.min(draggedX, other.x), right: Math.max(dRight, other.x + other.width), otherId: other.id };
        }
      }
    }

    // Same-edge alignment: when snapped stacked (Y), align left/right edges
    if (snapY && !snapX) {
      const other = state.panes.find(p => p.id === snapY.otherId);
      if (other) {
        const leftDist = Math.abs(draggedX - other.x);
        const rightDist = Math.abs(dRight - (other.x + other.width));
        if (leftDist < SNAP_THRESHOLD && leftDist <= rightDist) {
          bestX = { adjustX: other.x, edge: other.x, orientation: 'vertical',
            top: Math.min(draggedY, other.y), bottom: Math.max(dBottom, other.y + other.height), otherId: other.id };
          return { x: bestX, y: snapY };
        } else if (rightDist < SNAP_THRESHOLD) {
          bestX = { adjustX: other.x + other.width - draggedPane.width, edge: other.x + other.width, orientation: 'vertical',
            top: Math.min(draggedY, other.y), bottom: Math.max(dBottom, other.y + other.height), otherId: other.id };
          return { x: bestX, y: snapY };
        }
      }
    }

    return (snapX || snapY) ? { x: snapX, y: snapY } : null;
  }

  // Find resize snap targets (right and bottom edges of resizing pane)
  function findResizeSnapTargets(paneData, newWidth, newHeight) {
    const rightEdge = paneData.x + newWidth;
    const bottomEdge = paneData.y + newHeight;

    let bestW = null, bestDistW = SNAP_THRESHOLD + 1;
    let bestH = null, bestDistH = SNAP_THRESHOLD + 1;

    for (const other of state.panes) {
      if (other.id === paneData.id) continue;
      const el = document.getElementById(`pane-${other.id}`);
      if (!el || el.style.display === 'none') continue;

      const oLeft = other.x;
      const oRight = other.x + other.width;
      const oTop = other.y;
      const oBottom = other.y + other.height;

      // Overlap checks with tolerance for adjacent/nearby panes
      const margin = SNAP_GAP + SNAP_THRESHOLD;
      const vOverlap = paneData.y < oBottom + margin && bottomEdge > oTop - margin;
      const hOverlap = paneData.x < oRight + margin && rightEdge > oLeft - margin;

      if (vOverlap) {
        // Right edge -> other's left edge (with gap)
        const distL = Math.abs(rightEdge + SNAP_GAP - oLeft);
        if (distL < bestDistW) {
          bestDistW = distL;
          bestW = { snapWidth: oLeft - paneData.x - SNAP_GAP, edge: oLeft - SNAP_GAP / 2, orientation: 'vertical',
            top: Math.min(paneData.y, oTop), bottom: Math.max(bottomEdge, oBottom) };
        }
        // Right edge -> other's right edge (align)
        const distR = Math.abs(rightEdge - oRight);
        if (distR < bestDistW) {
          bestDistW = distR;
          bestW = { snapWidth: oRight - paneData.x, edge: oRight, orientation: 'vertical',
            top: Math.min(paneData.y, oTop), bottom: Math.max(bottomEdge, oBottom) };
        }
      }

      if (hOverlap) {
        // Bottom edge -> other's top edge (with gap)
        const distT = Math.abs(bottomEdge + SNAP_GAP - oTop);
        if (distT < bestDistH) {
          bestDistH = distT;
          bestH = { snapHeight: oTop - paneData.y - SNAP_GAP, edge: oTop - SNAP_GAP / 2, orientation: 'horizontal',
            left: Math.min(paneData.x, oLeft), right: Math.max(rightEdge, oRight) };
        }
        // Bottom edge -> other's bottom edge (align)
        const distB = Math.abs(bottomEdge - oBottom);
        if (distB < bestDistH) {
          bestDistH = distB;
          bestH = { snapHeight: oBottom - paneData.y, edge: oBottom, orientation: 'horizontal',
            left: Math.min(paneData.x, oLeft), right: Math.max(rightEdge, oRight) };
        }
      }
    }

    const snapW = bestDistW <= SNAP_THRESHOLD ? bestW : null;
    const snapH = bestDistH <= SNAP_THRESHOLD ? bestH : null;
    return (snapW || snapH) ? { w: snapW, h: snapH } : null;
  }

  let snapGuideX = null;
  let snapGuideY = null;

  function updateSnapGuide(guide, snap) {
    if (!guide) {
      guide = document.createElement('div');
      guide.style.pointerEvents = 'none';
      document.getElementById('canvas').appendChild(guide);
    }
    guide.className = `snap-guide ${snap.orientation}`;
    if (snap.orientation === 'vertical') {
      guide.style.left = `${snap.edge}px`;
      guide.style.top = `${snap.top}px`;
      guide.style.height = `${snap.bottom - snap.top}px`;
      guide.style.width = '';
    } else {
      guide.style.left = `${snap.left}px`;
      guide.style.top = `${snap.edge}px`;
      guide.style.width = `${snap.right - snap.left}px`;
      guide.style.height = '';
    }
    return guide;
  }

  function showSnapGuides(snaps) {
    if (snaps.x) { snapGuideX = updateSnapGuide(snapGuideX, snaps.x); }
    else if (snapGuideX) { snapGuideX.remove(); snapGuideX = null; }
    if (snaps.y) { snapGuideY = updateSnapGuide(snapGuideY, snaps.y); }
    else if (snapGuideY) { snapGuideY.remove(); snapGuideY = null; }
  }

  function removeSnapGuides() {
    if (snapGuideX) { snapGuideX.remove(); snapGuideX = null; }
    if (snapGuideY) { snapGuideY.remove(); snapGuideY = null; }
  }

  // Start dragging immediately (for header)
  function startDrag(e, paneEl, paneData) {
    e.preventDefault();
    isDragging = true;
    activePane = paneEl;
    paneEl.classList.add('dragging');
    document.body.classList.add('no-select');
    showIframeOverlays();

    const point = e.touches ? e.touches[0] : e;
    const rect = paneEl.getBoundingClientRect();
    dragOffsetX = (point.clientX - rect.left) / state.zoom;
    dragOffsetY = (point.clientY - rect.top) / state.zoom;

    if (navigator.vibrate) {
      navigator.vibrate(30);
    }

    // Determine group drag: if this pane is in the selection, drag all selected
    const isGroupDrag = selectedPaneIds.size > 1 && selectedPaneIds.has(paneData.id);
    let groupPanes = null;

    if (isGroupDrag) {
      groupPanes = [];
      selectedPaneIds.forEach(id => {
        const p = state.panes.find(x => x.id === id);
        const el = document.getElementById(`pane-${id}`);
        if (p && el) {
          groupPanes.push({ paneData: p, paneEl: el, startX: p.x, startY: p.y });
          el.classList.add('dragging');
        }
      });
    }

    const startX = paneData.x;
    const startY = paneData.y;

    const moveHandler = (moveE) => {
      moveE.preventDefault();
      const movePoint = moveE.touches ? moveE.touches[0] : moveE;
      let newX = (movePoint.clientX - state.panX) / state.zoom - dragOffsetX;
      let newY = (movePoint.clientY - state.panY) / state.zoom - dragOffsetY;

      // Snap-to-edge (unless Shift held)
      if (!moveE.shiftKey) {
        const snaps = findSnapTargets(paneData, newX, newY, isGroupDrag ? selectedPaneIds : null);
        if (snaps) {
          if (snaps.x) newX = snaps.x.adjustX;
          if (snaps.y) newY = snaps.y.adjustY;
          showSnapGuides(snaps);
        } else {
          removeSnapGuides();
        }
      } else {
        removeSnapGuides();
      }

      paneEl.style.left = `${newX}px`;
      paneEl.style.top = `${newY}px`;
      paneData.x = newX;
      paneData.y = newY;
      syncTabGroupGeometry(paneData);

      // Move the rest of the group by the same delta
      if (isGroupDrag) {
        const dx = newX - startX;
        const dy = newY - startY;
        groupPanes.forEach(({ paneData: p, paneEl: el, startX: sx, startY: sy }) => {
          if (p.id === paneData.id) return;
          p.x = sx + dx;
          p.y = sy + dy;
          el.style.left = `${p.x}px`;
          el.style.top = `${p.y}px`;
        });
      }
    };

    const endHandler = () => {
      removeSnapGuides();
      isDragging = false;
      paneEl.classList.remove('dragging');
      document.body.classList.remove('no-select');
      activePane = null;
      hideIframeOverlays();

      // Save position to server (use correct endpoint based on pane type)

      if (isGroupDrag) {
        // Remove dragging class and save all group positions (cloud-only)
        groupPanes.forEach(({ paneData: p, paneEl: el }) => {
          el.classList.remove('dragging');
          cloudSaveLayout(p);
        });
      } else {
        cloudSaveLayout(paneData);
      }

      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('touchmove', moveHandler);
      document.removeEventListener('mouseup', endHandler);
      document.removeEventListener('touchend', endHandler);
    };

    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('touchmove', moveHandler, { passive: false });
    document.addEventListener('mouseup', endHandler);
    document.addEventListener('touchend', endHandler);
  }

  // Start resize with short hold
  function startResizeHold(e, paneEl, paneData) {
    e.preventDefault();
    const point = e.touches ? e.touches[0] : e;
    const resizeHandle = paneEl.querySelector('.pane-resize-handle');

    resizeHandle.classList.add('hold-active');

    holdTimer = setTimeout(() => {
      activateResize(paneEl, paneData, point);
    }, RESIZE_HOLD_DURATION);

    const endHandler = () => {
      clearTimeout(holdTimer);
      if (!isResizing) {
        resizeHandle.classList.remove('hold-active');
      }
      document.removeEventListener('mouseup', endHandler);
      document.removeEventListener('touchend', endHandler);
    };

    document.addEventListener('mouseup', endHandler);
    document.addEventListener('touchend', endHandler);
  }

  // Activate resize mode
  function activateResize(paneEl, paneData, startPoint) {
    isResizing = true;
    paneEl.classList.add('resizing');
    document.body.classList.add('no-select');
    showIframeOverlays();

    const startWidth = paneData.width;
    const startHeight = paneData.height;
    const startX = startPoint.clientX;
    const startY = startPoint.clientY;

    if (navigator.vibrate) {
      navigator.vibrate(30);
    }

    // During drag resize we must NOT call fitAddon.fit() continuously —
    // each fit() clears xterm's render state and triggers a tmux resize,
    // but before tmux can finish repainting, the next fit() clears it again.
    // This leaves stale content in parts of the terminal that never get
    // repainted. Instead, we only fit once when the drag ends (endHandler).
    const debouncedFit = () => {
      // No-op during drag — fit happens in endHandler only
    };

    const moveHandler = (moveE) => {
      moveE.preventDefault();
      const movePoint = moveE.touches ? moveE.touches[0] : moveE;

      const deltaX = (movePoint.clientX - startX) / state.zoom;
      const deltaY = (movePoint.clientY - startY) / state.zoom;

      let newWidth = Math.max(10, startWidth + deltaX);
      let newHeight = Math.max(10, startHeight + deltaY);

      // Snap resize edges (unless Shift held)
      if (!moveE.shiftKey) {
        const snaps = findResizeSnapTargets(paneData, newWidth, newHeight);
        if (snaps) {
          if (snaps.w) newWidth = snaps.w.snapWidth;
          if (snaps.h) newHeight = snaps.h.snapHeight;
          showSnapGuides({ x: snaps.w, y: snaps.h });
        } else {
          removeSnapGuides();
        }
      } else {
        removeSnapGuides();
      }

      paneEl.style.width = `${newWidth}px`;
      paneEl.style.height = `${newHeight}px`;
      paneData.width = newWidth;
      paneData.height = newHeight;
      syncTabGroupGeometry(paneData);

      // Debounced refit terminal
      debouncedFit();
    };

    const endHandler = () => {
      removeSnapGuides();
      isResizing = false;
      paneEl.classList.remove('resizing');
      paneEl.querySelector('.pane-resize-handle').classList.remove('hold-active');
      document.body.classList.remove('no-select');
      hideIframeOverlays();

      // Final fit after resize ends (only for terminals).
      // This is the ONLY fit that should happen during a resize operation —
      // intermediate fits during drag are disabled to prevent render corruption.
      if (paneData.type === 'terminal') {
        const termInfo = terminals.get(paneData.id);
        if (termInfo) {
          try {
            if (termInfo.safeFitAndSync) termInfo.safeFitAndSync();
            else termInfo.fitAddon.fit();
            // Send resize immediately (include pixel dimensions so agent persists them)
            sendWs('terminal:resize', {
              terminalId: paneData.id,
              cols: termInfo.xterm.cols,
              rows: termInfo.xterm.rows,
              pixelWidth: paneData.width,
              pixelHeight: paneData.height
            }, paneData.agentId);
          } catch (e) {
            // Ignore fit errors
          }
        }
      }

      // Save size to cloud (cloud-only, no agent write)
      cloudSaveLayout(paneData);

      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('touchmove', moveHandler);
      document.removeEventListener('mouseup', endHandler);
      document.removeEventListener('touchend', endHandler);
    };

    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('touchmove', moveHandler, { passive: false });
    document.addEventListener('mouseup', endHandler);
    document.addEventListener('touchend', endHandler);
  }

  // ============================================================================
  // SECTION 17: PANE FOCUS & CANVAS NAVIGATION                   [Lines ~8185-8298]
  // focusPane(), panToPane(), focusTerminalInput(),
  // updateCanvasTransform(), getQuickViewInfo()
  // ============================================================================

  // Bring pane to front
  function focusPane(paneData) {

    if (!paneData) {
      console.error('[App] focusPane called with undefined paneData');
      return;
    }
    const prevPane = lastFocusedPaneId ? state.panes.find(p => p.id === lastFocusedPaneId) : null;
    _telemetry.track('pane.focus', {
      pane_type: paneData.type || 'terminal',
      previous_pane_type: prevPane ? (prevPane.type || 'terminal') : null,
    });
    paneData.zIndex = state.nextZIndex++;
    const paneEl = document.getElementById(`pane-${paneData.id}`);
    if (paneEl) {
      paneEl.style.zIndex = paneData.zIndex;
      // Remove focused class from all other panes
      document.querySelectorAll('.pane.focused').forEach(p => {
        if (p.id !== `pane-${paneData.id}`) {
          p.classList.remove('focused');
        }
      });
      paneEl.classList.add('focused');
      lastFocusedPaneId = paneData.id;

      // Quick View: overlays stay on all panes (no interaction in this mode)
    }
  }

  // Pan canvas to center a pane and focus it
  function panToPane(paneId) {
    const paneData = state.panes.find(p => p.id === paneId);
    if (!paneData) return;

    const paneCenterX = paneData.x + paneData.width / 2;
    const paneCenterY = paneData.y + paneData.height / 2;
    state.panX = window.innerWidth / 2 - paneCenterX * state.zoom;
    state.panY = window.innerHeight / 2 - paneCenterY * state.zoom;
    updateCanvasTransform();
    saveViewState();
    focusPane(paneData);
    focusTerminalInput(paneId);
  }

  // Focus terminal input for keyboard (important for mobile)
  function focusTerminalInput(paneId) {
    // Don't steal focus from external inputs (HUD search, modals, etc.)
    if (isExternalInputFocused()) return;
    const termInfo = terminals.get(paneId);
    if (termInfo && termInfo.xterm) {
      termInfo.xterm.focus();
    }
  }

  // Update canvas transform
  function updateCanvasTransform() {
    canvas.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  }

  // Quick View: overlay showing pane type, device, path, claude state
  function getQuickViewInfo(paneData, paneEl) {
    const isClaude = paneEl.classList.contains('claude-working') ||
      paneEl.classList.contains('claude-idle') ||
      paneEl.classList.contains('claude-permission') ||
      paneEl.classList.contains('claude-question') ||
      paneEl.classList.contains('claude-input-needed');

    let type, device, path, claudeState;

    if (paneData.type === 'terminal') {
      type = isClaude ? 'Claude' : 'Terminal';
      device = paneData.device || 'local';
      path = paneData.workingDir || '~';
    } else if (paneData.type === 'file') {
      type = 'File';
      device = paneData.device || 'local';
      path = paneData.filePath || paneData.fileName || 'untitled';
    } else if (paneData.type === 'note') {
      type = 'Note';
      device = 'local';
      path = '';
    } else if (paneData.type === 'git-graph') {
      type = 'Git Graph';
      device = paneData.device || 'local';
      path = paneData.repoPath || '';
    } else if (paneData.type === 'iframe') {
      type = 'Iframe';
      device = paneData.url || '';
      path = '';
    } else if (paneData.type === 'beads') {
      type = 'Beads';
      const agent = agents.find(a => a.agentId === paneData.agentId);
      device = paneData.device || (agent && agent.hostname) || 'local';
      path = paneData.projectPath || '';
    } else if (paneData.type === 'folder') {
      type = 'Folder';
      device = paneData.device || 'local';
      path = paneData.folderPath || '~';
    }

    if (isClaude) {
      const stateMap = {
        'claude-working': CLAUDE_STATE_SVGS.working,
        'claude-idle': CLAUDE_STATE_SVGS.idle,
        'claude-permission': CLAUDE_STATE_SVGS.permission,
        'claude-question': CLAUDE_STATE_SVGS.question,
        'claude-input-needed': CLAUDE_STATE_SVGS.inputNeeded
      };
      for (const [cls, label] of Object.entries(stateMap)) {
        if (paneEl.classList.contains(cls)) {
          claudeState = label;
          break;
        }
      }
    }

    return { type, device, path, claudeState };
  }

  // ============================================================================
  // SECTION 18: QUICK VIEW & MENTION MODE                        [Lines ~8299-8700]
  // addQuickViewOverlay() (git, beads, claude metadata overlays),
  // removeQuickViewOverlay(), toggleQuickView(),
  // enterMentionMode(), exitMentionMode(), mention stage overlays
  // ============================================================================

  function addQuickViewOverlay(paneEl, paneData) {
    if (paneEl.querySelector('.quick-view-overlay')) return;

    const info = getQuickViewInfo(paneData, paneEl);
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

      const isSelected = selectedPaneIds.has(paneData.id);

      if (e.shiftKey && !isSelected) {
        // Shift+Click unselected pane: select it
        togglePaneSelection(paneData.id);
        updateBroadcastIndicator();
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
        const offsetX = (e.clientX - rect.left) / state.zoom;
        const offsetY = (e.clientY - rect.top) / state.zoom;
        const groupPanes = [];
        selectedPaneIds.forEach(id => {
          const p = state.panes.find(x => x.id === id);
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
            isDragging = true;
            document.body.classList.add('no-select');
            groupPanes.forEach(({ paneEl: el }) => el.classList.add('dragging'));
            showIframeOverlays();
          }

          // Move anchor pane
          const newX = (moveE.clientX - state.panX) / state.zoom - offsetX;
          const newY = (moveE.clientY - state.panY) / state.zoom - offsetY;
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
            isDragging = false;
            document.body.classList.remove('no-select');
            groupPanes.forEach(({ paneEl: el }) => el.classList.remove('dragging'));
            hideIframeOverlays();
            // Save all positions (cloud-only)
            groupPanes.forEach(({ paneData: p }) => {
              cloudSaveLayout(p);
            });
          } else {
            // Quick click — deselect
            togglePaneSelection(paneData.id);
            updateBroadcastIndicator();
          }
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        return;
      }

      // Click without Shift on unselected pane: exit overlay mode, focus
      if (quickViewActive) {
        toggleQuickView();
      } else if (deviceHoverActive) {
        hoveredDeviceName = null;
        clearDeviceHighlight();
      }
      focusPane(paneData);
      focusTerminalInput(paneData.id);
    });

    paneEl.appendChild(overlay);
  }

  function removeQuickViewOverlay(paneEl) {
    const overlay = paneEl.querySelector('.quick-view-overlay');
    if (overlay) overlay.remove();
  }

  function toggleQuickView() {
    if (mentionModeActive) exitMentionMode();
    quickViewActive = !quickViewActive;

    if (quickViewActive) {
      // Clear any broadcast selection from normal mode
      clearMultiSelect();
      // Overlay ALL panes — no interaction allowed in Quick View
      document.querySelectorAll('.pane').forEach(paneEl => {
        const paneId = paneEl.dataset.paneId;
        const paneData = state.panes.find(p => p.id === paneId);
        if (!paneData) return;
        addQuickViewOverlay(paneEl, paneData);
      });
      // Remove focused state from all panes
      document.querySelectorAll('.pane.focused').forEach(p => p.classList.remove('focused'));
    } else {
      document.querySelectorAll('.quick-view-overlay').forEach(o => o.remove());
      document.querySelectorAll('.pane.qv-hover').forEach(p => p.classList.remove('qv-hover'));
      clearMultiSelect();
    }
  }

  // === Mention Mode (two-stage) ===
  // Stage 1: pick what to mention (file, iframe, beads issue)
  // Stage 2: pick which Claude Code terminal to paste into
  function enterMentionMode(payload) {
    if (moveModeActive) exitMoveMode();
    if (mentionModeActive) clearMentionOverlays();
    if (quickViewActive) toggleQuickView();
    if (deviceHoverActive) { hoveredDeviceName = null; clearDeviceHighlight(); }
    mentionModeActive = true;

    if (payload) {
      // Direct to stage 2 (called from @ buttons)
      mentionStage = 2;
      mentionPayload = payload;
      addMentionStage2Overlays();
      const label = payload.type === 'beads'
        ? payload.text.replace('work on this beads issue: ', '').replace(', abide claude.md rules!!!', '')
        : payload.text;
      showMentionIndicator(`@ ${escapeHtml(label)}`);
    } else {
      // Stage 1: pick source
      mentionStage = 1;
      mentionPayload = null;
      addMentionStage1Overlays();
      showMentionIndicator('Select a file, URL, or issue');
    }
  }

  function addMentionStage1Overlays() {
    document.querySelectorAll('.pane').forEach(paneEl => {
      const paneId = paneEl.dataset.paneId;
      const paneData = state.panes.find(p => p.id === paneId);
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

  function addMentionStage2Overlays() {
    document.querySelectorAll('.pane').forEach(paneEl => {
      const paneId = paneEl.dataset.paneId;
      const paneData = state.panes.find(p => p.id === paneId);
      if (!paneData) return;
      if (paneEl.querySelector('.mention-overlay')) return;

      const info = getQuickViewInfo(paneData, paneEl);
      const isClaude = info.type === 'Claude';
      const sameDevice = paneData.agentId === mentionPayload.sourceAgentId
        || (!paneData.agentId && !mentionPayload.sourceAgentId);
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
            data: btoa(mentionPayload.text)
          }, paneData.agentId);
          // Auto-set beads tag when mentioning a beads issue to a terminal
          if (mentionPayload.type === 'beads' && mentionPayload.issueId) {
            paneData.beadsTag = { id: mentionPayload.issueId, title: mentionPayload.issueTitle || '', status: mentionPayload.issueStatus || 'open', blocked: !!mentionPayload.issueBlocked };
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
          focusPane(paneData);
          focusTerminalInput(paneData.id);
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

  function showMentionIndicator(html) {
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

  function clearMentionOverlays() {
    document.querySelectorAll('.mention-overlay').forEach(o => o.remove());
    document.querySelectorAll('.pane.mention-target-pane').forEach(p => p.classList.remove('mention-target-pane'));
    document.querySelectorAll('.pane.mention-beads-picking').forEach(p => p.classList.remove('mention-beads-picking'));
  }

  function exitMentionMode() {
    mentionModeActive = false;
    mentionStage = 0;
    mentionPayload = null;
    clearMentionOverlays();
    const indicator = document.getElementById('mention-indicator');
    if (indicator) indicator.style.display = 'none';
  }

  // === Placement Mode ===
  // Placement ghost sizes derived from PANE_DEFAULTS
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
    'folder': 'Folder'
  };

  // Enter placement mode with all picker data already resolved
  // createFn(placementPos) will be called on click
  // ============================================================================
  // SECTION 19: PLACEMENT MODE                                   [Lines ~8702-8953]
  // enterPlacementMode(), cancelPlacementMode(), handlePlacementMouseMove(),
  // handlePlacementKeyDown() (D=delete, R=rotate), placement click/right-click
  // ============================================================================

  function enterPlacementMode(type, createFn) {
    if (moveModeActive) exitMoveMode();
    cancelPlacementMode();

    const size = placementSizes[type];
    const ghost = document.createElement('div');
    ghost.className = 'placement-ghost';
    ghost.style.width = `${size.width * state.zoom}px`;
    ghost.style.height = `${size.height * state.zoom}px`;
    ghost.innerHTML = `<div class="placement-ghost-label">${placementLabels[type]}</div>`;
    document.body.appendChild(ghost);

    placementMode = { type, cursorEl: ghost, createFn };
    canvasContainer.classList.add('placement-active');

    document.addEventListener('mousemove', handlePlacementMouseMove);
    document.addEventListener('keydown', handlePlacementKeyDown);
    document.addEventListener('contextmenu', handlePlacementRightClick);
    canvasContainer.addEventListener('click', handlePlacementClick);
  }

  function cancelPlacementMode() {
    if (!placementMode) return;
    placementMode.cursorEl.remove();
    removeSnapGuides();
    canvasContainer.classList.remove('placement-active');
    document.removeEventListener('mousemove', handlePlacementMouseMove);
    document.removeEventListener('keydown', handlePlacementKeyDown);
    document.removeEventListener('contextmenu', handlePlacementRightClick);
    canvasContainer.removeEventListener('click', handlePlacementClick);
    placementMode = null;
  }

  function handlePlacementMouseMove(e) {
    if (!placementMode) return;
    const size = placementSizes[placementMode.type];

    // Convert cursor to canvas coords (cursor = center of ghost)
    let canvasX = (e.clientX - state.panX) / state.zoom - size.width / 2;
    let canvasY = (e.clientY - state.panY) / state.zoom - size.height / 2;

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
    placementMode.cursorEl.style.width = `${size.width * state.zoom}px`;
    placementMode.cursorEl.style.height = `${size.height * state.zoom}px`;
    placementMode.cursorEl.style.left = `${state.panX + canvasX * state.zoom}px`;
    placementMode.cursorEl.style.top = `${state.panY + canvasY * state.zoom}px`;
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
    const canvasX = placementMode.snappedX != null ? placementMode.snappedX + size.width / 2 : (e.clientX - state.panX) / state.zoom;
    const canvasY = placementMode.snappedY != null ? placementMode.snappedY + size.height / 2 : (e.clientY - state.panY) / state.zoom;

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

  async function showDevicePickerThenPlace() {
    showDevicePickerGeneric(
      (d) => enterPlacementMode('terminal', (pos) => createPane(d.name, pos, d.ip)),
      () => enterPlacementMode('terminal', (pos) => createPane(undefined, pos))
    );
  }

  async function openFileWithDevicePickerThenPlace() {
    showDevicePickerGeneric(
      (d) => showRecentsOrBrowse('file', d.ip,
        (filePath, fileName) => enterPlacementMode('file', (pos) => createFilePaneFromRemote(d.name, filePath, pos, d.ip)),
        () => showFileBrowser(d.name, '~', null, true, d.ip)
      ),
      (e) => alert('Failed to list devices: ' + e.message)
    );
  }

  async function showGitRepoPickerWithDeviceThenPlace() {
    showDevicePickerGeneric(
      (d) => showRecentsOrBrowse('git-graph', d.ip,
        (repoPath) => enterPlacementMode('git-graph', (pos) => createGitGraphPane(repoPath, d.name, pos, d.ip)),
        () => showGitRepoPicker(d.name, null, true, d.ip)
      ),
      () => showRecentsOrBrowse('git-graph', activeAgentId,
        (repoPath) => enterPlacementMode('git-graph', (pos) => createGitGraphPane(repoPath, undefined, pos)),
        () => showGitRepoPicker(undefined, null, true)
      )
    );
  }

  // ── Conversations Pane ──

  async function createConversationsPane(dirPath, placementPos, targetAgentId, device) {
    const resolvedAgentId = targetAgentId || activeAgentId;
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
        zIndex: state.nextZIndex++,
        dirPath: cpData.dirPath,
        device: device || cpData.device || null,
        agentId: resolvedAgentId,
        includeSubdirs: false,
      };

      state.panes.push(pane); _telemetry.trackPaneOpen(pane);
      renderConversationsPane(pane);
      cloudSaveLayout(pane);
      saveRecentContext('conversations', pane.dirPath, pane.dirPath.split('/').filter(Boolean).pop() || pane.dirPath, resolvedAgentId);
    } catch (e) {
      console.error('[App] Failed to create conversations pane:', e);
      alert('Failed to create conversations pane: ' + e.message);
    }
  }

  function renderConversationsPane(paneData) {
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

    if (!paneData.shortcutNumber) paneData.shortcutNumber = getNextShortcutNumber();
    const deviceTag = paneData.device ? deviceLabelHtml(paneData.device) : '';
    const shortDir = (paneData.dirPath || '').replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~');
    pane.innerHTML = `
      <div class="pane-header">
        <span class="pane-title convos-title">
          ${deviceTag}<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align: middle; margin-right: 4px;">${ICON_CONVERSATIONS}</svg>
          Claude Sessions
        </span>
        ${paneNameHtml(paneData)}
        <div class="pane-header-right">
          ${shortcutBadgeHtml(paneData)}
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

    canvas.appendChild(pane);

    // Initial data fetch
    fetchConversationsData(pane, paneData);
  }

  async function fetchConversationsData(pane, paneData) {
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
        titleEl.innerHTML = `${paneData.device ? deviceLabelHtml(paneData.device) : ''}<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align: middle; margin-right: 4px;">${ICON_CONVERSATIONS}</svg> Claude Sessions${countStr}`;
      }
    } catch (e) {
      console.error('[App] Failed to fetch conversations:', e);
      listEl.innerHTML = `<div class="convos-error">Failed to load: ${escapeHtml(e.message)}</div>`;
    }
  }

  async function showConversationDetail(pane, paneData, convo, isActive, claudeState) {
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
          zIndex: state.nextZIndex++,
          tmuxSession: terminal.tmuxSession,
          device: paneData.device || null,
          agentId: paneData.agentId,
        };
        state.panes.push(tPane); _telemetry.trackPaneOpen(tPane);
        renderPane(tPane);
        cloudSaveLayout(tPane);

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

  function showExtractFormatPicker(detailEl, paneData, convo) {
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

  async function downloadConversation(paneData, convo, format) {
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

  async function showConversationsDirPickerThenPlace() {
    showDevicePickerGeneric(
      (d) => showRecentsOrBrowse('conversations', d.ip,
        (dirPath) => enterPlacementMode('conversations', (pos) => createConversationsPane(dirPath, pos, d.ip, d.name)),
        () => showConvosFolderPickerThenPlace(d.ip, d.name)
      ),
      () => showRecentsOrBrowse('conversations', activeAgentId,
        (dirPath) => enterPlacementMode('conversations', (pos) => createConversationsPane(dirPath, pos)),
        () => showConvosFolderPickerThenPlace()
      )
    );
  }

  async function showConvosFolderPickerThenPlace(targetAgentId, device) {
    const deviceLabel = device ? deviceLabelHtml(device, 'font-size:11px; padding:2px 8px;') : '';
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

  async function showFolderPaneDevicePickerThenPlace() {
    showDevicePickerGeneric(
      (d) => showRecentsOrBrowse('folder', d.ip,
        (folderPath) => enterPlacementMode('folder', (pos) => createFolderPane(folderPath, pos, d.ip, d.name)),
        () => showFolderPickerThenPlace(d.ip, d.name)
      ),
      () => showRecentsOrBrowse('folder', activeAgentId,
        (folderPath) => enterPlacementMode('folder', (pos) => createFolderPane(folderPath, pos)),
        () => showFolderPickerThenPlace()
      )
    );
  }

  async function showFolderPickerThenPlace(targetAgentId, device) {
    const deviceLabel = device ? deviceLabelHtml(device, 'font-size:11px; padding:2px 8px;') : '';
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
  async function showBeadsRepoPickerWithDeviceThenPlace() {
    showDevicePickerGeneric(
      (d) => showRecentsOrBrowse('beads', d.ip,
        (projectPath) => enterPlacementMode('beads', (pos) => createBeadsPane(projectPath, pos, d.ip, d.name)),
        () => showBeadsRepoPickerThenPlace(d.ip, d.name)
      ),
      () => showRecentsOrBrowse('beads', activeAgentId,
        (projectPath) => enterPlacementMode('beads', (pos) => createBeadsPane(projectPath, pos)),
        () => showBeadsRepoPickerThenPlace()
      )
    );
  }

  async function showBeadsRepoPickerThenPlace(targetAgentId, device) {
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
  // SECTION 19b: PROJECTS & CHECKPOINTS
  // Project rectangles on canvas, checkpoint panes, projects sidebar
  // ============================================================================

  const PROJECT_COLORS = [
    { name: 'Blue',    value: '59, 130, 246' },
    { name: 'Green',   value: '34, 197, 94' },
    { name: 'Purple',  value: '168, 85, 247' },
    { name: 'Orange',  value: '249, 115, 22' },
    { name: 'Pink',    value: '236, 72, 153' },
    { name: 'Cyan',    value: '6, 182, 212' },
    { name: 'Yellow',  value: '234, 179, 8' },
    { name: 'Red',     value: '239, 68, 68' },
  ];

  function generateProjectId() {
    return 'proj-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // Get panes that fall within a project's bounding rectangle (excludes checkpoint panes)
  function getPanesInProject(project) {
    return state.panes.filter(p => {
      if (p.type === 'checkpoint') return false;
      const px = p.x + p.width / 2;
      const py = p.y + p.height / 2;
      return px >= project.x && px <= project.x + project.width &&
             py >= project.y && py <= project.y + project.height;
    });
  }

  // Count pane states for a project (detailed: claude agents, working, done, input-needed, idle)
  function getProjectPaneCounts(project) {
    const panes = getPanesInProject(project);
    let claude = 0, working = 0, done = 0, inputNeeded = 0, idle = 0, other = 0;
    for (const p of panes) {
      const el = document.getElementById(`pane-${p.id}`);
      if (!el) { other++; continue; }
      const isClaude = el.classList.contains('claude-working') ||
        el.classList.contains('claude-idle') ||
        el.classList.contains('claude-done') ||
        el.classList.contains('claude-permission') ||
        el.classList.contains('claude-question') ||
        el.classList.contains('claude-input-needed');
      if (isClaude) claude++;
      if (el.classList.contains('claude-working')) working++;
      else if (el.classList.contains('claude-done')) done++;
      else if (el.classList.contains('claude-permission') || el.classList.contains('claude-question') || el.classList.contains('claude-input-needed')) inputNeeded++;
      else if (el.classList.contains('claude-idle')) idle++;
      else other++;
    }
    return { total: panes.length, claude, working, done, inputNeeded, idle, other };
  }

  // Navigate to a project with zoom-to-fit
  function navigateToProject(project) {
    // Calculate zoom to fit the project rectangle in viewport with padding
    const padding = 60; // px padding around project
    const viewW = window.innerWidth - padding * 2;
    const viewH = window.innerHeight - padding * 2;
    const zoomX = viewW / project.width;
    const zoomY = viewH / project.height;
    const targetZoom = Math.min(zoomX, zoomY, 2); // cap at 2x

    state.zoom = targetZoom;
    const centerX = project.x + project.width / 2;
    const centerY = project.y + project.height / 2;
    state.panX = window.innerWidth / 2 - centerX * state.zoom;
    state.panY = window.innerHeight / 2 - centerY * state.zoom;

    if (teleportAnimation) {
      canvas.style.transition = 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1)';
      updateCanvasTransform();
      setTimeout(() => { canvas.style.transition = ''; }, 320);
    } else {
      updateCanvasTransform();
    }
    saveViewState();
  }

  // Navigate to a checkpoint pane (center viewport on it)
  function navigateToCheckpointPane(paneData) {
    const centerX = paneData.x + paneData.width / 2;
    const centerY = paneData.y + paneData.height / 2;
    state.panX = window.innerWidth / 2 - centerX * state.zoom;
    state.panY = window.innerHeight / 2 - centerY * state.zoom;

    if (teleportAnimation) {
      canvas.style.transition = 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1)';
      updateCanvasTransform();
      setTimeout(() => { canvas.style.transition = ''; }, 320);
    } else {
      updateCanvasTransform();
    }
    saveViewState();
  }

  // Render project rectangles on the canvas
  function renderProjectRectangles() {
    canvas.querySelectorAll('.project-rect').forEach(el => el.remove());

    for (const project of state.projects) {
      const rect = document.createElement('div');
      rect.className = 'project-rect';
      rect.dataset.projectId = project.id;
      rect.style.left = project.x + 'px';
      rect.style.top = project.y + 'px';
      rect.style.width = project.width + 'px';
      rect.style.height = project.height + 'px';
      rect.style.setProperty('--project-color', project.color);
      rect.style.background = `rgba(${project.color}, 0.06)`;
      rect.style.border = `2px solid rgba(${project.color}, 0.3)`;
      rect.style.borderRadius = '16px';
      rect.style.zIndex = '0';

      // Project label — clickable button for rename/shortcut
      const label = document.createElement('button');
      label.className = 'project-rect-label';
      label.style.color = `rgba(${project.color}, 0.8)`;
      const shortcutHint = ` [${project.shortcutNumber || '?'}]`;
      label.textContent = project.name + shortcutHint;
      rect.appendChild(label);

      // Resize handle
      const resizeHandle = document.createElement('div');
      resizeHandle.className = 'project-rect-resize';
      rect.appendChild(resizeHandle);

      // Setup interactions
      setupProjectDrag(rect, project, label);
      setupProjectResize(rect, project, resizeHandle);

      canvas.insertBefore(rect, canvas.firstChild);
    }
  }

  function setupProjectDrag(rectEl, project, labelEl) {
    let dragging = false;
    let startX, startY, origX, origY;
    let clickStartTime = 0;
    let moved = false;

    labelEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      dragging = true;
      moved = false;
      clickStartTime = Date.now();
      startX = e.clientX;
      startY = e.clientY;
      origX = project.x;
      origY = project.y;

      const moveHandler = (moveE) => {
        if (!dragging) return;
        const dx = (moveE.clientX - startX) / state.zoom;
        const dy = (moveE.clientY - startY) / state.zoom;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        project.x = origX + dx;
        project.y = origY + dy;
        rectEl.style.left = project.x + 'px';
        rectEl.style.top = project.y + 'px';
      };

      const upHandler = () => {
        dragging = false;
        document.removeEventListener('mousemove', moveHandler);
        document.removeEventListener('mouseup', upHandler);
        if (moved) {
          saveProjectsToCloud();
          renderProjectsSidebar();
        }
      };

      document.addEventListener('mousemove', moveHandler);
      document.addEventListener('mouseup', upHandler);
    });

    // Left-click (no drag) on label: show project popup (rename + shortcut assign)
    labelEl.addEventListener('click', (e) => {
      if (moved) return; // was a drag, not a click
      e.stopPropagation();
      showProjectEditPopup(project, labelEl);
    });

    // Right-click context menu
    rectEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showProjectContextMenu(e, project);
    });
  }

  // Popup for editing project name and shortcut number (shown on label click)
  function showProjectEditPopup(project, anchorEl) {
    // Remove any existing popup
    document.querySelectorAll('.project-edit-popup').forEach(el => el.remove());

    const rect = anchorEl.getBoundingClientRect();
    const popup = document.createElement('div');
    popup.className = 'project-edit-popup';
    popup.style.left = rect.left + 'px';
    popup.style.top = (rect.bottom + 6) + 'px';

    popup.innerHTML = `
      <div class="project-edit-row">
        <label class="project-edit-label">Name</label>
        <input type="text" class="project-edit-input" value="${escapeHtml(project.name)}" />
      </div>
      <div class="project-edit-row">
        <label class="project-edit-label">Shortcut</label>
        <div class="project-edit-shortcut">
          ${[1,2,3,4,5,6,7,8,9].map(n => {
            const taken = state.panes.find(p => p.shortcutNumber === n) || state.projects.find(p => p.shortcutNumber === n && p.id !== project.id);
            const isCurrent = project.shortcutNumber === n;
            return `<button class="project-shortcut-num ${isCurrent ? 'active' : ''} ${taken && !isCurrent ? 'taken' : ''}" data-num="${n}">${n}</button>`;
          }).join('')}
          <button class="project-shortcut-num ${!project.shortcutNumber ? 'active' : ''}" data-num="0">-</button>
        </div>
      </div>
      <div class="project-edit-row">
        <label class="project-edit-label">Color</label>
        <div class="project-edit-colors">
          ${PROJECT_COLORS.map(c => `<button class="project-color-btn ${project.color === c.value ? 'active' : ''}" data-color="${c.value}" style="background: rgba(${c.value}, 0.8);"></button>`).join('')}
        </div>
      </div>
      <div class="project-edit-actions">
        <button class="project-edit-delete">Delete Project</button>
      </div>
    `;

    document.body.appendChild(popup);

    const nameInput = popup.querySelector('.project-edit-input');
    nameInput.focus();
    nameInput.select();

    // Name change
    const saveName = () => {
      const newName = nameInput.value.trim();
      if (newName && newName !== project.name) {
        project.name = newName;
        saveProjectsToCloud();
        renderProjectRectangles();
        renderProjectsSidebar();
      }
    };
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveName(); closePopup(); }
      if (e.key === 'Escape') closePopup();
      e.stopPropagation(); // prevent Tab chords from firing
    });
    nameInput.addEventListener('blur', saveName);

    // Shortcut number buttons
    popup.querySelectorAll('.project-shortcut-num').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const num = parseInt(btn.dataset.num, 10);
        if (num === 0) {
          project.shortcutNumber = null;
        } else {
          reassignShortcutNumber(project, num);
        }
        saveProjectsToCloud();
        renderProjectRectangles();
        renderProjectsSidebar();
        closePopup();
      });
    });

    // Color buttons
    popup.querySelectorAll('.project-color-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        project.color = btn.dataset.color;
        saveProjectsToCloud();
        renderProjectRectangles();
        renderProjectsSidebar();
        closePopup();
      });
    });

    // Delete button
    popup.querySelector('.project-edit-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteProject(project.id);
      closePopup();
    });

    function closePopup() {
      popup.remove();
      document.removeEventListener('mousedown', outsideClick);
    }

    const outsideClick = (e) => {
      if (!popup.contains(e.target) && !anchorEl.contains(e.target)) {
        saveName();
        closePopup();
      }
    };
    setTimeout(() => document.addEventListener('mousedown', outsideClick), 0);
  }

  function showProjectContextMenu(e, project) {
    document.querySelectorAll('.project-context-menu').forEach(el => el.remove());

    const menu = document.createElement('div');
    menu.className = 'project-context-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    const goToBtn = document.createElement('button');
    goToBtn.textContent = 'Go to Project';
    goToBtn.addEventListener('click', () => { navigateToProject(project); menu.remove(); });

    const renameBtn = document.createElement('button');
    renameBtn.textContent = 'Edit Project';
    renameBtn.addEventListener('click', () => {
      menu.remove();
      const labelEl = document.querySelector(`.project-rect[data-project-id="${project.id}"] .project-rect-label`);
      if (labelEl) showProjectEditPopup(project, labelEl);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete Project';
    deleteBtn.addEventListener('click', () => { deleteProject(project.id); menu.remove(); });

    menu.appendChild(goToBtn);
    menu.appendChild(renameBtn);
    menu.appendChild(deleteBtn);
    document.body.appendChild(menu);

    const closeMenu = (ev) => {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', closeMenu); }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
  }

  function setupProjectResize(rectEl, project, handleEl) {
    let resizing = false;
    let startX, startY, origW, origH;

    handleEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      resizing = true;
      startX = e.clientX;
      startY = e.clientY;
      origW = project.width;
      origH = project.height;

      const moveHandler = (moveE) => {
        if (!resizing) return;
        const dx = (moveE.clientX - startX) / state.zoom;
        const dy = (moveE.clientY - startY) / state.zoom;
        project.width = Math.max(200, origW + dx);
        project.height = Math.max(150, origH + dy);
        rectEl.style.width = project.width + 'px';
        rectEl.style.height = project.height + 'px';
      };

      const upHandler = () => {
        resizing = false;
        document.removeEventListener('mousemove', moveHandler);
        document.removeEventListener('mouseup', upHandler);
        saveProjectsToCloud();
        renderProjectsSidebar();
      };

      document.addEventListener('mousemove', moveHandler);
      document.addEventListener('mouseup', upHandler);
    });
  }

  function deleteProject(projectId) {
    state.projects = state.projects.filter(p => p.id !== projectId);
    saveProjectsToCloud();
    renderProjectRectangles();
    renderProjectsSidebar();
  }

  // Render a checkpoint pane (circle with name + shortcut badge)
  function renderCheckpointPane(paneData) {
    const existingPane = document.getElementById(`pane-${paneData.id}`);
    if (existingPane) existingPane.remove();

    const pane = document.createElement('div');
    pane.className = 'pane checkpoint-pane';
    pane.id = `pane-${paneData.id}`;
    pane.style.left = `${paneData.x}px`;
    pane.style.top = `${paneData.y}px`;
    pane.style.width = `${paneData.width}px`;
    pane.style.height = `${paneData.height}px`;
    pane.style.zIndex = paneData.zIndex;
    pane.dataset.paneId = paneData.id;

    if (!paneData.shortcutNumber) paneData.shortcutNumber = getNextShortcutNumber();

    pane.innerHTML = `
      <div class="checkpoint-pane-circle">
        <svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 010-5 2.5 2.5 0 010 5z" fill="currentColor"/></svg>
      </div>
      <div class="checkpoint-pane-name">${escapeHtml(paneData.paneName || paneData.checkpointName || 'Checkpoint')}</div>
      <div class="checkpoint-pane-badge">${paneData.shortcutNumber ? `Tab+${paneData.shortcutNumber}` : 'Tab+?'}</div>
      <button class="checkpoint-pane-close" aria-label="Close"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    `;

    canvas.appendChild(pane);

    // Draggable via circle
    const circleEl = pane.querySelector('.checkpoint-pane-circle');
    let ckDragging = false, ckMoved = false, ckStartX, ckStartY, ckOrigX, ckOrigY;
    circleEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      ckDragging = true;
      ckMoved = false;
      ckStartX = e.clientX;
      ckStartY = e.clientY;
      ckOrigX = paneData.x;
      ckOrigY = paneData.y;
      // Bring to front
      paneData.zIndex = state.nextZIndex++;
      pane.style.zIndex = paneData.zIndex;

      const moveH = (me) => {
        if (!ckDragging) return;
        const dx = (me.clientX - ckStartX) / state.zoom;
        const dy = (me.clientY - ckStartY) / state.zoom;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) ckMoved = true;
        paneData.x = ckOrigX + dx;
        paneData.y = ckOrigY + dy;
        pane.style.left = paneData.x + 'px';
        pane.style.top = paneData.y + 'px';
      };
      const upH = () => {
        ckDragging = false;
        document.removeEventListener('mousemove', moveH);
        document.removeEventListener('mouseup', upH);
        if (ckMoved) cloudSaveLayout(paneData);
      };
      document.addEventListener('mousemove', moveH);
      document.addEventListener('mouseup', upH);
    });

    // Click circle (no drag) to teleport
    circleEl.addEventListener('click', (e) => {
      if (ckMoved) return;
      e.stopPropagation();
      navigateToCheckpointPane(paneData);
    });

    // Close button
    pane.querySelector('.checkpoint-pane-close').addEventListener('click', (e) => {
      e.stopPropagation();
      deletePane(paneData.id);
    });

    // Click on name to rename
    const nameEl = pane.querySelector('.checkpoint-pane-name');
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.value = paneData.paneName || paneData.checkpointName || 'Checkpoint';
      input.className = 'checkpoint-rename-input';
      nameEl.style.display = 'none';
      circleEl.insertAdjacentElement('afterend', input);
      input.focus();
      input.select();

      const finish = () => {
        const newName = input.value.trim() || 'Checkpoint';
        paneData.paneName = newName;
        paneData.checkpointName = newName;
        nameEl.textContent = newName;
        nameEl.style.display = '';
        input.remove();
        cloudSaveLayout(paneData);
        renderProjectsSidebar();
      };

      input.addEventListener('blur', finish);
      input.addEventListener('keydown', (ke) => {
        ke.stopPropagation();
        if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
        if (ke.key === 'Escape') { input.value = paneData.paneName || 'Checkpoint'; input.blur(); }
      });
    });

    // Click on badge to reassign shortcut
    const badgeEl = pane.querySelector('.checkpoint-pane-badge');
    if (badgeEl) {
      badgeEl.addEventListener('click', (e) => {
        e.stopPropagation();
        showShortcutAssignPopup(paneData);
      });
    }
  }

  // Create a new project via placement mode (draw rectangle)
  function startProjectCreation() {
    const colorIdx = state.projects.length % PROJECT_COLORS.length;
    const color = PROJECT_COLORS[colorIdx].value;

    const overlay = document.createElement('div');
    overlay.className = 'project-creation-overlay';
    overlay.innerHTML = '<div class="project-creation-hint">Click and drag to draw a project area. Press Escape to cancel.</div>';
    document.body.appendChild(overlay);

    let drawing = false;
    let startCanvasX, startCanvasY;
    let previewRect = null;

    const mousedownHandler = (e) => {
      if (e.button !== 0) return;
      drawing = true;
      startCanvasX = (e.clientX - state.panX) / state.zoom;
      startCanvasY = (e.clientY - state.panY) / state.zoom;

      previewRect = document.createElement('div');
      previewRect.className = 'project-creation-preview';
      previewRect.style.background = `rgba(${color}, 0.1)`;
      previewRect.style.border = `2px dashed rgba(${color}, 0.5)`;
      previewRect.style.borderRadius = '16px';
      previewRect.style.left = startCanvasX + 'px';
      previewRect.style.top = startCanvasY + 'px';
      canvas.appendChild(previewRect);
    };

    const mousemoveHandler = (e) => {
      if (!drawing || !previewRect) return;
      const curX = (e.clientX - state.panX) / state.zoom;
      const curY = (e.clientY - state.panY) / state.zoom;
      const x = Math.min(startCanvasX, curX);
      const y = Math.min(startCanvasY, curY);
      const w = Math.abs(curX - startCanvasX);
      const h = Math.abs(curY - startCanvasY);
      previewRect.style.left = x + 'px';
      previewRect.style.top = y + 'px';
      previewRect.style.width = w + 'px';
      previewRect.style.height = h + 'px';
    };

    const mouseupHandler = (e) => {
      if (!drawing) return;
      drawing = false;

      const endX = (e.clientX - state.panX) / state.zoom;
      const endY = (e.clientY - state.panY) / state.zoom;
      const x = Math.min(startCanvasX, endX);
      const y = Math.min(startCanvasY, endY);
      const w = Math.abs(endX - startCanvasX);
      const h = Math.abs(endY - startCanvasY);

      cleanup();

      if (w < 100 || h < 80) return; // Too small, cancel

      const project = {
        id: generateProjectId(),
        name: 'Project ' + (state.projects.length + 1),
        color: color,
        x, y,
        width: w,
        height: h,
        shortcutNumber: getNextShortcutNumber(),
      };
      state.projects.push(project);
      saveProjectsToCloud();
      renderProjectRectangles();
      renderProjectsSidebar();
    };

    const keyHandler = (e) => {
      if (e.key === 'Escape') { drawing = false; cleanup(); }
    };

    function cleanup() {
      overlay.remove();
      if (previewRect) previewRect.remove();
      document.removeEventListener('mousedown', mousedownHandler);
      document.removeEventListener('mousemove', mousemoveHandler);
      document.removeEventListener('mouseup', mouseupHandler);
      document.removeEventListener('keydown', keyHandler, true);
    }

    document.addEventListener('mousedown', mousedownHandler);
    document.addEventListener('mousemove', mousemoveHandler);
    document.addEventListener('mouseup', mouseupHandler);
    document.addEventListener('keydown', keyHandler, true);
  }

  // Create standalone checkpoint pane at viewport center
  function createCheckpointPane() {
    const centerX = (window.innerWidth / 2 - state.panX) / state.zoom;
    const centerY = (window.innerHeight / 2 - state.panY) / state.zoom;
    const checkpointCount = state.panes.filter(p => p.type === 'checkpoint').length;
    const paneData = {
      id: 'ckpt-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: 'checkpoint',
      x: centerX - 30,
      y: centerY - 30,
      width: 60,
      height: 60,
      zIndex: state.nextZIndex++,
      shortcutNumber: getNextShortcutNumber(),
      checkpointName: 'Checkpoint ' + (checkpointCount + 1),
      paneName: 'Checkpoint ' + (checkpointCount + 1),
    };
    state.panes.push(paneData);
    renderCheckpointPane(paneData);
    cloudSaveLayout(paneData);
    renderProjectsSidebar();
  }

  // -- Projects Sidebar (center-top, expands downward) --
  function createProjectsSidebar() {
    const sidebar = document.createElement('div');
    sidebar.id = 'projects-sidebar';
    sidebar.className = 'tc-scrollbar';
    sidebar.innerHTML = `
      <div class="projects-sidebar-header">
        <span class="projects-sidebar-title">Projects</span>
        <div class="projects-sidebar-actions">
          <button class="projects-sidebar-btn" id="add-project-btn" title="New Project (draw rectangle)">+P</button>
          <button class="projects-sidebar-btn" id="add-checkpoint-btn" title="New Checkpoint pane">+C</button>
        </div>
      </div>
      <div class="projects-sidebar-content"></div>
    `;
    document.body.appendChild(sidebar);

    sidebar.querySelector('#add-project-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      startProjectCreation();
    });

    sidebar.querySelector('#add-checkpoint-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      createCheckpointPane();
    });

    applyProjectsSidebarPosition();
    return sidebar;
  }

  function applyProjectsSidebarPosition() {
    const sidebar = document.getElementById('projects-sidebar');
    if (!sidebar) return;
    // Reset positioning
    sidebar.style.left = '';
    sidebar.style.right = '';
    sidebar.style.transform = '';

    if (projectsSidebarPosition === 'left') {
      sidebar.style.left = '16px';
      sidebar.style.right = 'auto';
    } else {
      // right (default)
      sidebar.style.right = '16px';
      sidebar.style.left = 'auto';
    }
  }

  function toggleProjectsSidebar() {
    projectsSidebarVisible = !projectsSidebarVisible;
    let sidebar = document.getElementById('projects-sidebar');
    if (!sidebar) {
      sidebar = createProjectsSidebar();
    }
    sidebar.classList.toggle('visible', projectsSidebarVisible);
    if (projectsSidebarVisible) {
      renderProjectsSidebar();
    }
  }

  function renderProjectsSidebar() {
    const content = document.querySelector('#projects-sidebar .projects-sidebar-content');
    if (!content) return;

    let html = '';

    // Projects section
    if (state.projects.length > 0) {
      html += '<div class="ps-section-label">Projects</div>';
      for (let i = 0; i < state.projects.length; i++) {
        const project = state.projects[i];
        const counts = getProjectPaneCounts(project);
        const numberBadge = `<span class="ps-number-badge">${project.shortcutNumber ? `Tab+${project.shortcutNumber}` : 'Tab+?'}</span>`;

        // Build detailed stats line
        const stats = [];
        stats.push(`<span class="ps-stat">${counts.total} panes</span>`);
        if (counts.claude > 0) stats.push(`<span class="ps-stat ps-claude">${counts.claude} claude</span>`);
        if (counts.working > 0) stats.push(`<span class="ps-stat ps-working">${counts.working} working</span>`);
        if (counts.done > 0) stats.push(`<span class="ps-stat ps-done">${counts.done} done</span>`);
        if (counts.inputNeeded > 0) stats.push(`<span class="ps-stat ps-input">${counts.inputNeeded} waiting</span>`);
        if (counts.idle > 0) stats.push(`<span class="ps-stat ps-idle">${counts.idle} idle</span>`);

        html += `<div class="ps-item ps-project" data-project-id="${project.id}">
          <div class="ps-color-dot" style="background: rgba(${project.color}, 0.8);"></div>
          <div class="ps-item-info">
            <div class="ps-item-name">${escapeHtml(project.name)}</div>
            <div class="ps-item-stats">${stats.join('')}</div>
          </div>
          ${numberBadge}
        </div>`;
      }
    }

    // Standalone checkpoint panes section
    const checkpointPanes = state.panes.filter(p => p.type === 'checkpoint');
    if (checkpointPanes.length > 0) {
      html += '<div class="ps-section-label">Checkpoints</div>';
      for (const ckpt of checkpointPanes) {
        const ckptBadge = `<span class="ps-number-badge">${ckpt.shortcutNumber ? `Tab+${ckpt.shortcutNumber}` : 'Tab+?'}</span>`;
        html += `<div class="ps-item ps-checkpoint" data-pane-id="${ckpt.id}">
          <div class="ps-checkpoint-icon">
            <svg viewBox="0 0 24 24" width="12" height="12"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 010-5 2.5 2.5 0 010 5z" fill="currentColor"/></svg>
          </div>
          <div class="ps-item-info">
            <div class="ps-item-name">${escapeHtml(ckpt.paneName || ckpt.checkpointName || 'Checkpoint')}</div>
          </div>
          ${ckptBadge}
          <button class="ps-delete-btn" data-delete-pane-id="${ckpt.id}" title="Delete checkpoint"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>`;
      }
    }

    if (state.projects.length === 0 && checkpointPanes.length === 0) {
      html = '<div class="ps-empty">No projects yet. Click +P to draw a project area on the canvas, or use the add menu.</div>';
    }

    content.innerHTML = html;

    // Wire up click handlers
    content.querySelectorAll('.ps-project').forEach(el => {
      el.addEventListener('click', () => {
        const projId = el.dataset.projectId;
        const project = state.projects.find(p => p.id === projId);
        if (project) navigateToProject(project);
      });
    });

    content.querySelectorAll('.ps-checkpoint').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.ps-delete-btn')) return; // handled below
        const paneId = el.dataset.paneId;
        const paneData = state.panes.find(p => p.id === paneId);
        if (paneData) navigateToCheckpointPane(paneData);
      });
    });

    // Delete buttons for checkpoints in sidebar
    content.querySelectorAll('.ps-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const paneId = btn.dataset.deletePaneId;
        if (paneId) {
          deletePane(paneId);
          renderProjectsSidebar();
        }
      });
    });
  }

  // Persistence: save/load projects via cloud API
  let projectsSaveTimer = null;
  function saveProjectsToCloud() {
    if (projectsSaveTimer) clearTimeout(projectsSaveTimer);
    projectsSaveTimer = setTimeout(() => {
      cloudFetch('PUT', '/api/preferences', getAllPrefs({
        projects: state.projects,
      })).catch(e => console.error('[Projects] Save failed:', e.message));
    }, 500);
  }

  function loadProjectsFromPrefs(prefs) {
    if (prefs.projects && Array.isArray(prefs.projects)) {
      state.projects = prefs.projects;
    }
  }

  // Periodically refresh sidebar pane counts (every 5s when visible)
  let projectsSidebarRefreshTimer = null;
  function startProjectsSidebarRefresh() {
    if (projectsSidebarRefreshTimer) clearInterval(projectsSidebarRefreshTimer);
    projectsSidebarRefreshTimer = setInterval(() => {
      if (projectsSidebarVisible) renderProjectsSidebar();
    }, 5000);
  }

  // ============================================================================
  // SECTION 20: UI MENUS & TOOLBAR                               [Lines ~8954-9405]
  // setupAddPaneMenu(), setupTutorialMenu(), setupToolbarButtons(),
  // setupCustomTooltips(), setupCanvasInteraction(), calcMoveModeZoom()
  // ============================================================================

  function setupAddPaneMenu() {
    const addBtn = document.getElementById('add-pane-btn');
    const addMenu = document.getElementById('add-pane-menu');

    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Cross-close: hide tutorial menu
      const tutMenu = document.getElementById('tutorial-menu');
      if (tutMenu) tutMenu.classList.add('hidden');
      addMenu.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
      if (!addMenu.contains(e.target) && e.target !== addBtn) {
        addMenu.classList.add('hidden');
      }
    });

    function triggerMenuItem(type) {
      addMenu.classList.add('hidden');
      if (type === 'terminal') {
        showDevicePickerThenPlace();
      } else if (type === 'file') {
        openFileWithDevicePickerThenPlace();
      } else if (type === 'note') {
        enterPlacementMode('note', (pos) => createNotePane(pos));
      } else if (type === 'git-graph') {
        showGitRepoPickerWithDeviceThenPlace();
      } else if (type === 'iframe') {
        showRecentsOrBrowse('iframe', activeAgentId,
          (url) => enterPlacementMode('iframe', (pos) => createIframePaneWithUrl(url, pos)),
          () => enterPlacementMode('iframe', (pos) => createIframePane(pos))
        );
      } else if (type === 'beads') {
        showBeadsRepoPickerWithDeviceThenPlace();
      } else if (type === 'folder') {
        showFolderPaneDevicePickerThenPlace();
      } else if (type === 'conversations') {
        showConversationsDirPickerThenPlace();
      } else if (type === 'project') {
        startProjectCreation();
      } else if (type === 'checkpoint') {
        createCheckpointPane();
      }
    }

    addMenu.querySelectorAll('.menu-item').forEach(item => {
      item.addEventListener('click', async () => {
        triggerMenuItem(item.dataset.type);
      });
    });

    // Keyboard navigation: letter shortcuts when add menu is visible
    document.addEventListener('keydown', (e) => {
      if (addMenu.classList.contains('hidden')) return;
      const key = e.key.toLowerCase();
      if (key === 'escape') {
        e.preventDefault();
        addMenu.classList.add('hidden');
        return;
      }
      const match = addMenu.querySelector(`.menu-item[data-shortcut="${key}"]`);
      if (match) {
        e.preventDefault();
        e.stopPropagation();
        triggerMenuItem(match.dataset.type);
      }
    }, true);
  }

  function setupTutorialMenu() {
    const tutorialBtn = document.getElementById('tutorial-btn');
    const tutorialMenu = document.getElementById('tutorial-menu');
    if (!tutorialBtn || !tutorialMenu) return;

    function updateCompletionIndicators() {
      tutorialMenu.querySelectorAll('.tutorial-menu-item:not(.disabled)').forEach(item => {
        const key = item.dataset.tutorial;
        if (tutorialsCompleted[key]) {
          item.classList.add('completed');
        } else {
          item.classList.remove('completed');
        }
      });
    }

    tutorialBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Cross-close: hide add-pane menu
      const addMenu = document.getElementById('add-pane-menu');
      if (addMenu) addMenu.classList.add('hidden');

      updateCompletionIndicators();
      tutorialMenu.classList.toggle('hidden');
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!tutorialMenu.contains(e.target) && e.target !== tutorialBtn) {
        tutorialMenu.classList.add('hidden');
      }
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !tutorialMenu.classList.contains('hidden')) {
        tutorialMenu.classList.add('hidden');
      }
    });

    // Click handler for menu items
    tutorialMenu.querySelectorAll('.tutorial-menu-item:not(.disabled)').forEach(item => {
      item.addEventListener('click', () => {
        tutorialMenu.classList.add('hidden');
        const key = item.dataset.tutorial;
        if (key === 'getting-started') {
          window.location.href = '/tutorial';
        } else if (key === 'panes') {
          window.location.href = '/tutorial?guide=panes';
        }
      });
    });
  }

  // Auto-arrange panes in a single column for mobile viewports
  function autoArrangePanes() {
    const margin = 16;
    const paneWidth = (window.innerWidth / state.zoom) - margin * 2;
    const paneHeight = 300;
    const gap = 12;
    let y = margin;

    // Sort same as nav drawer: shortcut number, then position
    const sorted = [...state.panes].sort((a, b) => {
      const aNum = a.shortcutNumber || 99;
      const bNum = b.shortcutNumber || 99;
      if (aNum !== bNum) return aNum - bNum;
      if (a.y !== b.y) return a.y - b.y;
      return a.x - b.x;
    });

    sorted.forEach(p => {
      p.x = margin;
      p.y = y;
      p.width = paneWidth;
      p.height = paneHeight;
      y += paneHeight + gap;

      const el = document.getElementById(`pane-${p.id}`);
      if (el) {
        el.style.left = p.x + 'px';
        el.style.top = p.y + 'px';
        el.style.width = p.width + 'px';
        el.style.height = p.height + 'px';
      }

      // Refit terminals
      const termInfo = terminals.get(p.id);
      if (termInfo) {
        try { termInfo.fitAddon.fit(); } catch (_) {}
      }

      // Refit Monaco editors
      const editorInfo = fileEditors.get(p.id);
      if (editorInfo && editorInfo.editor) editorInfo.editor.layout();
      const noteInfo = noteEditors.get(p.id);
      if (noteInfo && noteInfo.monacoEditor) noteInfo.monacoEditor.layout();

      cloudSaveLayout(p);
    });

    // Reset zoom/pan to show top of column
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    updateCanvasTransform();
    saveViewState();
    renderMinimap();
  }

  // Mobile pane navigation drawer (bottom sheet)
  function setupMobileNavDrawer() {
    // Only create on mobile-width screens
    if (window.innerWidth > 768) return;

    const btn = document.createElement('button');
    btn.id = 'mobile-nav-btn';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
    document.body.appendChild(btn);

    const PANE_ICONS = {
      terminal: '>_',
      file: '\u{1F4C4}',
      note: '\u{1F4DD}',
      'git-graph': '\u{1F333}',
      iframe: '\u{1F310}',
      beads: '\u{1F4CE}',
      folder: '\u{1F4C1}',
    };

    function getPaneLabel(p) {
      if (p.paneName) return p.paneName;
      if (p.type === 'file') return p.fileName || p.filePath || 'File';
      if (p.type === 'note') return 'Note';
      if (p.type === 'git-graph') return p.repoName || 'Git Graph';
      if (p.type === 'iframe') return p.url ? new URL(p.url).hostname : 'Browser';
      if (p.type === 'beads') return 'Beads';
      if (p.type === 'folder') return (p.folderPath || '').split('/').pop() || 'Folder';
      return 'Terminal';
    }

    function openDrawer() {
      // Backdrop
      const backdrop = document.createElement('div');
      backdrop.className = 'mobile-nav-backdrop';
      document.body.appendChild(backdrop);

      // Sheet
      const sheet = document.createElement('div');
      sheet.className = 'mobile-nav-sheet';
      sheet.innerHTML = '<div class="mobile-nav-handle"></div><div style="display:flex;align-items:center;justify-content:space-between;padding:0 16px 8px;"><div class="mobile-nav-title" style="padding:0;">Panes</div><button class="mobile-nav-arrange-btn" style="background:rgba(218,119,86,0.15);border:1px solid rgba(218,119,86,0.3);color:rgba(218,119,86,0.9);font-size:11px;padding:4px 10px;border-radius:6px;cursor:pointer;">Arrange</button></div><div class="mobile-nav-list"></div>';
      document.body.appendChild(sheet);

      const list = sheet.querySelector('.mobile-nav-list');
      const arrangeBtn = sheet.querySelector('.mobile-nav-arrange-btn');
      if (arrangeBtn) {
        arrangeBtn.addEventListener('click', () => {
          closeDrawer();
          autoArrangePanes();
        });
      }

      // Sort: shortcut number first (1-9), then by position (left-to-right, top-to-bottom)
      const sorted = [...state.panes].sort((a, b) => {
        const aNum = a.shortcutNumber || 99;
        const bNum = b.shortcutNumber || 99;
        if (aNum !== bNum) return aNum - bNum;
        if (a.y !== b.y) return a.y - b.y;
        return a.x - b.x;
      });

      if (sorted.length === 0) {
        list.innerHTML = '<div class="mobile-nav-empty">No panes yet</div>';
      } else {
        sorted.forEach(p => {
          const item = document.createElement('div');
          item.className = 'mobile-nav-item';

          const icon = document.createElement('div');
          icon.className = 'mobile-nav-icon';
          icon.textContent = PANE_ICONS[p.type] || '>_';

          const label = document.createElement('div');
          label.className = 'mobile-nav-label';
          label.textContent = getPaneLabel(p);

          item.appendChild(icon);
          item.appendChild(label);

          if (p.device) {
            const device = document.createElement('div');
            device.className = 'mobile-nav-device';
            device.textContent = p.device;
            item.appendChild(device);
          }

          if (p.shortcutNumber) {
            const sc = document.createElement('div');
            sc.className = 'mobile-nav-shortcut';
            sc.textContent = p.shortcutNumber;
            item.appendChild(sc);
          }

          item.addEventListener('click', () => {
            closeDrawer();
            jumpToPane(p);
            setTimeout(() => expandPane(p.id), 150);
          });

          list.appendChild(item);
        });
      }

      // Animate in
      requestAnimationFrame(() => {
        backdrop.classList.add('visible');
        sheet.classList.add('open');
      });

      // Swipe-down to close
      let touchStartY = 0;
      sheet.addEventListener('touchstart', (e) => {
        touchStartY = e.touches[0].clientY;
      }, { passive: true });
      sheet.addEventListener('touchmove', (e) => {
        const dy = e.touches[0].clientY - touchStartY;
        if (dy > 60) closeDrawer();
      }, { passive: true });

      function closeDrawer() {
        sheet.classList.remove('open');
        backdrop.classList.remove('visible');
        setTimeout(() => {
          sheet.remove();
          backdrop.remove();
        }, 250);
      }

      backdrop.addEventListener('click', closeDrawer);
    }

    btn.addEventListener('click', openDrawer);
  }

  function setupToolbarButtons() {
    document.getElementById('settings-btn').addEventListener('click', () => showSettingsModal());

    setupTutorialMenu();

    document.getElementById('zoom-in').addEventListener('click', () => {
      setZoom(state.zoom * 1.2, window.innerWidth / 2, window.innerHeight / 2);
    });

    document.getElementById('zoom-out').addEventListener('click', () => {
      setZoom(state.zoom / 1.2, window.innerWidth / 2, window.innerHeight / 2);
    });

  }

  function setupCustomTooltips() {
    const tip = document.createElement('div');
    tip.id = 'custom-tooltip';
    document.body.appendChild(tip);

    let showTimer = null;
    let currentTarget = null;

    function positionTooltip(target) {
      const rect = target.getBoundingClientRect();
      tip.textContent = target.getAttribute('data-tooltip');
      // Temporarily show off-screen to measure
      tip.style.left = '-9999px';
      tip.style.top = '-9999px';
      tip.classList.add('visible');
      const tipRect = tip.getBoundingClientRect();
      const gap = 8;
      let top = rect.top - tipRect.height - gap;
      let left = rect.left + (rect.width - tipRect.width) / 2;
      // Flip below if too close to top
      if (top < 4) top = rect.bottom + gap;
      // Clamp horizontal
      if (left < 4) left = 4;
      if (left + tipRect.width > window.innerWidth - 4) left = window.innerWidth - tipRect.width - 4;
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }

    function showTooltip(target) {
      currentTarget = target;
      positionTooltip(target);
    }

    function hideTooltip() {
      if (showTimer) { clearTimeout(showTimer); showTimer = null; }
      tip.classList.remove('visible');
      currentTarget = null;
    }

    document.addEventListener('mouseover', (e) => {
      const target = e.target.closest('[data-tooltip]');
      if (!target || target === currentTarget) return;
      hideTooltip();
      showTimer = setTimeout(() => showTooltip(target), 300);
    });

    document.addEventListener('mouseout', (e) => {
      const target = e.target.closest('[data-tooltip]');
      if (!target) return;
      // Only hide if we're leaving the tooltip target (not entering a child)
      if (!target.contains(e.relatedTarget)) hideTooltip();
    });

    // Hide on scroll or click
    document.addEventListener('scroll', hideTooltip, true);
    document.addEventListener('mousedown', hideTooltip);
  }

  function setupCanvasInteraction() {
    canvasContainer.addEventListener('mousedown', (e) => {
      if (mentionModeActive && !e.target.closest('.mention-overlay') && !e.target.closest('.pane')) {
        exitMentionMode();
      }
    });

    canvasContainer.addEventListener('mousedown', handleCanvasPanStart);
    canvasContainer.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvasContainer.addEventListener('wheel', handleWheel, { passive: false });
    // Capture-phase: intercept Ctrl+Scroll and Tab+Scroll before any pane handler can stopPropagation
    canvasContainer.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        setZoom(state.zoom * delta, e.clientX, e.clientY);
        return;
      }
      if (tabHeld) {
        e.preventDefault();
        e.stopPropagation();
        state.panX -= e.deltaX || 0;
        state.panY -= e.deltaY;
        updateCanvasTransform();
        saveViewState();
      }
    }, { passive: false, capture: true });
    canvasContainer.addEventListener('contextmenu', (e) => e.preventDefault());

    // Middle mouse button: force canvas pan even over panes (capture phase)
    canvasContainer.addEventListener('mousedown', handleMiddleMousePan, true);

    // Right mouse button: force canvas pan even over panes (capture phase)
    canvasContainer.addEventListener('mousedown', handleRightMousePan, true);

    // Disable middle mouse button paste entirely (Linux X11 primary selection)
    document.addEventListener('auxclick', (e) => {
      if (e.button === 1) e.preventDefault();
    }, true);
  }

  function setupPasteHandlers() {
    let lastMouseX = 0, lastMouseY = 0;
    document.addEventListener('mousemove', (e) => {
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    });

    // Track Ctrl+V vs Ctrl+Shift+V when unfocused, so the paste handler knows
    // whether to create a note or route to the last focused terminal.
    let unfocusedPasteMode = null; // 'note' | 'terminal' | null
    document.addEventListener('keydown', (e) => {
      if (!((e.ctrlKey || e.metaKey) && e.key === 'v')) return;
      unfocusedPasteMode = null;
      if (isExternalInputFocused()) return;
      const active = document.activeElement;
      if (active && active !== document.body && active.closest('.pane')) return;
      if (document.querySelector('.pane.focused')) return;
      unfocusedPasteMode = e.shiftKey ? 'terminal' : 'note';
    });

    // Count total images across all note panes for limit checking
    function countTotalNoteImages() {
      return state.panes
        .filter(p => p.type === 'note' && p.images)
        .reduce((sum, p) => sum + p.images.length, 0);
    }

    // Check if adding N images would exceed the tier limit
    function checkNoteImageLimit(count) {
      const tier = window.__tcTier;
      if (!tier || !tier.limits || tier.limits.noteImages === undefined) return true;
      if (tier.limits.noteImages === null || tier.limits.noteImages === Infinity) return true;
      const current = countTotalNoteImages();
      if (current + count > tier.limits.noteImages) {
        showUpgradePrompt(
          `Your ${(tier.tier || 'free').charAt(0).toUpperCase() + (tier.tier || 'free').slice(1)} plan allows ${tier.limits.noteImages} images across all notes. You have ${current}. Upgrade for more.`
        );
        return false;
      }
      return true;
    }

    document.addEventListener('paste', (e) => {
      const text = e.clipboardData && e.clipboardData.getData('text');

      // Extract image files from clipboard
      function getClipboardImages(clipboardData) {
        const images = [];
        if (!clipboardData || !clipboardData.items) return images;
        for (const item of clipboardData.items) {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) images.push(file);
          }
        }
        return images;
      }

      if (unfocusedPasteMode === 'note') {
        unfocusedPasteMode = null;
        const imageFiles = getClipboardImages(e.clipboardData);
        if (!text && imageFiles.length === 0) return;
        e.preventDefault();
        const cursorCanvasPos = {
          x: (lastMouseX - state.panX) / state.zoom,
          y: (lastMouseY - state.panY) / state.zoom
        };
        if (imageFiles.length > 0) {
          if (!checkNoteImageLimit(imageFiles.length)) return;
          // Read images as data URLs then create the note pane
          Promise.all(imageFiles.map(file => new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
          }))).then(dataUrls => {
            const validUrls = dataUrls.filter(Boolean);
            createNotePane(cursorCanvasPos, text || '', validUrls);
          });
        } else {
          createNotePane(cursorCanvasPos, text);
        }
        return;
      }

      if (unfocusedPasteMode === 'terminal') {
        unfocusedPasteMode = null;
        if (!text || !lastFocusedPaneId) return;
        const paneData = state.panes.find(p => p.id === lastFocusedPaneId);
        if (!paneData || paneData.type !== 'terminal') return;
        e.preventDefault();
        const encoded = btoa(unescape(encodeURIComponent(text)));
        if (selectedPaneIds.size > 1) {
          for (const selectedId of selectedPaneIds) {
            const sp = state.panes.find(x => x.id === selectedId);
            if (sp && sp.type === 'terminal') {
              sendWs('terminal:input', { terminalId: selectedId, data: encoded });
            }
          }
        } else {
          sendWs('terminal:input', { terminalId: paneData.id, data: encoded });
        }
        return;
      }

      // Backup: focused terminal pane where xterm's native paste didn't fire onData
      unfocusedPasteMode = null;
      const focusedPane = document.querySelector('.pane.focused');
      if (!focusedPane) return;
      const paneId = focusedPane.dataset.paneId;
      const paneData = state.panes.find(p => p.id === paneId);
      if (!paneData || paneData.type !== 'terminal') return;
      if (!text) return;
      e.preventDefault();
      const encoded = btoa(unescape(encodeURIComponent(text)));
      if (selectedPaneIds.size > 1) {
        for (const selectedId of selectedPaneIds) {
          const sp = state.panes.find(x => x.id === selectedId);
          if (sp && sp.type === 'terminal') {
            sendWs('terminal:input', { terminalId: selectedId, data: encoded });
          }
        }
      } else {
        sendWs('terminal:input', { terminalId: paneData.id, data: encoded });
      }
    });
  }

  // Build a priority-sorted list of terminal panes for Tab cycling.
  // Priority: permission/question/inputNeeded (highest) → other notifications → all terminals.
  // Within each group, earliest notification first (by toast DOM order), then pane array order.
  function getTabCycleOrder() {
    const terminals = state.panes.filter(p => p.type === 'terminal');
    if (terminals.length === 0) return [];

    const high = [];   // permission, question, inputNeeded
    const medium = []; // other active toasts (idle/done notifications)
    const rest = [];   // everything else

    for (const pane of terminals) {
      const el = document.getElementById(`pane-${pane.id}`);
      if (!el) { rest.push(pane); continue; }

      const isPermission = el.classList.contains('claude-permission');
      const isQuestion = el.classList.contains('claude-question') || el.classList.contains('claude-input-needed');

      if (isPermission || isQuestion) {
        high.push(pane);
      } else if (activeToasts.has(pane.id)) {
        medium.push(pane);
      } else {
        rest.push(pane);
      }
    }

    return [...high, ...medium, ...rest];
  }

  // Move Mode: find the nearest pane in a direction using angular cone search
  function findPaneInDirection(fromPaneId, direction) {
    const from = state.panes.find(p => p.id === fromPaneId);
    if (!from) return null;

    const fromCx = from.x + from.width / 2;
    const fromCy = from.y + from.height / 2;

    // Direction angles (in radians, 0 = right, counter-clockwise)
    // Note: canvas Y increases downward, so "up" is negative Y
    const dirAngles = {
      w: -Math.PI / 2,  // up
      a: Math.PI,        // left
      s: Math.PI / 2,    // down
      d: 0               // right
    };

    const targetAngle = dirAngles[direction];
    if (targetAngle === undefined) return null;

    function searchCone(halfAngle) {
      let best = null;
      let bestDist = Infinity;

      for (const p of state.panes) {
        if (p.id === fromPaneId) continue;
        const cx = p.x + p.width / 2;
        const cy = p.y + p.height / 2;
        const dx = cx - fromCx;
        const dy = cy - fromCy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) continue; // skip overlapping

        const angle = Math.atan2(dy, dx);
        // Angular difference (normalized to [-PI, PI])
        let diff = angle - targetAngle;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;

        if (Math.abs(diff) <= halfAngle && dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      return best;
    }

    // Try 90-degree cone first (45 degrees each side)
    let result = searchCone(Math.PI / 4);
    // Fallback: widen to 150-degree cone (75 degrees each side)
    if (!result) result = searchCone((75 * Math.PI) / 180);
    return result;
  }

  // Calculate zoom level to fit a pane at ~70% of viewport
  function calcMoveModeZoom(paneData) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return Math.min(
      (vw * 0.7) / paneData.width,
      (vh * 0.7) / paneData.height
    );
  }

  // ============================================================================
  // SECTION 21: MOVE MODE (WASD NAVIGATION)                      [Lines ~9406-9585]
  // enterMoveMode(), exitMoveMode(), applyMoveModeVisuals(),
  // moveModeNavigate(), findPaneInDirection() (spatial lookup)
  // ============================================================================

  function enterMoveMode() {
    if (moveModeActive) return;
    moveModeActive = true;
    // Hide cursor and kill pointer-events on panes — prevents hover focus stealing
    document.body.classList.add('cursor-suppressed');
    // Clear all focused outlines — move mode has its own visual system
    document.querySelectorAll('.pane.focused').forEach(p => p.classList.remove('focused'));
    moveModeOriginalZoom = state.zoom;

    // Determine starting pane: last focused, or nearest to screen center
    let startPane = lastFocusedPaneId && state.panes.find(p => p.id === lastFocusedPaneId);
    if (!startPane && state.panes.length > 0) {
      const vcx = (window.innerWidth / 2 - state.panX) / state.zoom;
      const vcy = (window.innerHeight / 2 - state.panY) / state.zoom;
      let bestDist = Infinity;
      for (const p of state.panes) {
        const cx = p.x + p.width / 2;
        const cy = p.y + p.height / 2;
        const d = Math.sqrt((cx - vcx) ** 2 + (cy - vcy) ** 2);
        if (d < bestDist) { bestDist = d; startPane = p; }
      }
    }
    if (!startPane) { moveModeActive = false; return; }

    moveModePaneId = startPane.id;

    // Zoom to fit starting pane at ~70% of viewport
    const targetZoom = calcMoveModeZoom(startPane);
    state.zoom = targetZoom;
    const paneCenterX = startPane.x + startPane.width / 2;
    const paneCenterY = startPane.y + startPane.height / 2;
    state.panX = window.innerWidth / 2 - paneCenterX * state.zoom;
    state.panY = window.innerHeight / 2 - paneCenterY * state.zoom;

    // Animate the transition
    canvas.style.transition = 'transform 100ms ease';
    updateCanvasTransform();
    setTimeout(() => { canvas.style.transition = ''; }, 120);

    // Blur ALL terminals so no xterm holds focus during move mode
    terminals.forEach(({ xterm }) => { if (xterm) xterm.blur(); });

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

  function exitMoveMode(confirm = true) {
    if (!moveModeActive) return;
    moveModeActive = false;

    // Esc (cancel): restore original zoom, centered on current pane
    if (!confirm) {
      state.zoom = moveModeOriginalZoom;
      if (moveModePaneId) {
        const pd = state.panes.find(p => p.id === moveModePaneId);
        if (pd) {
          const cx = pd.x + pd.width / 2;
          const cy = pd.y + pd.height / 2;
          state.panX = window.innerWidth / 2 - cx * state.zoom;
          state.panY = window.innerHeight / 2 - cy * state.zoom;
        }
      }
    }
    // Enter/Tab (confirm): keep current zoom and pan as-is

    // Animate transition
    canvas.style.transition = 'transform 100ms ease';
    updateCanvasTransform();
    setTimeout(() => { canvas.style.transition = ''; }, 120);

    // Remove visual classes and overlays
    document.querySelectorAll('.pane.move-mode-active').forEach(p => p.classList.remove('move-mode-active'));
    document.querySelectorAll('.pane.move-mode-dimmed').forEach(p => p.classList.remove('move-mode-dimmed'));
    document.querySelectorAll('.pane .pane-hover-overlay').forEach(o => o.remove());

    // Hide indicator
    const indicator = document.getElementById('move-mode-indicator');
    if (indicator) indicator.style.display = 'none';

    // Blur ALL terminals to ensure clean slate — prevents stale xterm focus
    terminals.forEach(({ xterm }) => { if (xterm) xterm.blur(); });

    // Focus the highlighted pane (delay terminal focus so browser settles DOM changes)
    if (moveModePaneId) {
      const paneData = state.panes.find(p => p.id === moveModePaneId);
      const focusPaneId = moveModePaneId;
      if (paneData) {
        focusPane(paneData);
        setTimeout(() => { focusTerminalInput(focusPaneId); }, 50);
      }
    }
    moveModePaneId = null;
    saveViewState();

    // Keep cursor/pointer suppressed until actual mouse movement
    // (prevents browser-fired mouseenter from stealing focus when overlays are removed)
    const reEnableMouse = () => {
      document.body.classList.remove('cursor-suppressed');
      document.removeEventListener('mousemove', reEnableMouse);
    };
    document.addEventListener('mousemove', reEnableMouse);
  }

  function applyMoveModeVisuals() {
    document.querySelectorAll('.pane.move-mode-active').forEach(p => p.classList.remove('move-mode-active'));
    document.querySelectorAll('.pane.move-mode-dimmed').forEach(p => p.classList.remove('move-mode-dimmed'));
    document.querySelectorAll('.pane .pane-hover-overlay').forEach(o => o.remove());

    document.querySelectorAll('.pane').forEach(paneEl => {
      const id = paneEl.dataset.paneId || paneEl.id.replace('pane-', '');
      if (id === moveModePaneId) {
        paneEl.classList.add('move-mode-active');
      } else {
        paneEl.classList.add('move-mode-dimmed');
      }
      const paneData = state.panes.find(p => p.id === id);
      if (paneData && id !== moveModePaneId) {
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

  function moveModeNavigate(direction) {
    if (!moveModeActive || !moveModePaneId) return;
    const target = findPaneInDirection(moveModePaneId, direction);
    if (!target) return;

    moveModePaneId = target.id;

    // Zoom to fit target pane at ~70% viewport and center
    const targetZoom = calcMoveModeZoom(target);
    state.zoom = targetZoom;
    const cx = target.x + target.width / 2;
    const cy = target.y + target.height / 2;
    state.panX = window.innerWidth / 2 - cx * state.zoom;
    state.panY = window.innerHeight / 2 - cy * state.zoom;

    canvas.style.transition = 'transform 100ms ease';
    updateCanvasTransform();
    setTimeout(() => { canvas.style.transition = ''; }, 120);

    // Re-blur terminal so keys stay in move mode
    const termInfo = terminals.get(target.id);
    if (termInfo && termInfo.xterm) termInfo.xterm.blur();

    applyMoveModeVisuals();
  }

  // ============================================================================
  // SECTION 22: KEYBOARD SHORTCUTS                               [Lines ~9586-9975]
  // setupKeyboardShortcuts() (~390 lines):
  //   Tab chords: Tab+Q (cycle), Tab+A (add), Tab+D (device), Tab+1-9 (jump)
  //   Double-tap Tab -> move mode, Tab+Scroll -> canvas pan
  //   Arrow key/mouse pan, Ctrl+Scroll zoom, Escape mode exit
  // ============================================================================

  function setupKeyboardShortcuts() {
    // Tab+key chords: hold Tab, press key for shortcuts (Q=cycle, A=add, D=fleet, etc.)
    // Double-tap Tab (outside terminal): enter move mode (WASD pane navigation).
    // Tab inside terminal: passes through to terminal as normal.
    // Uses capture phase so keys are intercepted before xterm processes them.
    // tabHeld is declared at module scope (used by wheel handlers too)
    let tabChordUsed = false;
    let tabPressedInTerminal = false;

    document.addEventListener('keydown', (e) => {
      // Move mode: intercept all keys. Tab gets preventDefault but flows to keyup for exit.
      if (moveModeActive) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Tab') return; // keyup handler will call exitMoveMode
        // Map WASD and arrow keys to directions
        const arrowMap = { ArrowUp: 'w', ArrowLeft: 'a', ArrowDown: 's', ArrowRight: 'd' };
        const dir = arrowMap[e.key] || e.key.toLowerCase();
        if ((dir === 'w' || dir === 'a' || dir === 's' || dir === 'd') && !e.repeat) {
          moveModeNavigate(dir);
        } else if (e.key === 'Enter') {
          exitMoveMode(true);   // confirm: keep zoom
        } else if (e.key === 'Escape') {
          exitMoveMode(false);  // cancel: restore zoom
        }
        return;
      }

      if (e.key === 'Tab') {
        if (!e.repeat) {
          tabHeld = true;
          tabChordUsed = false;
          // Detect if a terminal pane currently has focus
          const active = document.activeElement;
          const paneEl = active && active.closest('.pane');
          const paneId = paneEl && paneEl.id.replace('pane-', '');
          const paneData = paneId && state.panes.find(p => p.id === paneId);
          tabPressedInTerminal = !!(paneData && paneData.type === 'terminal');
        }
        // Always prevent default Tab (browser tab-cycling and terminal tab insertion)
        if (!isExternalInputFocused()) {
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'q' && tabHeld) {
        tabChordUsed = true;
        e.preventDefault();
        e.stopPropagation();

        const order = getTabCycleOrder();
        if (order.length === 0) return;

        const currentIdx = order.findIndex(p => p.id === lastFocusedPaneId);
        const nextIdx = currentIdx === -1 ? 0 : (currentIdx + 1) % order.length;
        panToPane(order[nextIdx].id);
        return;
      }
      if (e.key === 'a' && tabHeld) {
        tabChordUsed = true;
        e.preventDefault();
        e.stopPropagation();
        const addMenu = document.getElementById('add-pane-menu');
        addMenu.classList.toggle('hidden');
        return;
      }
      // Tab+D: toggle fleet (machines) pane collapse/expand
      if (e.key === 'd' && tabHeld) {
        tabChordUsed = true;
        e.preventDefault();
        e.stopPropagation();
        if (hudHidden) {
          // From dot mode: unhide HUD, show only machines pane expanded
          hudHidden = false;
          fleetPaneHidden = false;
          agentsPaneHidden = true;
          hudExpanded = true;
          const container = document.getElementById('hud-container');
          const dot = document.getElementById('hud-restore-dot');
          if (container) container.style.display = '';
          if (dot) dot.style.display = 'none';
          applyNoHudMode(false);
          applyPaneVisibility();
          const hudEl = document.getElementById('hud-overlay');
          if (hudEl) hudEl.classList.remove('collapsed');
          savePrefsToCloud({ hudState: { fleet_expanded: hudExpanded, agents_expanded: agentsHudExpanded, feedback_expanded: feedbackHudExpanded, hud_hidden: hudHidden } });
          restartHudPolling();
          renderHud();
        } else if (fleetPaneHidden || agentsPaneHidden) {
          // Selective mode: some panes individually hidden
          if (fleetPaneHidden) {
            // Show this pane (expanded)
            fleetPaneHidden = false;
            hudExpanded = true;
            applyPaneVisibility();
            const hudEl = document.getElementById('hud-overlay');
            if (hudEl) hudEl.classList.remove('collapsed');
            savePrefsToCloud({ hudState: { fleet_expanded: hudExpanded, agents_expanded: agentsHudExpanded, feedback_expanded: feedbackHudExpanded } });
            restartHudPolling();
            renderHud();
          } else {
            // Hide this pane
            fleetPaneHidden = true;
            applyPaneVisibility();
            checkAutoHideHud();
          }
        } else {
          // Normal mode: all panes visible, toggle collapsed/expanded as before
          const hudEl = document.getElementById('hud-overlay');
          if (hudEl) {
            hudExpanded = !hudExpanded;
            hudEl.classList.toggle('collapsed', !hudExpanded);
            savePrefsToCloud({ hudState: { fleet_expanded: hudExpanded, agents_expanded: agentsHudExpanded, feedback_expanded: feedbackHudExpanded } });
            restartHudPolling();
            renderHud();
          }
        }
        return;
      }
      // Tab+U: toggle agents (usage) pane collapse/expand
      if (e.key === 'u' && tabHeld) {
        tabChordUsed = true;
        e.preventDefault();
        e.stopPropagation();
        if (hudHidden) {
          // From dot mode: unhide HUD, show only usage pane expanded
          hudHidden = false;
          fleetPaneHidden = true;
          agentsPaneHidden = false;
          agentsHudExpanded = true;
          const container = document.getElementById('hud-container');
          const dot = document.getElementById('hud-restore-dot');
          if (container) container.style.display = '';
          if (dot) dot.style.display = 'none';
          applyNoHudMode(false);
          applyPaneVisibility();
          const agentsEl = document.getElementById('agents-hud');
          if (agentsEl) agentsEl.classList.remove('collapsed');
          savePrefsToCloud({ hudState: { fleet_expanded: hudExpanded, agents_expanded: agentsHudExpanded, feedback_expanded: feedbackHudExpanded, hud_hidden: hudHidden } });
          renderAgentsHud();
        } else if (fleetPaneHidden || agentsPaneHidden) {
          // Selective mode
          if (agentsPaneHidden) {
            agentsPaneHidden = false;
            agentsHudExpanded = true;
            applyPaneVisibility();
            const agentsEl = document.getElementById('agents-hud');
            if (agentsEl) agentsEl.classList.remove('collapsed');
            savePrefsToCloud({ hudState: { fleet_expanded: hudExpanded, agents_expanded: agentsHudExpanded, feedback_expanded: feedbackHudExpanded } });
            renderAgentsHud();
          } else {
            agentsPaneHidden = true;
            applyPaneVisibility();
            checkAutoHideHud();
          }
        } else {
          // Normal mode: toggle collapsed/expanded
          const agentsEl = document.getElementById('agents-hud');
          if (agentsEl) {
            agentsHudExpanded = !agentsHudExpanded;
            agentsEl.classList.toggle('collapsed', !agentsHudExpanded);
            savePrefsToCloud({ hudState: { fleet_expanded: hudExpanded, agents_expanded: agentsHudExpanded, feedback_expanded: feedbackHudExpanded } });
            renderAgentsHud();
          }
        }
        return;
      }
      // Tab+H: toggle hide/show all HUD panes
      if (e.key === 'h' && tabHeld) {
        tabChordUsed = true;
        e.preventDefault();
        e.stopPropagation();
        toggleHudHidden();
        return;
      }

      // Tab+S: open settings modal
      if (e.key === 's' && tabHeld) {
        tabChordUsed = true;
        e.preventDefault();
        e.stopPropagation();
        showSettingsModal();
        return;
      }
      // Tab+W: close focused pane (or all broadcasted if in broadcast mode)
      if (e.key === 'w' && tabHeld) {
        tabChordUsed = true;
        e.preventDefault();
        e.stopPropagation();
        if (selectedPaneIds.size > 1) {
          // Broadcast mode: close all selected panes
          const idsToClose = Array.from(selectedPaneIds);
          clearMultiSelect();
          for (const id of idsToClose) {
            deletePane(id);
          }
        } else {
          // Single mode: close focused pane (fallback to DOM query if lastFocusedPaneId is stale)
          const targetId = lastFocusedPaneId || (document.querySelector('.pane.focused')?.dataset?.paneId);
          if (targetId) {
            const targetPane = state.panes.find(p => p.id === targetId);
            if (targetPane && targetPane.tabGroupId) closeTabInGroup(targetId);
            else deletePane(targetId);
          }
        }
        return;
      }
      // Tab+M: toggle minimap
      if (e.key === 'm' && tabHeld) {
        tabChordUsed = true;
        e.preventDefault();
        e.stopPropagation();
        setMinimapEnabled(!getMinimapEnabled());
        if (!getMinimapEnabled()) {
          hideMinimap();
        } else {
          startMinimapLoop();
        }
        return;
      }
      // Tab+P: toggle projects sidebar
      if (e.key === 'p' && tabHeld) {
        tabChordUsed = true;
        e.preventDefault();
        e.stopPropagation();
        toggleProjectsSidebar();
        return;
      }
      // Tab+`: cycle to next tab in focused pane's tab group
      if (e.key === '`' && tabHeld) {
        tabChordUsed = true;
        e.preventDefault();
        e.stopPropagation();
        const focusedPane = lastFocusedPaneId && state.panes.find(p => p.id === lastFocusedPaneId);
        if (focusedPane && focusedPane.tabGroupId) {
          const groupPanes = getTabGroupPanes(focusedPane.tabGroupId);
          if (groupPanes.length > 1) {
            const activeIdx = groupPanes.findIndex(p => p.tabGroupActive);
            const nextIdx = (activeIdx + 1) % groupPanes.length;
            switchTab(groupPanes[nextIdx].id);
          }
        }
        return;
      }
      // Tab+=: create new tab in focused pane's group
      if (e.key === '=' && tabHeld) {
        tabChordUsed = true;
        e.preventDefault();
        e.stopPropagation();
        if (lastFocusedPaneId) {
          const focusedPane = state.panes.find(p => p.id === lastFocusedPaneId);
          if (focusedPane && focusedPane.type === 'terminal') {
            createTabInGroup(lastFocusedPaneId);
          }
        }
        return;
      }
      // Tab+1..9: jump to pane or project with that shortcut number (shared pool)
      if (tabHeld && e.key >= '1' && e.key <= '9') {
        const num = parseInt(e.key, 10);
        // Check panes first (includes checkpoint panes)
        const targetPane = state.panes.find(p => p.shortcutNumber === num);
        if (targetPane) {
          tabChordUsed = true;
          e.preventDefault();
          e.stopPropagation();
          if (targetPane.type === 'checkpoint') {
            navigateToCheckpointPane(targetPane);
          } else {
            jumpToPane(targetPane);
          }
          return;
        }
        // Check projects (zoom-to-fit)
        const targetProject = state.projects.find(p => p.shortcutNumber === num);
        if (targetProject) {
          tabChordUsed = true;
          e.preventDefault();
          e.stopPropagation();
          navigateToProject(targetProject);
          return;
        }
        return;
      }
    }, true); // capture phase

    document.addEventListener('keyup', (e) => {
      if (e.key === 'Tab') {
        const wasChord = tabChordUsed;
        const wasInTerminal = tabPressedInTerminal;
        tabHeld = false;
        tabChordUsed = false;
        tabPressedInTerminal = false;

        if (wasChord || isExternalInputFocused()) {
          lastTabUpTime = 0;
          return;
        }

        // Move mode: Tab exits move mode
        if (moveModeActive) {
          exitMoveMode(true);  // Tab = confirm (keep zoom)
          lastTabUpTime = 0;
          return;
        }

        // Double-tap detection
        const now = Date.now();
        if (now - lastTabUpTime < 300) {
          lastTabUpTime = 0;
          enterMoveMode();
          return;
        }
        lastTabUpTime = now;
        // Solo Tab (first tap): no-op, just records timestamp for double-tap detection
      }
    }, true);

    window.addEventListener('blur', () => { tabHeld = false; tabChordUsed = false; tabPressedInTerminal = false; if (moveModeActive) exitMoveMode(false); });

    // Escape: exit mention mode or clear broadcast selection
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (mentionModeActive) {
          exitMentionMode();
          return;
        }
        if (selectedPaneIds.size > 0) {
          clearMultiSelect();
        }
      }
    });

    // Ctrl+Shift+@ → toggle mention mode
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey && e.shiftKey && e.key === '@')) return;
      e.preventDefault();
      if (mentionModeActive) {
        exitMentionMode();
      } else {
        enterMentionMode();
      }
    });

    // Non-Shift click outside broadcast panes clears selection
    document.addEventListener('mousedown', (e) => {
      if (e.shiftKey) return;
      if (selectedPaneIds.size === 0) return;
      // Don't clear if clicking inside a broadcast-selected pane
      if (isInsideBroadcastPane(e.target)) return;
      clearMultiSelect();
    });

    // Ctrl/Cmd +/-/0 : pane zoom if focused, canvas zoom otherwise
    document.addEventListener('keydown', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const isPlus = e.key === '=' || e.key === '+';
      const isMinus = e.key === '-';
      const isReset = e.key === '0';
      if (!isPlus && !isMinus && !isReset) return;

      e.preventDefault();

      if (isReset) {
        const focusedPaneEl = document.querySelector('.pane.focused');
        if (focusedPaneEl) {
          const paneId = focusedPaneEl.dataset.paneId;
          const paneData = state.panes.find(p => p.id === paneId);
          if (!paneData) return;
          paneData.zoomLevel = 100;
          applyPaneZoom(paneData, focusedPaneEl);
          cloudSaveLayout(paneData);
        } else {
          setZoom(1, window.innerWidth / 2, window.innerHeight / 2);
        }
        return;
      }

      const focusedPaneEl = document.querySelector('.pane.focused');
      if (focusedPaneEl) {
        const paneId = focusedPaneEl.dataset.paneId;
        const paneData = state.panes.find(p => p.id === paneId);
        if (!paneData) return;

        if (!paneData.zoomLevel) paneData.zoomLevel = 100;
        paneData.zoomLevel = isPlus
          ? Math.min(500, paneData.zoomLevel + 10)
          : Math.max(20, paneData.zoomLevel - 10);
        applyPaneZoom(paneData, focusedPaneEl);
        cloudSaveLayout(paneData);
      } else {
        const factor = isPlus ? 1.2 : 1 / 1.2;
        setZoom(state.zoom * factor, window.innerWidth / 2, window.innerHeight / 2);
      }
    });

    // Ctrl/Cmd+S: save focused file pane; Ctrl/Cmd+W: close focused pane
    document.addEventListener('keydown', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.key !== 's' && e.key !== 'w') return;

      const focusedPaneEl = document.querySelector('.pane.focused');
      if (!focusedPaneEl) return;

      const paneId = focusedPaneEl.dataset.paneId;
      const paneData = state.panes.find(p => p.id === paneId);
      if (!paneData) return;

      if (e.key === 's' && paneData.type === 'file') {
        e.preventDefault();
        const saveBtn = focusedPaneEl.querySelector('.save-btn');
        if (saveBtn) saveBtn.click();
      } else if (e.key === 'w') {
        e.preventDefault();
        deletePane(paneId);
      }
    });

    // Auto-refocus last pane when typing with nothing focused
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isExternalInputFocused()) return;
      const active = document.activeElement;
      if (active && active !== document.body && active.closest('.pane')) return;
      if (document.querySelector('.pane.focused')) return;
      if (!lastFocusedPaneId) return;
      const paneData = state.panes.find(p => p.id === lastFocusedPaneId);
      if (!paneData) return;

      e.preventDefault();
      e.stopPropagation();

      focusPane(paneData);
      if (paneData.type === 'terminal') {
        focusTerminalInput(paneData.id);
      } else if (paneData.type === 'note') {
        const paneEl = document.getElementById(`pane-${paneData.id}`);
        const noteEditor = paneEl?.querySelector('.note-editor');
        if (noteEditor) noteEditor.focus();
      } else if (paneData.type === 'file') {
        const edInfo = fileEditors.get(paneData.id);
        if (edInfo?.monacoEditor) edInfo.monacoEditor.focus();
      }
    });
  }

  // ============================================================================
  // SECTION 23: CANVAS EVENT LISTENERS                           [Lines ~9976-10289]
  // setupEventListeners(): canvas mouse/touch handlers,
  //   handleCanvasPanStart(), selection rect (Shift+drag),
  //   middle/right mouse pan, touch pinch zoom,
  //   handleWheel(), setZoom()
  // ============================================================================

  function setupEventListeners() {
    setupAddPaneMenu();
    setupToolbarButtons();
    setupCustomTooltips();
    setupCanvasInteraction();
    setupPasteHandlers();
    setupKeyboardShortcuts();
    setupMobileNavDrawer();

    // Prevent Safari's native pinch-to-zoom (bypasses touch-action: none)
    document.addEventListener('gesturestart', e => e.preventDefault());
    document.addEventListener('gesturechange', e => e.preventDefault());
  }

  // Handle canvas pan start (mouse)
  function handleCanvasPanStart(e) {
    if (placementMode) return;
    if (e.target !== canvas && e.target !== canvasContainer) return;

    // Shift+drag on empty canvas: selection rectangle for broadcast
    if (e.shiftKey) {
      startSelectionRect(e);
      return;
    }

    isPanning = true;
    panStartX = e.clientX - state.panX;
    panStartY = e.clientY - state.panY;
    showIframeOverlays();

    const moveHandler = (moveE) => {
      if (!isPanning) return;
      state.panX = moveE.clientX - panStartX;
      state.panY = moveE.clientY - panStartY;
      updateCanvasTransform();
    };

    const endHandler = () => {
      isPanning = false;
      hideIframeOverlays();
      saveViewState();
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', endHandler);
    };

    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', endHandler);
  }

  function startSelectionRect(e) {
    const selRect = document.getElementById('selection-rect');
    if (!selRect) return;

    // Convert client coords to canvas coords (account for pan and zoom)
    const startCanvasX = (e.clientX - state.panX) / state.zoom;
    const startCanvasY = (e.clientY - state.panY) / state.zoom;

    selRect.style.left = startCanvasX + 'px';
    selRect.style.top = startCanvasY + 'px';
    selRect.style.width = '0px';
    selRect.style.height = '0px';
    selRect.style.display = 'block';

    showIframeOverlays();

    const moveHandler = (moveE) => {
      const curCanvasX = (moveE.clientX - state.panX) / state.zoom;
      const curCanvasY = (moveE.clientY - state.panY) / state.zoom;

      const x = Math.min(startCanvasX, curCanvasX);
      const y = Math.min(startCanvasY, curCanvasY);
      const w = Math.abs(curCanvasX - startCanvasX);
      const h = Math.abs(curCanvasY - startCanvasY);

      selRect.style.left = x + 'px';
      selRect.style.top = y + 'px';
      selRect.style.width = w + 'px';
      selRect.style.height = h + 'px';
    };

    const endHandler = () => {
      selRect.style.display = 'none';
      hideIframeOverlays();

      // Get the final rectangle bounds in canvas coords
      const rx = parseFloat(selRect.style.left);
      const ry = parseFloat(selRect.style.top);
      const rw = parseFloat(selRect.style.width);
      const rh = parseFloat(selRect.style.height);

      // Only select if the user actually dragged (not just a shift+click on canvas)
      if (rw > 5 || rh > 5) {
        // Find all panes that overlap the selection rectangle
        state.panes.forEach(p => {
          const overlaps =
            p.x < rx + rw &&
            p.x + p.width > rx &&
            p.y < ry + rh &&
            p.y + p.height > ry;

          if (overlaps && !selectedPaneIds.has(p.id)) {
            selectedPaneIds.add(p.id);
            const el = document.getElementById(`pane-${p.id}`);
            if (el) el.classList.add('broadcast-selected');
          }
        });
        updateBroadcastIndicator();
      }

      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', endHandler);
    };

    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', endHandler);
  }

  // Middle mouse button pan — works even over panes
  function handleMiddleMousePan(e) {
    if (e.button !== 1) return; // only middle mouse
    e.preventDefault();  // prevent browser auto-scroll
    e.stopPropagation(); // prevent pane drag/focus handlers

    isPanning = true;
    panStartX = e.clientX - state.panX;
    panStartY = e.clientY - state.panY;
    document.body.style.cursor = 'grabbing';
    canvasContainer.classList.add('middle-panning');
    showIframeOverlays();

    const moveHandler = (moveE) => {
      if (!isPanning) return;
      moveE.preventDefault();
      state.panX = moveE.clientX - panStartX;
      state.panY = moveE.clientY - panStartY;
      updateCanvasTransform();
    };

    const endHandler = (upE) => {
      if (upE.button !== 1) return; // only release on middle mouse up
      isPanning = false;
      document.body.style.cursor = '';
      canvasContainer.classList.remove('middle-panning');
      hideIframeOverlays();
      saveViewState();
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', endHandler);
    };

    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', endHandler);
  }

  // Right mouse button pan — works even over panes (terminals, editors, etc.)
  function handleRightMousePan(e) {
    if (e.button !== 2) return;
    e.preventDefault();
    e.stopPropagation();

    isPanning = true;
    let didMove = false;
    panStartX = e.clientX - state.panX;
    panStartY = e.clientY - state.panY;
    document.body.style.cursor = 'grabbing';
    showIframeOverlays();

    // Suppress context menu while dragging
    const suppressContextMenu = (ce) => { ce.preventDefault(); };
    document.addEventListener('contextmenu', suppressContextMenu, true);

    const moveHandler = (moveE) => {
      if (!isPanning) return;
      moveE.preventDefault();
      didMove = true;
      state.panX = moveE.clientX - panStartX;
      state.panY = moveE.clientY - panStartY;
      updateCanvasTransform();
    };

    const endHandler = (upE) => {
      if (upE.button !== 2) return;
      isPanning = false;
      document.body.style.cursor = '';
      hideIframeOverlays();
      saveViewState();
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', endHandler);
      // Remove context menu suppression after a tick (so the mouseup's contextmenu is still caught)
      setTimeout(() => {
        document.removeEventListener('contextmenu', suppressContextMenu, true);
      }, 0);
    };

    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', endHandler);
  }

  // Handle touch start for pan/pinch
  // Momentum state for touch pan inertia
  let momentumRaf = null;

  function handleTouchStart(e) {
    if (e.target !== canvas && e.target !== canvasContainer) return;

    // Cancel any in-flight momentum animation
    if (momentumRaf) { cancelAnimationFrame(momentumRaf); momentumRaf = null; }

    if (e.touches.length === 1) {
      e.preventDefault();
      isPanning = true;
      panStartX = e.touches[0].clientX - state.panX;
      panStartY = e.touches[0].clientY - state.panY;
      lastPanX = state.panX;
      lastPanY = state.panY;
      showIframeOverlays();
    } else if (e.touches.length === 2) {
      e.preventDefault();
      isPanning = false;
      initialPinchDistance = getPinchDistance(e.touches);
      initialZoom = state.zoom;
    }

    // Velocity tracking: store last 3 touch samples for momentum calculation
    const samples = []; // { x, y, t }

    const moveHandler = (moveE) => {
      if (moveE.touches.length === 1 && isPanning) {
        moveE.preventDefault();
        state.panX = moveE.touches[0].clientX - panStartX;
        state.panY = moveE.touches[0].clientY - panStartY;
        updateCanvasTransform();

        const now = Date.now();
        samples.push({ x: state.panX, y: state.panY, t: now });
        if (samples.length > 3) samples.shift();
      } else if (moveE.touches.length === 2) {
        moveE.preventDefault();
        const currentDistance = getPinchDistance(moveE.touches);
        const scale = currentDistance / initialPinchDistance;
        const newZoom = Math.max(0.05, Math.min(4, initialZoom * scale));

        const centerX = (moveE.touches[0].clientX + moveE.touches[1].clientX) / 2;
        const centerY = (moveE.touches[0].clientY + moveE.touches[1].clientY) / 2;

        setZoom(newZoom, centerX, centerY);
      }
    };

    const endHandler = () => {
      isPanning = false;
      hideIframeOverlays();
      canvasContainer.removeEventListener('touchmove', moveHandler);
      canvasContainer.removeEventListener('touchend', endHandler);

      // Compute velocity from recent samples and apply momentum
      if (samples.length >= 2) {
        const oldest = samples[0];
        const newest = samples[samples.length - 1];
        const dt = newest.t - oldest.t;
        if (dt > 0 && dt < 200) { // Only if recent enough to be intentional
          let vx = (newest.x - oldest.x) / dt * 16; // px per frame (~16ms)
          let vy = (newest.y - oldest.y) / dt * 16;
          const friction = 0.92;
          const minV = 0.3;

          const animate = () => {
            vx *= friction;
            vy *= friction;
            if (Math.abs(vx) < minV && Math.abs(vy) < minV) {
              momentumRaf = null;
              saveViewState();
              return;
            }
            state.panX += vx;
            state.panY += vy;
            updateCanvasTransform();
            momentumRaf = requestAnimationFrame(animate);
          };
          momentumRaf = requestAnimationFrame(animate);
          return; // saveViewState called when momentum ends
        }
      }
      saveViewState();
    };

    canvasContainer.addEventListener('touchmove', moveHandler, { passive: false });
    canvasContainer.addEventListener('touchend', endHandler);
  }

  // Get distance between two touch points
  function getPinchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Scroll target lock: once a scroll gesture starts on a pane (or canvas),
  // keep routing to that target until the gesture ends.
  // Touchpad gestures produce small frequent deltas with momentum/inertia gaps,
  // so use a longer lock (500ms) to cover the full gesture including inertia.
  let scrollLockTarget = null; // 'pane' or 'canvas' or null
  let scrollLockTimer = null;

  function handleWheel(e) {
    // Ctrl+Scroll anywhere = always canvas zoom
    if (e.ctrlKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setZoom(state.zoom * delta, e.clientX, e.clientY);
      return;
    }

    // Tab+Scroll anywhere = always pan canvas (even over panes)
    if (tabHeld) {
      e.preventDefault();
      e.stopPropagation();
      state.panX -= e.deltaX || 0;
      state.panY -= e.deltaY;
      updateCanvasTransform();
      saveViewState();
      return;
    }

    // Check if mouse is currently over a pane
    const paneEl = e.target.closest('.pane');
    const onPane = !!paneEl;

    // If mouse is on canvas background, pan the canvas (zoom only via Ctrl+Scroll above)
    if (!onPane) {
      e.preventDefault();
      scrollLockTarget = null;
      state.panX -= e.deltaX || 0;
      state.panY -= e.deltaY;
      updateCanvasTransform();
      saveViewState();
      return;
    }

    // Mouse is on a pane — Shift+Scroll = pan canvas, normal scroll = let pane handle
    if (e.shiftKey) {
      e.preventDefault();
      state.panX -= e.deltaX || e.deltaY;
      state.panY -= e.deltaY;
      updateCanvasTransform();
      saveViewState();
    }
    // Normal scroll on pane: don't preventDefault — let terminal/editor handle it
  }

  // Set zoom centered on a point
  function setZoom(newZoom, centerX, centerY) {
    newZoom = Math.max(0.05, Math.min(4, newZoom));
    const zoomRatio = newZoom / state.zoom;
    state.panX = centerX - (centerX - state.panX) * zoomRatio;
    state.panY = centerY - (centerY - state.panY) * zoomRatio;
    state.zoom = newZoom;

    updateCanvasTransform();
    saveViewState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ============================================================================
  // SECTION 24: DEBUG EXPORTS                                    [Lines ~10297-10344]
  // window.TC2_DEBUG: exposed internals for dev mode and console debugging
  // ============================================================================

  // Debug helper - expose internals for debugging and dev mode
  window.TC2_DEBUG = {
    get terminals() { return terminals; },
    get state() { return state; },
    get ws() { return ws; },
    get agents() { return agents; },
    testInput: (terminalId, text) => {
      const termInfo = terminals.get(terminalId);
      if (termInfo) {
        sendWs('terminal:input', { terminalId, data: btoa(unescape(encodeURIComponent(text))) }, getPaneAgentId(terminalId));
      }
    },
    // Dev mode hooks
    showToast,
    dismissToast,
    handleStateTransition,
    updateClaudeStates,
    playNotificationSound,
    playDismissSound,
    renderPane,
    deletePane,
    updateCanvasTransform,
    renderHud,
    PANE_DEFAULTS,
    // Pane renderers
    renderGitGraphPane,
    renderIframePane,
    renderBeadsPane,
    renderFolderPane,
    renderFilePane,
    renderNotePane,
    // Pane creation helpers
    setupPaneListeners,
    getNextShortcutNumber,
    // Settings
    showSettingsModal,
    // Canvas
    setZoom,
    get canvas() { return canvas; },
    get expandedPaneId() { return expandedPaneId; },
    expandPane,
    collapsePane,
    panToPane,
    focusPane,
    // Minimap
    hideMinimap,
    startMinimapLoop,
  };
})();
