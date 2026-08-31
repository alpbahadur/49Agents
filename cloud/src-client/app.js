import { Terminal } from './lib/xterm.mjs';
import { FitAddon } from './lib/addon-fit.mjs';
import { WebLinksAddon } from './lib/addon-web-links.mjs';
import { playDismissSound, playNotificationSound, setSoundEnabled as _setSoundEnabled } from './modules/sounds.js';
import { escapeHtml, formatBytes, metricColorClass, formatLocationPath, isExternalInputFocused, truncateUrl, isAgentVersionOutdated, getTerminalFontFamily, PANE_HEADER_CONTROLS, normalizePaneHeaderOrder } from './modules/utils.js';
import { APP_VERSION, PANE_DEFAULTS, PANE_ENDPOINT_MAP, ICON_BEADS, ICON_GIT_GRAPH, ICON_FOLDER, ICON_CONVERSATIONS, CLAUDE_STATE_SVGS, CLAUDE_LOGO_SVG, RESET_ICON_SVG, WIFI_OFF_SVG, DEVICE_COLORS, TERMINAL_FONTS, CANVAS_BACKGROUNDS, osIcon } from './modules/constants.js';
import { initMinimap, startMinimapLoop, hideMinimap, renderMinimap, getCanvasBounds, calcPlacementPos, setMinimapEnabled, getMinimapEnabled } from './modules/minimap.js';
import { initNotificationDeps, initNotifications, showPromoToasts, showToast, dismissToast, snoozeNotification, sendBrowserNotification, updateTabTitleBadge, handleStateTransition, previousClaudeStates, notifiedStates, activeToasts, snoozedNotifications, snoozeCount, getIsFirstClaudeStateUpdate, setIsFirstClaudeStateUpdate, getNotificationContainer, showAdminToast, dismissAdminToast } from './modules/notifications.js';
import { initGitGraphDeps, renderGitGraphPane, fetchGitGraphData } from './modules/git-graph.js';
import { initSettingsDeps, showSettingsModal, savePrefsToCloud, getAllPrefs, setCanvasBackground, setAppTheme, getCurrentTerminalFont, setCurrentTerminalFont } from './modules/settings.js';
import { initShortcutsDeps, setupKeyboardShortcuts } from './modules/shortcuts.js';
import { initWsTransportDeps, sendWs, agentRequest, pendingRequests, pendingScanCallbacks } from './modules/ws-transport.js';
import { initAgentUiDeps, showRelayNotification, showUpdateToast, showUpdateProgressToast, showUpdateCompleteToast, updateAgentOverlay, showAddMachineDialog } from './modules/agent-ui.js';
import { initMenusDeps, setupAddPaneMenu, setupTutorialMenu, autoArrangePanes, setupMobileNavDrawer, setupToolbarButtons, setupCustomTooltips, setupCanvasInteraction, setupPasteHandlers, getTabCycleOrder, findPaneInDirection, calcMoveModeZoom } from './modules/menus.js';
import { initClaudeStatesDeps, updateClaudeStates } from './modules/claude-states.js';
import { initGuestDeps, initGuestNudge } from './modules/guest.js';
import { initCanvasEventsDeps, setupEventListeners, handleCanvasPanStart, handleMiddleMousePan, handleRightMousePan, handleTouchStart, handleWheel, setZoom, zoomToFit } from './modules/canvas-events.js';
import { initViewModeDeps, setupViewModeToggle, applyViewMode, toggleViewMode, refreshPaneListIfVisible, setViewMode as setViewModeModule } from './modules/view-mode.js';
import { initMoveModeDeps, enterMoveMode, exitMoveMode, applyMoveModeVisuals, moveModeNavigate } from './modules/move-mode.js';
import { initQuickViewDeps, addQuickViewOverlay, removeQuickViewOverlay, toggleQuickView, enterMentionMode, exitMentionMode } from './modules/quick-view.js';
import { initTerminalLifecycleDeps, attachTerminal, reattachTerminal, renderPane, renderFilePane, getDeviceColor, claudeSessionBadgeHtml, beadsTagHtml, refreshBeadsTagStatus, deviceLabelHtml, applyDeviceHeaderColor } from './modules/terminal-lifecycle.js';
import { initTabGroupsDeps, getTabGroupPanes, getActiveTabPane, switchTab, syncTabGroupGeometry, createTabInGroup, refreshTabBars, renderTabBar, closeTabInGroup } from './modules/tab-groups.js';
import { initConnectionDeps, updateConnectionStatus, findOnlineAgentForDevice, setDisconnectOverlay, renderOfflinePlaceholder } from './modules/connection.js';
import { initCloudDeps, cloudFetch, cloudSaveLayout, saveRecentContext, fetchRecentContexts, showRecentsOrBrowse, cloudDeleteLayout, cloudSaveViewState, cloudSaveNote } from './modules/cloud.js';
import { initPlacementDeps, isPlacementActive, enterPlacementMode, cancelPlacementMode, showDevicePickerThenPlace, openFileWithDevicePickerThenPlace, showGitRepoPickerWithDeviceThenPlace, renderConversationsPane, showConversationsDirPickerThenPlace, showFolderPaneDevicePickerThenPlace, showBeadsRepoPickerWithDeviceThenPlace } from './modules/placement.js';
import { initPaneCreationDeps, createPane, deletePane, createNotePane, createIframePane, createIframePaneWithUrl, createGitGraphPane, createFilePaneFromRemote, createCustomSelect, loadPanesFromAgent, loadTerminalsFromServer, openFileWithDevicePicker, resumeTerminalPane, showDevicePicker, showDevicePickerGeneric, showFileBrowser, showFolderScanPicker, showGitRepoPicker, showGitRepoPickerWithDevice, createBrowserOverlay, attachPickerKeyboardNav } from './modules/pane-creation.js';
import { initRenderersDeps, expandPane, collapsePane, renderNotePane, initNoteMonaco, refreshNoteImages, renderMarkdownPreview, renderIframePane, setupIframeListeners, showIframeOverlays, hideIframeOverlays, createFolderPane, createBeadsPane, renderBeadsPane, renderFolderPane, setupBeadsListeners, fetchBeadsData, applyBeadsFilters } from './modules/pane-renderers.js';
import { initPaneInteractionDeps, applyPaneZoom, setupPaneListeners, findSnapTargets, findResizeSnapTargets, updateSnapGuide, showSnapGuides, removeSnapGuides, startDrag, startResizeHold, activateResize } from './modules/pane-interaction.js';
import { initHudDeps, createHudContainer, toggleHudHidden, applyPaneVisibility, checkAutoHideHud, applyNoHudMode, createHud, pollHud, restartHudPolling, renderHud, clearDeviceHighlight, createAgentsHud, createChatHud, fetchAgentsUsage, renderAgentsHud, applyTerminalTheme, updateHudDotColor, getHudExpanded, setHudExpanded, getAgentsHudExpanded, setAgentsHudExpanded, getFeedbackHudExpanded, setFeedbackHudExpanded, getHudHidden, setHudHidden, getFleetPaneHidden, setFleetPaneHidden, getAgentsPaneHidden, setAgentsPaneHidden, getDeviceColorOverrides, setDeviceColorOverrides, getHudData, setHoveredDeviceName, startHudRenderTimer, startAgentsUsagePolling, stopAgentsUsagePolling } from './modules/hud.js';
import { initEditorsDeps, setupImageButtonHandlers, setupTextOnlyToggle, setupFileEditorListeners, initTerminal } from './modules/editors.js';
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
  // placementMode -> modules/placement.js

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
  let starterTerminalCreated = false;
  let projectsSidebarVisible = false; // Tab+P toggles projects sidebar
  let projectsSidebarPosition = 'right'; // 'left' or 'right'
  let teleportAnimation = true; // false = instant teleport

  // Optional pane-header affordances. These drive body-level classes rather
  // than the pane templates, so flipping one in settings applies to panes
  // that are already on the canvas instead of waiting for a re-render.
  // Beads is off by default — it means nothing to someone who does not use
  // beads, and an unexplained icon in every header is the kind of clutter a
  // new user reads as complexity.
  let beadsButtonEnabled = false;
  let paneNamingEnabled = true;
  let paneNumberHotkeysEnabled = false;
  let newTabButtonEnabled = false;

  // View mode: 'canvas' or 'list'. Canvas everywhere by default. The
  // on-screen toggle is hidden by default everywhere; Tab+X and Settings
  // are the way in. A stored preference overrides that in either direction.
  let viewMode = 'canvas';
  let viewModeHotkeyEnabled = true;
  let viewModeToggleVisible = false;

  // PANE_HEADER_CONTROLS and normalizePaneHeaderOrder live in modules/utils.js
  // so the reconciliation logic can be tested on its own.
  const PANE_CONTROL_SELECTORS = {
    shortcut: '.pane-shortcut-badge',
    beads: '.beads-tag-btn',
    reload: '.term-refresh-history',
    zoom: '.pane-zoom-controls',
    newtab: '.pane-new-tab',
  };
  let paneHeaderOrder = [...PANE_HEADER_CONTROLS];

  /**
   * Ordering rides on the flex `order` property via a stylesheet rather than
   * per-element styles, so it applies to panes built later without any
   * re-render. Expand and close sit after the pool at a fixed order.
   */
  function applyPaneHeaderOrder() {
    let styleEl = document.getElementById('pane-header-order-style');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'pane-header-order-style';
      document.head.appendChild(styleEl);
    }
    const rules = paneHeaderOrder.map((key, i) =>
      `.pane-header-right ${PANE_CONTROL_SELECTORS[key]} { order: ${i + 1}; }`);
    rules.push('.pane-header-right .pane-expand { order: 90; }');
    rules.push('.pane-header-right .pane-close { order: 91; }');
    styleEl.textContent = rules.join('\n');
  }

  // Every route into a mode change — Settings, the corner button, Tab+X —
  // funnels through the module, which applies it and calls back to persist.
  function setViewModeFromUi(mode) {
    setViewModeModule(mode);
  }

  function applyPaneChromePrefs() {
    document.body.classList.toggle('hide-beads-btn', !beadsButtonEnabled);
    document.body.classList.toggle('hide-pane-naming', !paneNamingEnabled);
    document.body.classList.toggle('hide-pane-shortcuts', !paneNumberHotkeysEnabled);
    document.body.classList.toggle('hide-pane-new-tab', !newTabButtonEnabled);
    document.body.classList.toggle('hide-view-mode-btn', !viewModeToggleVisible);
    applyPaneHeaderOrder();
  }

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

  // ---------------------------------------------------------------------------
  // Consent onboarding (local mode only)
  //
  // Appears after ten minutes of *active* use, not ten minutes of wall clock.
  // Someone who opens the app and walks away has not formed an opinion worth
  // asking for, so time only accrues while the tab is visible.
  //
  // The clock and the answer both live on the server. Keeping them in the
  // browser meant clearing site data or opening a private window silently
  // restarted the ten minutes, and the modal could be dodged forever. Once it
  // is up it stays up, across reloads, until Continue is pressed: the server
  // keeps reporting the question as unanswered and every load re-opens it.
  // ---------------------------------------------------------------------------
  /**
   * One-time tip shown when a user first lands on the canvas with the tutorial
   * behind them — completed or skipped, since both routes leave them here
   * without ever meeting these two hotkeys.
   *
   * It sits centre-bottom rather than in the toast corner, where notification
   * toasts have trained people to ignore things, and it clears itself when
   * either hotkey is actually pressed, so the card doubles as the exercise.
   */
  const _hotkeyTip = {
    KEY: 'tc_hotkey_tip',
    _el: null,
    _onKey: null,

    show() {
      try { if (localStorage.getItem(this.KEY)) return; } catch (e) { return; }
      if (this._el) return;

      const card = document.createElement('div');
      card.id = 'hotkey-tip';
      card.innerHTML = `
        <div class="hotkey-tip-title">Two shortcuts worth knowing</div>
        <div class="hotkey-tip-row"><kbd>Tab</kbd><span>+</span><kbd>H</kbd><span class="hotkey-tip-desc">hide or show the HUD</span></div>
        <div class="hotkey-tip-row"><kbd>Tab</kbd><span>+</span><kbd>M</kbd><span class="hotkey-tip-desc">hide or show the minimap</span></div>
        <div class="hotkey-tip-hint">Try one now — this closes once you do.</div>
        <button class="hotkey-tip-dismiss" type="button">Got it</button>`;
      document.body.appendChild(card);
      this._el = card;

      card.querySelector('.hotkey-tip-dismiss').addEventListener('click', () => this.dismiss());

      // Listening for the keys themselves, rather than hooking the HUD and
      // minimap toggles, keeps this independent of how those are wired.
      this._onKey = (e) => {
        const k = (e.key || '').toLowerCase();
        if ((k === 'h' || k === 'm') && tabHeld) this.dismiss();
      };
      document.addEventListener('keydown', this._onKey, true);

      requestAnimationFrame(() => card.classList.add('visible'));
    },

    dismiss() {
      if (!this._el) return;
      try { localStorage.setItem(this.KEY, 'seen'); } catch (e) {}
      if (this._onKey) document.removeEventListener('keydown', this._onKey, true);
      this._onKey = null;
      const el = this._el;
      this._el = null;
      el.classList.remove('visible');
      setTimeout(() => el.remove(), 250);
    },
  };

  // Mandatory (consent-exempt) telemetry: `visit` and `telemetry_rejected`.
  // See CONSENT_EXEMPT_EVENTS in cloud/src/telemetry/ingest.js — these two
  // event types carry no user content and are recorded regardless of whether
  // the visitor has answered (or ever answers) the onboarding consent step,
  // so we can tell how many people tried the app apart from how many opted
  // into full telemetry.
  const _mandatoryTelemetry = {
    _instanceIdKey: 'tc_mandatory_instance_id',
    _visitKey: 'tc_last_visit_date',

    _instanceId() {
      try {
        let id = localStorage.getItem(this._instanceIdKey);
        if (!id) {
          id = null; // let the server mint one on first contact
        }
        return id;
      } catch {
        return null;
      }
    },

    _detectOs() {
      const ua = navigator.userAgent || '';
      const platform = navigator.platform || '';
      if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'windows';
      if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return 'macos';
      if (/Linux/i.test(platform) || /Linux/i.test(ua)) return 'linux';
      return 'other';
    },

    async _send(eventType) {
      try {
        const res = await fetch('/api/telemetry/mandatory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventType,
            instanceId: this._instanceId(),
            os: this._detectOs(),
          }),
        });
        const data = await res.json().catch(() => null);
        if (data?.instanceId) {
          try { localStorage.setItem(this._instanceIdKey, data.instanceId); } catch {}
        }
      } catch {
        // Best-effort; a dropped mandatory event just undercounts by one.
      }
    },

    // Once per calendar day per browser, so a page left open and reloaded
    // repeatedly doesn't inflate the count.
    recordVisit() {
      try {
        const today = new Date().toISOString().slice(0, 10);
        if (localStorage.getItem(this._visitKey) === today) return;
        localStorage.setItem(this._visitKey, today);
      } catch {
        // Storage unavailable — fall through and send anyway rather than
        // silently never counting this visitor.
      }
      this._send('visit');
    },

    recordRejected() {
      this._send('telemetry_rejected');
    },
  };

  const _onboarding = {
    _timer: null,
    _lastTick: null,
    _shown: false,
    _guard: null,

    init() {
      // Nothing is asked until the tutorial is behind them. A first-time user is
      // about to be redirected to /tutorial, and the ten minutes should measure
      // real use of the app rather than time spent being shown around it.
      if (!this._tutorialDone()) return;

      // One request, so the modal can be up on the first paint rather than
      // flashing in a couple of seconds later.
      fetch('/api/auth/onboarding', { credentials: 'include' })
        .then(r => r.json())
        .then(state => {
          if (!state || !state.applicable) return;
          if (state.due) {
            this.show(state.step || 1);
          } else {
            this._startTracking();
          }
        })
        .catch(() => {});
    },

    _startTracking() {
      this._lastTick = Date.now();
      this._timer = setInterval(() => this._tick(), 15000);

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this._tick();
          this._lastTick = null;
        } else {
          this._lastTick = Date.now();
        }
      });
    },

    _tick() {
      if (this._shown) return;
      if (document.visibilityState !== 'visible' || this._lastTick === null) return;

      const now = Date.now();
      const delta = now - this._lastTick;
      this._lastTick = now;

      fetch('/api/auth/onboarding/tick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ deltaMs: delta }),
      })
        .then(r => r.json())
        .then(state => {
          if (state && state.due) this.show();
        })
        .catch(() => {});
    },

    show(resumeStep = 1) {
      if (this._shown) return;
      const el = document.getElementById('onboarding');
      if (!el) return;

      this._shown = true;
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }

      el.classList.add('visible');
      this._startEyeTracking();
      this._startGuard(el);

      const submit = document.getElementById('onboarding-submit');
      const emailInput = document.getElementById('onboarding-email');
      const marketing = document.getElementById('onboarding-marketing');
      const marketingRow = marketing?.closest('.consent-row');

      // Marketing consent needs an address to attach to, so the box is inert
      // until one is typed.
      //
      // It ships ticked outside the EU/UK, where CAN-SPAM allows opt-out
      // marketing, and unticked inside it, where a pre-ticked box is not valid
      // consent at all (Planet49, C-673/17). The check reads the browser's own
      // timezone and locale: a VPN defeats it, but a good-faith geographic check
      // is what the regulation asks for.
      const defaultMarketingOn = !this._looksEuropean();
      marketing.checked = defaultMarketingOn;

      let userClearedMarketing = !defaultMarketingOn;
      marketing?.addEventListener('change', () => {
        userClearedMarketing = !marketing.checked;
      });

      // The tick stays visible even before an address is typed, so the default
      // is something the user can see and undo rather than a surprise. Consent
      // is still only recorded when an address is actually supplied.
      const syncMarketing = () => {
        const hasEmail = emailInput.value.trim().length > 0;
        marketing.disabled = !hasEmail;
        marketingRow?.classList.toggle('inactive', !hasEmail);
        marketing.checked = !userClearedMarketing;
      };
      syncMarketing();
      emailInput?.addEventListener('input', syncMarketing);

      // Continue walks the two steps before it submits: telemetry first, then
      // email. Asking for both on one screen made the modal a wall of text.
      submit?.addEventListener('click', () => {
        if (this._step === 1) {
          this._goToStep(2);
          return;
        }
        this._submit();
      });

      document.getElementById('onboarding-back')?.addEventListener('click', () => {
        this._goToStep(1);
      });

      emailInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._submit();
        }
      });

      // Resume where they were. Done last so the listeners above are wired
      // before the step is applied.
      if (resumeStep === 2) this._goToStep(2);
    },

    _step: 1,

    /**
     * Whether the getting-started tutorial is behind them.
     *
     * Mirrors the check init() uses to decide on redirecting to /tutorial:
     * either source counts, since a returning user on a new device has the
     * server preference but no local flag yet.
     */
    _tutorialDone() {
      try {
        if (localStorage.getItem('tc_tutorial')) return true;
      } catch {
        // Storage unavailable; fall through to the server preference.
      }
      return !!(tutorialsCompleted && tutorialsCompleted['getting-started']);
    },

    // EU/UK members plus EEA, which GDPR also covers. Kept as an explicit list
    // because Europe/* alone would sweep in non-EEA countries.
    EU_TIMEZONE_COUNTRIES: [
      'Vienna', 'Brussels', 'Sofia', 'Zagreb', 'Nicosia', 'Prague', 'Copenhagen',
      'Tallinn', 'Helsinki', 'Paris', 'Berlin', 'Busingen', 'Athens', 'Budapest',
      'Dublin', 'Rome', 'Riga', 'Vilnius', 'Luxembourg', 'Malta', 'Amsterdam',
      'Warsaw', 'Lisbon', 'Madrid', 'Bucharest', 'Bratislava', 'Ljubljana',
      'Stockholm', 'London', 'Belfast', 'Edinburgh', 'Guernsey', 'Isle_of_Man',
      'Jersey', 'Gibraltar', 'Oslo', 'Reykjavik', 'Vaduz', 'Azores', 'Madeira',
      'Canary', 'Ceuta',
    ],

    EU_LOCALES: [
      'en-GB', 'en-IE', 'de', 'fr', 'it', 'es', 'nl', 'pt-PT', 'pl', 'sv', 'da',
      'fi', 'el', 'cs', 'sk', 'hu', 'ro', 'bg', 'hr', 'sl', 'et', 'lv', 'lt',
      'mt', 'ga', 'is', 'no', 'nb', 'nn',
    ],

    /**
     * Best-effort check for an EU/UK/EEA visitor, used only to decide whether
     * the marketing box may ship pre-ticked. Errs toward treating someone as
     * European, since a wrongly-unticked box costs an opt-in while a wrongly
     * pre-ticked one is an unlawful basis for every send that follows.
     */
    _looksEuropean() {
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
        if (tz.startsWith('Europe/')) {
          const city = tz.split('/')[1];
          // Europe/* covers non-EEA countries too (Moscow, Kyiv, Istanbul),
          // so match the city rather than the region.
          if (this.EU_TIMEZONE_COUNTRIES.includes(city)) return true;
        }
        if (this.EU_TIMEZONE_COUNTRIES.some(c => tz.endsWith('/' + c))) return true;

        const langs = navigator.languages || [navigator.language || ''];
        return langs.some(l => this.EU_LOCALES.some(
          eu => l === eu || l.toLowerCase().startsWith(eu.toLowerCase() + '-')
        ));
      } catch {
        // Anything unexpected: assume European and do not pre-tick.
        return true;
      }
    },

    _goToStep(step) {
      this._step = step;

      // Remember it, so a reload resumes here instead of restarting.
      fetch('/api/auth/onboarding/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ step }),
      }).catch(() => {});

      document.querySelectorAll('#onboarding .onboarding-step').forEach(el => {
        el.hidden = Number(el.dataset.step) !== step;
      });
      document.querySelectorAll('#onboarding .step-dot').forEach(dot => {
        dot.classList.toggle('active', Number(dot.dataset.dot) === step);
      });

      // Nothing to go back to from the first screen.
      const back = document.getElementById('onboarding-back');
      if (back) back.hidden = step === 1;

      if (step === 2) {
        document.getElementById('onboarding-email')?.focus();
      }
    },

    // Continue is the only way out, so put the modal back if anything else
    // removes or hides it.
    _startGuard(el) {
      const parent = el.parentNode;

      this._guard = new MutationObserver(() => {
        if (this._shown === false) return;

        if (!el.isConnected) {
          parent.appendChild(el);
        }
        if (!el.classList.contains('visible')) {
          el.classList.add('visible');
        }
        const style = el.getAttribute('style');
        if (style && /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0/.test(style)) {
          el.removeAttribute('style');
        }
      });

      this._guard.observe(parent, { childList: true });
      this._guard.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
    },

    async _submit() {
      const submit = document.getElementById('onboarding-submit');
      const emailInput = document.getElementById('onboarding-email');
      const consentInput = document.getElementById('onboarding-consent');
      const marketingInput = document.getElementById('onboarding-marketing');
      const errorEl = document.getElementById('onboarding-error');
      const email = emailInput.value.trim();

      errorEl.style.display = 'none';
      submit.disabled = true;
      submit.textContent = email ? 'Checking...' : 'Saving...';

      try {
        const res = await fetch('/auth/email-signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            email: email || null,
            telemetryConsent: consentInput.checked,
            // Only meaningful with an address, and the box cannot be ticked
            // without one.
            marketingConsent: !!(email && marketingInput?.checked),
          }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.ok) {
          // Answered, so the guard stands down and the modal closes for good.
          this._shown = false;
          this._guard?.disconnect();
          this._guard = null;
          document.getElementById('onboarding').classList.remove('visible');
          // Consent may have just been granted, so start the client tracker
          // rather than waiting for the next page load.
          if (consentInput.checked && !_telemetry._active) _telemetry.init();
          else if (!consentInput.checked) _mandatoryTelemetry.recordRejected();
        } else {
          errorEl.textContent = data.error || 'Something went wrong. Try again.';
          errorEl.style.display = 'block';
          submit.disabled = false;
          submit.textContent = 'Continue';
        }
      } catch {
        errorEl.textContent = 'Network error. Try again.';
        errorEl.style.display = 'block';
        submit.disabled = false;
        submit.textContent = 'Continue';
      }
    },

    _startEyeTracking() {
      const pupils = Array.from(document.querySelectorAll('#onboarding [data-pupil]'));
      if (!pupils.length) return;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

      const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      let queued = false;

      const render = () => {
        queued = false;
        pupils.forEach(pupil => {
          const box = pupil.parentElement.getBoundingClientRect();
          if (!box.width) return;
          const dx = pointer.x - (box.left + box.width / 2);
          const dy = pointer.y - (box.top + box.height / 2);
          const dist = Math.sqrt(dx * dx + dy * dy);
          // Cap travel so the pupil never escapes the white of the eye.
          const limit = box.width * 0.22;
          const scale = dist > limit ? limit / dist : 1;
          pupil.style.transform =
            `translate(calc(-50% + ${(dx * scale).toFixed(2)}px), calc(-50% + ${(dy * scale).toFixed(2)}px))`;
        });
      };

      window.addEventListener('pointermove', (e) => {
        pointer.x = e.clientX;
        pointer.y = e.clientY;
        if (!queued) {
          queued = true;
          requestAnimationFrame(render);
        }
      }, { passive: true });

      render();
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

  // cloudFetch, layout/view/note sync, recent contexts -> modules/cloud.js
  let canvas, canvasContainer;
  let isPanning = false;
  // Canvas pan/pinch gesture state. Grouped so the canvas event handlers can
  // take it by reference, the same way dragState works for panes.
  const panState = {
    startX: 0, startY: 0,
    lastX: 0, lastY: 0,
    momentumRaf: null,
    scrollLockTarget: null, // 'pane' | 'canvas' | null
  };

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

  // Pinch zoom state lives in panState above.

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

  // SECTION 7: APP BOOTSTRAP & CLAUDE STATE TRACKING              [Lines ~1491-1942]
  // init() bootstrap, Claude state badges, updateClaudeStates() notification
  // integration
  // ============================================================================

  async function init() {

    // Resolve local vs cloud before anything reads it. The telemetry bootstrap
    // also sets window.__tcAuthMode, but it runs behind the tutorial gate and
    // may never fire, and updateAgentOverlay() needs the answer on first paint
    // to decide whether "no agent yet" is worth nagging about.
    try {
      const modeRes = await fetch('/api/auth/mode');
      if (modeRes.ok) window.__tcAuthMode = (await modeRes.json()).mode;
    } catch (e) {
      // Unreachable: leave it unset, which reads as cloud — the conservative
      // default, since that is the mode where pairing is genuinely required.
    }

    _mandatoryTelemetry.recordVisit();

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

    // Load cloud preferences (theme, sound)
    let loadedPrefs = null;
    try {
      const prefs = await cloudFetch('GET', '/api/preferences');
      setAppTheme(prefs.appTheme || 'system');
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
      if (prefs.starterTerminalCreated) starterTerminalCreated = true;
      if (prefs.tutorialsCompleted) {
        tutorialsCompleted = prefs.tutorialsCompleted;
      }
      if (prefs.projectsSidebarPosition) {
        projectsSidebarPosition = prefs.projectsSidebarPosition;
      }
      if (prefs.teleportAnimation !== undefined) {
        teleportAnimation = prefs.teleportAnimation;
      }
      if (prefs.beadsButtonEnabled !== undefined) {
        beadsButtonEnabled = prefs.beadsButtonEnabled;
      }
      if (prefs.paneNamingEnabled !== undefined) {
        paneNamingEnabled = prefs.paneNamingEnabled;
      }
      if (prefs.paneNumberHotkeysEnabled !== undefined) {
        paneNumberHotkeysEnabled = prefs.paneNumberHotkeysEnabled;
      }
      if (prefs.newTabButtonEnabled !== undefined) {
        newTabButtonEnabled = prefs.newTabButtonEnabled;
      }
      if (prefs.viewMode !== undefined) {
        viewMode = prefs.viewMode === 'list' ? 'list' : 'canvas';
      }
      if (prefs.viewModeHotkeyEnabled !== undefined) {
        viewModeHotkeyEnabled = prefs.viewModeHotkeyEnabled;
      }
      if (prefs.viewModeToggleVisible !== undefined) {
        viewModeToggleVisible = prefs.viewModeToggleVisible;
      }
      if (prefs.paneHeaderOrder) {
        paneHeaderOrder = normalizePaneHeaderOrder(prefs.paneHeaderOrder);
      }
      applyPaneChromePrefs();
      // Projects are applied after the module wiring below, since
      // loadProjectsFromPrefs lives in modules/projects.js and its context
      // is not initialised yet at this point.
      loadedPrefs = prefs;
    } catch (e) {
      console.error('[App] Preferences load failed:', e.message);
      // Fall back to the defaults rather than leaving the chrome unstyled.
      applyPaneChromePrefs();
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
      getBeadsButtonEnabled: () => beadsButtonEnabled,
      setBeadsButtonEnabled: (v) => { beadsButtonEnabled = v; applyPaneChromePrefs(); },
      getPaneNamingEnabled: () => paneNamingEnabled,
      setPaneNamingEnabled: (v) => { paneNamingEnabled = v; applyPaneChromePrefs(); },
      getPaneNumberHotkeysEnabled: () => paneNumberHotkeysEnabled,
      setPaneNumberHotkeysEnabled: (v) => { paneNumberHotkeysEnabled = v; applyPaneChromePrefs(); },
      // setViewMode is the module's, not a plain setter: switching mode has to
      // rebuild the list and collapse any expanded pane, and persist.
      getViewModePref: () => viewMode,
      setViewMode: (v) => setViewModeFromUi(v),
      getViewModeHotkeyEnabled: () => viewModeHotkeyEnabled,
      setViewModeHotkeyEnabled: (v) => { viewModeHotkeyEnabled = v; },
      getViewModeToggleVisible: () => viewModeToggleVisible,
      setViewModeToggleVisible: (v) => { viewModeToggleVisible = v; applyPaneChromePrefs(); },
      getNewTabButtonEnabled: () => newTabButtonEnabled,
      setNewTabButtonEnabled: (v) => { newTabButtonEnabled = v; applyPaneChromePrefs(); },
      getPaneHeaderOrder: () => [...paneHeaderOrder],
      getPaneHeaderControls: () => [...PANE_HEADER_CONTROLS],
      setPaneHeaderOrder: (v) => { paneHeaderOrder = normalizePaneHeaderOrder(v); applyPaneHeaderOrder(); },
      getHudExpanded, getAgentsHudExpanded, getHudHidden, getDeviceColorOverrides,
      getTutorialsCompleted: () => tutorialsCompleted,
      getStarterTerminalCreated: () => starterTerminalCreated,
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
      getPaneNumberHotkeysEnabled: () => paneNumberHotkeysEnabled,
      getViewModeHotkeyEnabled: () => viewModeHotkeyEnabled,
      toggleViewMode,
    });
    initAgentUiDeps({
      getWs: () => ws,
      getAgents: () => agents,
      getTutorialsCompleted: () => tutorialsCompleted,
      getStarterTerminalCreated: () => starterTerminalCreated,
    });
    initWsTransportDeps({
      getWs: () => ws,
      getActiveAgentId: () => activeAgentId,
      telemetry: _telemetry,
    });
    initClaudeStatesDeps({ state, terminals, claudeTerminalIds });
    initGuestDeps({ state });
    initCanvasEventsDeps({
      state, panState, selectedPaneIds, terminals,
      init, saveViewState, updateBroadcastIndicator, updateCanvasTransform,
      getCanvas: () => canvas,
      getCanvasContainer: () => canvasContainer,
      getIsPanning: () => isPanning,
      setIsPanning: (v) => { isPanning = v; },
      getExpandedPaneId: () => expandedPaneId,
      getLastFocusedPaneId: () => lastFocusedPaneId,
      getMoveModeActive: () => moveModeActive,
      getQuickViewActive: () => quickViewActive,
      getTabHeld: () => tabHeld,
    });
    initMoveModeDeps({
      state, terminals,
      getLastFocusedPaneId: () => lastFocusedPaneId,
      focusPane, focusTerminalInput, saveViewState, updateCanvasTransform,
      getCanvas: () => canvas,
      getExpandedPaneId: () => expandedPaneId,
      getMoveModeActive: () => moveModeActive,
      setMoveModeActive: (v) => { moveModeActive = v; },
      getMoveModeOriginalZoom: () => moveModeOriginalZoom,
      setMoveModeOriginalZoom: (v) => { moveModeOriginalZoom = v; },
      getMoveModePaneId: () => moveModePaneId,
      setMoveModePaneId: (v) => { moveModePaneId = v; },
    });
    initQuickViewDeps({
      state, selectedPaneIds, terminals, dragState,
      clearMultiSelect, exitMoveMode, focusPane, focusTerminalInput,
      getQuickViewInfo, togglePaneSelection, updateBroadcastIndicator,
      getCanvas: () => canvas,
      getDeviceHoverActive: () => deviceHoverActive,
      getQuickViewActive: () => quickViewActive,
      setQuickViewActive: (v) => { quickViewActive = v; },
      getMoveModeActive: () => moveModeActive,
      getMentionModeActive: () => mentionModeActive,
      setMentionModeActive: (v) => { mentionModeActive = v; },
      getMentionStage: () => mentionStage,
      setMentionStage: (v) => { mentionStage = v; },
      getMentionPayload: () => mentionPayload,
      setMentionPayload: (v) => { mentionPayload = v; },
    });
    initTerminalLifecycleDeps({
      state, terminals, fileEditors, pendingAttachments,
      getWs: () => ws,
      cloudFetch, cloudSaveLayout, getNextShortcutNumber, paneNameHtml,
      shortcutBadgeHtml,
      getCanvas: () => canvas,
    });
    initTabGroupsDeps({
      state, terminals,
      telemetry: _telemetry,
      cloudSaveLayout, focusPane, focusTerminalInput, renderPane,
      getActiveAgentId: () => activeAgentId,
      getNextTabGroupId: () => nextTabGroupId,
      setNextTabGroupId: (v) => { nextTabGroupId = v; },
    });
    initConnectionDeps({
      get agents() { return agents; },
      beadsTagHtml, deviceLabelHtml, getNextShortcutNumber, paneNameHtml,
      shortcutBadgeHtml,
      getCanvas: () => canvas,
    });
    initCloudDeps({
      state,
      get agents() { return agents; },
      getCanvas: () => canvas,
      getActiveAgentId: () => activeAgentId,
    });
    initPlacementDeps({
      state,
      telemetry: _telemetry,
      cloudSaveLayout, deviceLabelHtml, exitMoveMode, getNextShortcutNumber,
      paneNameHtml, renderPane, saveRecentContext, shortcutBadgeHtml,
      showRecentsOrBrowse,
      getCanvas: () => canvas,
      getCanvasContainer: () => canvasContainer,
      getMoveModeActive: () => moveModeActive,
      getActiveAgentId: () => activeAgentId,
    });
    initPaneCreationDeps({
      state, terminals, selectedPaneIds, fileEditors, noteEditors, beadsPanes,
      folderPanes, gitGraphPanes, fileHandles, termDeferredBuffers,
      claudeTerminalIds,
      telemetry: _telemetry,
      get agents() { return agents; },
      attachTerminal, cloudDeleteLayout, cloudFetch, cloudSaveLayout, cloudSaveNote,
      deviceLabelHtml, enterPlacementMode, findOnlineAgentForDevice, focusPane,
      getDevicesFromAgents, getPaneAgentId, refreshBeadsTagStatus, refreshTabBars,
      renderConversationsPane, renderFilePane, renderOfflinePlaceholder,
      renderPane, saveRecentContext,
      setDisconnectOverlay, updateBroadcastIndicator, updateCanvasTransform,
      updateClaudeStates, updateConnectionStatus,
      getCanvas: () => canvas,
      getExpandedPaneId: () => expandedPaneId,
      getActiveAgentId: () => activeAgentId,
      getLastReceivedClaudeStates: () => lastReceivedClaudeStates,
      getNextTabGroupId: () => nextTabGroupId,
      setNextTabGroupId: (v) => { nextTabGroupId = v; },
      getLastFocusedPaneId: () => lastFocusedPaneId,
      setLastFocusedPaneId: (v) => { lastFocusedPaneId = v; },
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
      setZoom, zoomToFit, updateCanvasTransform, saveViewState, cloudSaveLayout,
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
      getStarterTerminalCreated: () => starterTerminalCreated,
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
    initViewModeDeps({
      state,
      getViewMode: () => viewMode,
      setViewModePref: (v) => { viewMode = v; savePrefsToCloud({ viewMode: v }); },
      getExpandedPaneId: () => expandedPaneId,
      expandPane, collapsePane, jumpToPane,
    });
    setupViewModeToggle();
    initNotifications();
    showPromoToasts();
    connectWebSocket();
    _telemetry.init();
    // _onboarding.init() runs after the tutorial check below, so a first-time
    // user about to be redirected never starts the clock.
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

    // Only now that the tutorial is known to be behind them.
    _onboarding.init();
    _hotkeyTip.show();
    maybeCreateStarterTerminal();
  }

  // ── Starter terminal ──────────────────────────────────────────────────────
  //
  // A brand-new user lands on an empty canvas with nothing to act on. One
  // terminal, created for them, turns that into a working surface.
  //
  // Deliberately gated four ways:
  //  - once per account, tracked server-side, so a second device does not add
  //    a second terminal and a later empty canvas stays empty;
  //  - only when the canvas holds no terminal at all, including offline
  //    placeholders for panes whose agent is currently disconnected — a
  //    returning user whose machine is off has terminals, they just are not
  //    reachable right now;
  //  - only once an agent is actually online, since creating a terminal is a
  //    request to that agent. Local installs start their own and connect a
  //    moment after load; a hosted user without a machine gets nothing here,
  //    which is correct — their next step is pairing one, and the HUD says so;
  //  - failures stay silent, because this pane was never explicitly requested.
  let starterTerminalPending = false;

  function hasAnyTerminal() {
    // Offline placeholders count: the terminal exists, its agent is just away.
    return state.panes.some(p => p.type === 'terminal');
  }

  async function maybeCreateStarterTerminal() {
    if (starterTerminalCreated || starterTerminalPending) return;
    if (hasAnyTerminal()) return;

    const onlineAgent = agents.find(a => a.online);
    if (!onlineAgent) return; // retried when an agent comes online

    starterTerminalPending = true;
    try {
      // Re-check after the await: pane loading for this agent may still have
      // been in flight when the online event fired.
      await new Promise(r => setTimeout(r, 0));
      if (starterTerminalCreated || hasAnyTerminal()) return;

      // Claim the slot before awaiting the create: the pane lands in
      // state.panes partway through, but until it does another caller reaching
      // here would see an empty canvas and start a second terminal.
      starterTerminalCreated = true;

      const ok = await createPane(undefined, null, onlineAgent.agentId, { silent: true });
      if (!ok) {
        starterTerminalCreated = false; // nothing was created; allow a retry
        return;
      }

      // Immediate rather than debounced: a user who closes the tab right after
      // the terminal appears must not be handed a second one next load.
      savePrefsToCloud({ starterTerminalCreated: true }, { immediate: true });
      telemetry.track('feature.starter_terminal_created');
    } finally {
      starterTerminalPending = false;
    }
  }

  // CLAUDE_LOGO_SVG — imported from modules/constants.js

  // formatLocationPath — imported from modules/utils.js

  // Notification functions — imported from modules/notifications.js

    // Update pane headers with Claude state info (called from WS push)
  // updateClaudeStates -> modules/claude-states.js
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
          loadTerminalsFromServer()
            .then(() => maybeCreateStarterTerminal())
            .catch(e => console.error('Failed to load panes:', e));
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
            // Only after this agent's panes are on the canvas, so an existing
            // terminal is never missed and duplicated.
            maybeCreateStarterTerminal();
          })();
        } else {
          maybeCreateStarterTerminal();
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
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:var(--scrim);display:flex;align-items:center;justify-content:center;z-index:100000;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:var(--surface-solid);border:1px solid var(--status-ok);border-radius:12px;padding:32px;max-width:420px;text-align:center;color:var(--text-primary);font-family:monospace;';

    dialog.innerHTML = `
      <div style="font-size:24px;margin-bottom:8px;">&#x26A1;</div>
      <h3 style="margin:0 0 12px;color:var(--status-ok);">Upgrade to Pro</h3>
      <p style="margin:0 0 20px;opacity:0.8;line-height:1.5;">${message}</p>
      <div style="display:flex;gap:12px;justify-content:center;">
        <button id="upgrade-checkout-btn" style="background:var(--status-ok);color:var(--canvas);border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-weight:bold;font-family:monospace;">Upgrade — $8/mo</button>
        <button id="upgrade-dismiss-btn" style="background:transparent;color:var(--text-muted);border:1px solid var(--text-muted);padding:10px 24px;border-radius:6px;cursor:pointer;font-family:monospace;">Maybe later</button>
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
  // SECTION 11: CONNECTION STATUS  -> modules/connection.js
  // ============================================================================

  // ============================================================================
  // SECTION 12: PANE CREATION & TYPE REGISTRY  -> modules/pane-creation.js
  // ============================================================================

  // ============================================================================
  // SECTION 12b: TAB GROUPS  -> modules/tab-groups.js
  // ============================================================================

  // ============================================================================
  // SECTION 13: TERMINAL LIFECYCLE & PANE RENDERING  -> modules/terminal-lifecycle.js
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
  // SECTION 18: QUICK VIEW & MENTION MODE  -> modules/quick-view.js
  // ============================================================================

  // ============================================================================
  // SECTION 19: PLACEMENT MODE  -> modules/placement.js
  // ============================================================================

  // ============================================================================
  // SECTION 19b: PROJECTS & CHECKPOINTS  -> modules/projects.js
  // ============================================================================

  // ============================================================================
  // SECTION 20: UI MENUS & TOOLBAR  -> modules/menus.js
  // ============================================================================

  // ============================================================================
  // SECTION 21: MOVE MODE  -> modules/move-mode.js
  // ============================================================================

  // ============================================================================
  // SECTION 22: KEYBOARD SHORTCUTS
  // Extracted to modules/shortcuts.js — see initShortcutsDeps() wiring below.
  // ============================================================================

  // ============================================================================
  // SECTION 23: CANVAS EVENT LISTENERS  -> modules/canvas-events.js
  // ============================================================================

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

  // Bootstrap. Kept in app.js because init() and everything it wires lives
  // here; a module cannot run it before its own context is initialised.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
