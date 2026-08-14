import { Terminal } from './lib/xterm.mjs';
import { FitAddon } from './lib/addon-fit.mjs';
import { WebLinksAddon } from './lib/addon-web-links.mjs';
import { playDismissSound, playNotificationSound, setSoundEnabled as _setSoundEnabled } from './modules/sounds.js';
import { escapeHtml, formatBytes, metricColorClass, formatLocationPath, isExternalInputFocused, truncateUrl, isAgentVersionOutdated, getTerminalFontFamily } from './modules/utils.js';
import { APP_VERSION, PANE_DEFAULTS, PANE_ENDPOINT_MAP, ICON_BEADS, ICON_GIT_GRAPH, ICON_FOLDER, ICON_CONVERSATIONS, CLAUDE_STATE_SVGS, CLAUDE_LOGO_SVG, RESET_ICON_SVG, WIFI_OFF_SVG, DEVICE_COLORS, TERMINAL_FONTS, CANVAS_BACKGROUNDS, osIcon } from './modules/constants.js';
import { initMinimap, startMinimapLoop, hideMinimap, renderMinimap, getCanvasBounds, calcPlacementPos, setMinimapEnabled, getMinimapEnabled } from './modules/minimap.js';
import { initNotificationDeps, initNotifications, showPromoToasts, showToast, dismissToast, snoozeNotification, sendBrowserNotification, updateTabTitleBadge, handleStateTransition, previousClaudeStates, notifiedStates, activeToasts, snoozedNotifications, snoozeCount, getIsFirstClaudeStateUpdate, setIsFirstClaudeStateUpdate, getNotificationContainer, showAdminToast, dismissAdminToast } from './modules/notifications.js';
import { initGitGraphDeps, renderGitGraphPane, fetchGitGraphData } from './modules/git-graph.js';
import { initSettingsDeps, showSettingsModal, savePrefsToCloud, getAllPrefs, setCanvasBackground, setNightMode, getCurrentTerminalFont, setCurrentTerminalFont } from './modules/settings.js';
import { initShortcutsDeps, setupKeyboardShortcuts } from './modules/shortcuts.js';
import { initWsTransportDeps, sendWs, agentRequest, pendingRequests, pendingScanCallbacks } from './modules/ws-transport.js';
import { initAgentUiDeps, showRelayNotification, showUpdateToast, showUpdateProgressToast, showUpdateCompleteToast, updateAgentOverlay, showAddMachineDialog } from './modules/agent-ui.js';
import { initMenusDeps, setupAddPaneMenu, setupTutorialMenu, autoArrangePanes, setupMobileNavDrawer, setupToolbarButtons, setupCustomTooltips, setupCanvasInteraction, setupPasteHandlers, getTabCycleOrder, findPaneInDirection, calcMoveModeZoom } from './modules/menus.js';
import { initRenderersDeps, expandPane, collapsePane, renderNotePane, initNoteMonaco, refreshNoteImages, renderMarkdownPreview, renderIframePane, setupIframeListeners, showIframeOverlays, hideIframeOverlays, createFolderPane, createBeadsPane, renderBeadsPane, renderFolderPane, setupBeadsListeners, fetchBeadsData, applyBeadsFilters } from './modules/pane-renderers.js';
import { initPaneInteractionDeps, applyPaneZoom, setupPaneListeners, findSnapTargets, findResizeSnapTargets, updateSnapGuide, showSnapGuides, removeSnapGuides, startDrag, startResizeHold, activateResize } from './modules/pane-interaction.js';
import { initHudDeps, createHudContainer, toggleHudHidden, applyPaneVisibility, checkAutoHideHud, applyNoHudMode, createHud, pollHud, restartHudPolling, renderHud, clearDeviceHighlight, createAgentsHud, createChatHud, fetchAgentsUsage, renderAgentsHud, applyTerminalTheme, updateHudDotColor, getHudExpanded, setHudExpanded, getAgentsHudExpanded, setAgentsHudExpanded, getFeedbackHudExpanded, setFeedbackHudExpanded, getHudHidden, setHudHidden, getFleetPaneHidden, setFleetPaneHidden, getAgentsPaneHidden, setAgentsPaneHidden, getDeviceColorOverrides, setDeviceColorOverrides, getHudData, setHoveredDeviceName, startHudRenderTimer, startAgentsUsagePolling, stopAgentsUsagePolling } from './modules/hud.js';
import { initEditorsDeps, setupNoteEditorListeners, setupImageButtonHandlers, setupTextOnlyToggle, setupFileEditorListeners, initTerminal } from './modules/editors.js';
import { initProjectsDeps, navigateToProject, navigateToCheckpointPane, renderProjectRectangles, renderCheckpointPane, startProjectCreation, createCheckpointPane, createProjectsSidebar, applyProjectsSidebarPosition, toggleProjectsSidebar, renderProjectsSidebar, saveProjectsToCloud, loadProjectsFromPrefs, startProjectsSidebarRefresh } from './modules/projects.js';

// 49Agents - Mobile-first terminal pane management
(function() {
  'use strict';

  // ============================================================================
  // SECTION 1: STATE & CONSTANTS                                    [Lines ~15-77]
  // All module-scope state: pane maps, mode flags, UI settings, etc.
  // ============================================================================

  // Map of note pane ID -> { monacoEditor, resizeObserver }
  const noteEditors = new Map();

  // RESIZE_HOLD_DURATION, SNAP_THRESHOLD, SNAP_GAP -> modules/pane-interaction.js

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

  // Touch/drag state. Grouped into one object so it can be passed to
  // modules by reference — assignments to imported bindings are not
  // allowed, and six getter/setter pairs would be the alternative.
  const dragState = {
    activePane: null,
    holdTimer: null,
    isDragging: false,
    isResizing: false,
    offsetX: 0,
    offsetY: 0,
  };

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

  // HUD state and rendering -> modules/hud.js

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
    let loadedPrefs = null;
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
        setCurrentTerminalFont(prefs.terminalFont);
      }
      if (prefs.focusMode) {
        focusMode = prefs.focusMode;
      } else if (matchMedia('(pointer: coarse)').matches) {
        // Touch-primary device with no saved preference: default to click focus
        focusMode = 'click';
      }
      if (prefs.hudState) {
        setHudExpanded(!!prefs.hudState.fleet_expanded);
        setAgentsHudExpanded(!!prefs.hudState.agents_expanded);
        setFeedbackHudExpanded(!!prefs.hudState.feedback_expanded);
        if (prefs.hudState.device_colors) setDeviceColorOverrides(prefs.hudState.device_colors);
        setHudHidden(!!prefs.hudState.hud_hidden);
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
      // Projects are applied after the module wiring below, since
      // loadProjectsFromPrefs lives in modules/projects.js and its context
      // is not initialised yet at this point.
      loadedPrefs = prefs;
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
    initSettingsDeps({
      cloudFetch,
      createCustomSelect,
      applyTerminalTheme,
      applyProjectsSidebarPosition,
      telemetry: _telemetry,
      getTerminals: () => terminals,
      getTerminalThemes: () => TERMINAL_THEMES,
      // Preferences owned by app.js: read through getters, written through
      // setters, because a module cannot assign to an imported binding.
      getCurrentTerminalTheme: () => currentTerminalTheme,
      getNotificationSoundEnabled: () => notificationSoundEnabled,
      setNotificationSoundEnabled: (v) => { notificationSoundEnabled = v; },
      getAutoRemoveDoneNotifs: () => autoRemoveDoneNotifs,
      setAutoRemoveDoneNotifs: (v) => { autoRemoveDoneNotifs = v; },
      getSnoozeDurationMs: () => snoozeDurationMs,
      setSnoozeDurationMs: (v) => { snoozeDurationMs = v; },
      getFocusMode: () => focusMode,
      setFocusMode: (v) => { focusMode = v; },
      getProjectsSidebarPosition: () => projectsSidebarPosition,
      setProjectsSidebarPosition: (v) => { projectsSidebarPosition = v; },
      getTeleportAnimation: () => teleportAnimation,
      setTeleportAnimation: (v) => { teleportAnimation = v; },
      getHudExpanded, getAgentsHudExpanded, getHudHidden, getDeviceColorOverrides,
      getTutorialsCompleted: () => tutorialsCompleted,
    });
    initShortcutsDeps({
      getState: () => state,
      // Pane and canvas operations
      panToPane, jumpToPane, focusPane, focusTerminalInput, deletePane,
      applyPaneZoom, cloudSaveLayout, setZoom, clearMultiSelect,
      isInsideBroadcastPane, getTabCycleOrder, getTabGroupPanes,
      switchTab, closeTabInGroup, createTabInGroup,
      navigateToProject, navigateToCheckpointPane, toggleProjectsSidebar,
      // HUD operations
      applyNoHudMode, applyPaneVisibility, checkAutoHideHud,
      renderHud, renderAgentsHud, restartHudPolling, toggleHudHidden,
      // Move and mention modes
      moveModeNavigate, enterMoveMode, exitMoveMode,
      enterMentionMode, exitMentionMode,
      getMoveModeActive: () => moveModeActive,
      getMentionModeActive: () => mentionModeActive,
      // Live collections
      getSelectedPaneIds: () => selectedPaneIds,
      getFileEditors: () => fileEditors,
      getLastFocusedPaneId: () => lastFocusedPaneId,
      // Mutable state owned by app.js. tabHeld is also read by the wheel
      // handlers for Tab+scroll panning, so it cannot move into the module.
      getTabHeld: () => tabHeld,
      setTabHeld: (v) => { tabHeld = v; },
      getLastTabUpTime: () => lastTabUpTime,
      setLastTabUpTime: (v) => { lastTabUpTime = v; },
      getHudExpanded, setHudExpanded, getAgentsHudExpanded, setAgentsHudExpanded,
      getFeedbackHudExpanded, getHudHidden, setHudHidden,
      getFleetPaneHidden, setFleetPaneHidden, getAgentsPaneHidden, setAgentsPaneHidden,
    });
    initAgentUiDeps({
      getWs: () => ws,
      getAgents: () => agents,
      getTutorialsCompleted: () => tutorialsCompleted,
    });
    initWsTransportDeps({
      getWs: () => ws,
      getActiveAgentId: () => activeAgentId,
      telemetry: _telemetry,
    });
    initRenderersDeps({
      state, terminals, fileEditors, noteEditors, beadsPanes, folderPanes,
      telemetry: _telemetry,
      clearMultiSelect, cloudSaveLayout, cloudSaveNote, createCustomSelect,
      deviceLabelHtml, enterMentionMode, getNextShortcutNumber, paneNameHtml,
      renderFilePane, saveRecentContext, shortcutBadgeHtml, showUpgradePrompt,
      getCanvas: () => canvas,
      getTabHeld: () => tabHeld,
      getMentionStage: () => mentionStage,
      getActiveAgentId: () => activeAgentId,
      getExpandedPaneId: () => expandedPaneId,
      setExpandedPaneId: (v) => { expandedPaneId = v; },
    });
    initPaneInteractionDeps({
      state, dragState, terminals, selectedPaneIds, fileEditors, noteEditors,
      applyDeviceHeaderColor, beadsTagHtml, clearMultiSelect, closeTabInGroup,
      cloudFetch, cloudSaveLayout, collapsePane, createTabInGroup, deletePane,
      expandPane, focusPane, focusTerminalInput, hideIframeOverlays,
      reattachTerminal, refreshBeadsTagStatus, refreshTabBars,
      showIframeOverlays, showShortcutAssignPopup, syncTabGroupGeometry,
      togglePaneSelection, updateBroadcastIndicator,
      getCanvas: () => canvas,
      getFocusMode: () => focusMode,
      getExpandedPaneId: () => expandedPaneId,
      getQuickViewActive: () => quickViewActive,
      getDeviceHoverActive: () => deviceHoverActive,
      getMoveModeActive: () => moveModeActive,
      getIsPanning: () => isPanning,
    });
    initHudDeps({
      state, terminals, selectedPaneIds,
      agentUpdates, beadsPanes, claudeTerminalIds, fileEditors,
      folderPanes, gitGraphPanes, noteEditors, termDeferredBuffers,
      get agents() { return agents; },
      addQuickViewOverlay, applyDeviceHeaderColor, cloudFetch, getDeviceColor,
      getActiveAgentId: () => activeAgentId,
      getQuickViewActive: () => quickViewActive,
      getDeviceHoverActive: () => deviceHoverActive,
      setDeviceHoverActive: (v) => { deviceHoverActive = v; },
      getCurrentTerminalTheme: () => currentTerminalTheme,
      setCurrentTerminalTheme: (v) => { currentTerminalTheme = v; },
    });
    initEditorsDeps({
      state, terminals, fileEditors, noteEditors, selectedPaneIds, fileHandles,
      attachTerminal, cloudSaveLayout, cloudSaveNote, enterMentionMode,
      getPaneAgentId, renderMarkdownPreview, setZoom, showUpgradePrompt,
      getCanvas: () => canvas,
      getCurrentTerminalTheme: () => currentTerminalTheme,
      getExpandedPaneId: () => expandedPaneId,
      getIsDragging: () => dragState.isDragging,
      getIsResizing: () => dragState.isResizing,
      getTabHeld: () => tabHeld,
      getTerminalMouseDown: () => terminalMouseDown,
      setTerminalMouseDown: (v) => { terminalMouseDown = v; },
    });
    initProjectsDeps({
      // state.projects is reassigned here, but state itself never is.
      state,
      cloudFetch, cloudSaveLayout, deletePane, getAllPrefs,
      getNextShortcutNumber, reassignShortcutNumber, showShortcutAssignPopup,
      saveViewState, updateCanvasTransform,
      getCanvas: () => canvas,
      getTeleportAnimation: () => teleportAnimation,
      getProjectsSidebarPosition: () => projectsSidebarPosition,
      getProjectsSidebarVisible: () => projectsSidebarVisible,
      setProjectsSidebarVisible: (v) => { projectsSidebarVisible = v; },
    });
    initMenusDeps({
      // state and these collections are mutated in place, never reassigned,
      // so they can be handed over directly rather than through getters.
      state,
      selectedPaneIds, terminals, fileEditors, noteEditors,
      // Pane creation, entered from the add-pane menu
      createNotePane, createIframePane, createIframePaneWithUrl,
      createCheckpointPane, startProjectCreation, enterPlacementMode,
      showDevicePickerThenPlace, openFileWithDevicePickerThenPlace,
      showGitRepoPickerWithDeviceThenPlace, showBeadsRepoPickerWithDeviceThenPlace,
      showFolderPaneDevicePickerThenPlace, showConversationsDirPickerThenPlace,
      showRecentsOrBrowse,
      // Canvas and pane operations
      setZoom, updateCanvasTransform, saveViewState, cloudSaveLayout,
      jumpToPane, expandPane, exitMentionMode, showUpgradePrompt,
      // Canvas event handlers, attached by setupCanvasInteraction
      handleCanvasPanStart, handleTouchStart, handleWheel,
      handleMiddleMousePan, handleRightMousePan,
      // Read-only state. canvasContainer is assigned below this call, so it
      // has to be reached lazily rather than captured now.
      getCanvasContainer: () => canvasContainer,
      getTabHeld: () => tabHeld,
      getMentionModeActive: () => mentionModeActive,
      getLastFocusedPaneId: () => lastFocusedPaneId,
      getActiveAgentId: () => activeAgentId,
      getTutorialsCompleted: () => tutorialsCompleted,
    });

    // Deferred from the preferences load above, which runs before the
    // projects module has its context.
    if (loadedPrefs) loadProjectsFromPrefs(loadedPrefs);

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
    if (getHudHidden()) {
      hudContainer.style.display = 'none';
      const dot = document.getElementById('hud-restore-dot');
      if (dot) dot.style.display = 'block';
      applyNoHudMode(true);
    }
    pollHud();
    restartHudPolling();
    // Re-render every 5s to keep pane counts fresh (1s caused Firefox freeze from DOM thrashing)
    startHudRenderTimer();

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
  // SECTION 9: PREFERENCES & SETTINGS MODAL
  // Extracted to modules/settings.js — see initSettingsDeps() wiring below.
  // ============================================================================

  // ============================================================================
  // SECTION 10: WS HELPERS & AGENT MANAGEMENT                    [Lines ~2835-3210]
  // sendWs(), relay notifications, agent update toasts, add-machine dialog,
  // agent overlay, device helpers
  // ============================================================================

  // Send WebSocket message (agentId defaults to activeAgentId for backward compat)
  // sendWs — moved to modules/ws-transport.js

  // Agent toasts, the Add Machine dialog and the add-machine pulse live in
  // modules/agent-ui.js — see initAgentUiDeps() wiring below.

  // Update agents HUD with relay agent list
  function updateAgentsHud() {
    // Re-render the Machines HUD with agent data mapped to device format
    getHudData().devices = agents.map(a => ({
      name: a.displayName || a.hostname || a.agentId,
      hostname: a.hostname,
      ip: a.agentId,
      os: a.os || 'linux',
      online: a.online !== false,
      isLocal: agents.length === 1
    }));
    if (getHudHidden()) updateHudDotColor();
    renderHud();

    // Start usage polling when any agent is available. The timers and their
    // restart guard live in modules/hud.js.
    if (agents.some(a => a.online)) {
      // Only fetch on the transition to online, as before — the module's
      // start is idempotent, so it reports whether it actually started.
      if (startAgentsUsagePolling()) fetchAgentsUsage();
    } else {
      stopAgentsUsagePolling();
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

  // pendingRequests, pendingScanCallbacks and agentRequest — moved to
  // modules/ws-transport.js

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
    const overrides = getDeviceColorOverrides();
    if (overrides[deviceName] != null) {
      return DEVICE_COLORS[overrides[deviceName] % DEVICE_COLORS.length];
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
  // ============================================================================
  // SECTION 14: PANE-SPECIFIC RENDERERS  -> modules/pane-renderers.js
  // ============================================================================

  // ============================================================================
  // SECTION 15: EDITOR & INPUT SETUP  -> modules/editors.js
  // ============================================================================

  // ============================================================================
  // SECTION 16: PANE INTERACTION & LAYOUT  -> modules/pane-interaction.js
  // ============================================================================
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
            dragState.isDragging = true;
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
            dragState.isDragging = false;
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
        setHoveredDeviceName(null);
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
    if (deviceHoverActive) { setHoveredDeviceName(null); clearDeviceHighlight(); }
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
  // ============================================================================
  // SECTION 19b: PROJECTS & CHECKPOINTS  -> modules/projects.js
  // ============================================================================

  // ============================================================================
  // SECTION 20: UI MENUS & TOOLBAR  -> modules/menus.js
  // ============================================================================

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
  // SECTION 22: KEYBOARD SHORTCUTS
  // Extracted to modules/shortcuts.js — see initShortcutsDeps() wiring below.
  // ============================================================================

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
