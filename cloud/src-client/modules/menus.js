// ─── UI Menus, Toolbar & Canvas Input ─────────────────────────────────────
// The add-pane menu, tutorial menu, toolbar buttons, custom tooltips, canvas
// event wiring, clipboard paste routing, the mobile nav drawer, and the
// spatial helpers used by Tab cycling and move mode.
//
// This section writes none of app.js's module-scope state, so the context is
// read-only: scalars come through getters, and state/selectedPaneIds/terminals
// and the editor maps are passed by reference because they are mutated in
// place rather than reassigned.

import { isExternalInputFocused } from './utils.js';
import { renderMinimap } from './minimap.js';
import { getViewportRect } from './viewport.js';
import { getViewMode, setViewMode } from './view-mode.js';
import { activeToasts } from './notifications.js';
import { showSettingsModal } from './settings.js';
import { sendWs } from './ws-transport.js';

let _ctx = null;

export function initMenusDeps(ctx) { _ctx = ctx; }

export function setupAddPaneMenu() {
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
    // Every pane type is created by placing a ghost on the canvas, so list
    // view has to step aside first rather than leave the user placing a pane
    // onto a surface they cannot see.
    if (getViewMode() === 'list') setViewMode('canvas');
    if (type === 'terminal') {
      _ctx.showDevicePickerThenPlace();
    } else if (type === 'file') {
      _ctx.openFileWithDevicePickerThenPlace();
    } else if (type === 'note') {
      _ctx.enterPlacementMode('note', (pos) => _ctx.createNotePane(pos));
    } else if (type === 'git-graph') {
      _ctx.showGitRepoPickerWithDeviceThenPlace();
    } else if (type === 'iframe') {
      _ctx.showRecentsOrBrowse('iframe', _ctx.getActiveAgentId(),
        (url) => _ctx.enterPlacementMode('iframe', (pos) => _ctx.createIframePaneWithUrl(url, pos)),
        () => _ctx.enterPlacementMode('iframe', (pos) => _ctx.createIframePane(pos))
      );
    } else if (type === 'beads') {
      _ctx.showBeadsRepoPickerWithDeviceThenPlace();
    } else if (type === 'folder') {
      _ctx.showFolderPaneDevicePickerThenPlace();
    } else if (type === 'conversations') {
      _ctx.showConversationsDirPickerThenPlace();
    } else if (type === 'project') {
      _ctx.startProjectCreation();
    } else if (type === 'checkpoint') {
      _ctx.createCheckpointPane();
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

export function setupTutorialMenu() {
  const tutorialBtn = document.getElementById('tutorial-btn');
  const tutorialMenu = document.getElementById('tutorial-menu');
  if (!tutorialBtn || !tutorialMenu) return;

  function updateCompletionIndicators() {
    const tutorialsCompleted = _ctx.getTutorialsCompleted();
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
      } else if (key === 'cheatsheet') {
        window.location.href = '/tutorial?sheet=1';
      } else if (key === 'chapter') {
        // Replay one chapter rather than the whole tour.
        window.location.href = `/tutorial?chapter=${encodeURIComponent(item.dataset.chapter || '0')}`;
      }
    });
  });
}

// Auto-arrange panes in a single column for mobile viewports
export function autoArrangePanes() {
  const state = _ctx.state;
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
    const termInfo = _ctx.terminals.get(p.id);
    if (termInfo) {
      try { termInfo.fitAddon.fit(); } catch (_) {}
    }

    // Refit Monaco editors
    const editorInfo = _ctx.fileEditors.get(p.id);
    if (editorInfo && editorInfo.editor) editorInfo.editor.layout();
    const noteInfo = _ctx.noteEditors.get(p.id);
    if (noteInfo && noteInfo.monacoEditor) noteInfo.monacoEditor.layout();

    _ctx.cloudSaveLayout(p);
  });

  // Reset zoom/pan to show top of column
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  _ctx.updateCanvasTransform();
  _ctx.saveViewState();
  renderMinimap();
}

// Mobile pane navigation drawer (bottom sheet)
export function setupMobileNavDrawer() {
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
    sheet.innerHTML = '<div class="mobile-nav-handle"></div><div style="display:flex;align-items:center;justify-content:space-between;padding:0 16px 8px;"><div class="mobile-nav-title" style="padding:0;">Panes</div><button class="mobile-nav-arrange-btn" style="background:rgba(var(--accent-rgb), 0.15);border:1px solid rgba(var(--accent-rgb), 0.3);color:rgba(var(--accent-rgb), 0.9);font-size:11px;padding:4px 10px;border-radius:6px;cursor:pointer;">Arrange</button></div><div class="mobile-nav-list"></div>';
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
    const sorted = [..._ctx.state.panes].sort((a, b) => {
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
          _ctx.jumpToPane(p);
          setTimeout(() => _ctx.expandPane(p.id), 150);
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

export function setupToolbarButtons() {
  document.getElementById('settings-btn').addEventListener('click', () => showSettingsModal());

  setupTutorialMenu();

  // Zoom about the centre of the usable area rather than the raw window, so
  // repeated presses on a device with a cutout do not walk the view sideways.
  const viewportCenter = () => {
    const rect = getViewportRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  };

  document.getElementById('zoom-in').addEventListener('click', () => {
    const c = viewportCenter();
    _ctx.setZoom(_ctx.state.zoom * 1.2, c.x, c.y);
  });

  document.getElementById('zoom-out').addEventListener('click', () => {
    const c = viewportCenter();
    _ctx.setZoom(_ctx.state.zoom / 1.2, c.x, c.y);
  });

  document.getElementById('zoom-fit').addEventListener('click', () => _ctx.zoomToFit());
}

export function setupCustomTooltips() {
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

export function setupCanvasInteraction() {
  const canvasContainer = _ctx.getCanvasContainer();

  canvasContainer.addEventListener('mousedown', (e) => {
    if (_ctx.getMentionModeActive() && !e.target.closest('.mention-overlay') && !e.target.closest('.pane')) {
      _ctx.exitMentionMode();
    }
  });

  canvasContainer.addEventListener('mousedown', _ctx.handleCanvasPanStart);
  // Capture-phase: pane content stops touchstart from bubbling (terminals,
  // editors, git graph), which used to swallow every two-finger pinch that
  // began over a pane. Capture runs before those handlers, so the canvas sees
  // the gesture first and decides for itself whether to claim it.
  canvasContainer.addEventListener('touchstart', _ctx.handleTouchStart, { passive: false, capture: true });
  canvasContainer.addEventListener('wheel', _ctx.handleWheel, { passive: false });
  // Capture-phase: intercept Ctrl+Scroll and Tab+Scroll before any pane handler can stopPropagation
  canvasContainer.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      _ctx.setZoom(_ctx.state.zoom * delta, e.clientX, e.clientY);
      return;
    }
    if (_ctx.getTabHeld()) {
      e.preventDefault();
      e.stopPropagation();
      _ctx.state.panX -= e.deltaX || 0;
      _ctx.state.panY -= e.deltaY;
      _ctx.updateCanvasTransform();
      _ctx.saveViewState();
    }
  }, { passive: false, capture: true });
  canvasContainer.addEventListener('contextmenu', (e) => e.preventDefault());

  // Middle mouse button: force canvas pan even over panes (capture phase)
  canvasContainer.addEventListener('mousedown', _ctx.handleMiddleMousePan, true);

  // Right mouse button: force canvas pan even over panes (capture phase)
  canvasContainer.addEventListener('mousedown', _ctx.handleRightMousePan, true);

  // Disable middle mouse button paste entirely (Linux X11 primary selection)
  document.addEventListener('auxclick', (e) => {
    if (e.button === 1) e.preventDefault();
  }, true);
}

export function setupPasteHandlers() {
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
    return _ctx.state.panes
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
      _ctx.showUpgradePrompt(
        `Your ${(tier.tier || 'free').charAt(0).toUpperCase() + (tier.tier || 'free').slice(1)} plan allows ${tier.limits.noteImages} images across all notes. You have ${current}. Upgrade for more.`
      );
      return false;
    }
    return true;
  }

  document.addEventListener('paste', (e) => {
    const state = _ctx.state;
    const selectedPaneIds = _ctx.selectedPaneIds;
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
          _ctx.createNotePane(cursorCanvasPos, text || '', validUrls);
        });
      } else {
        _ctx.createNotePane(cursorCanvasPos, text);
      }
      return;
    }

    if (unfocusedPasteMode === 'terminal') {
      unfocusedPasteMode = null;
      const lastFocusedPaneId = _ctx.getLastFocusedPaneId();
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
export function getTabCycleOrder() {
  const terminals = _ctx.state.panes.filter(p => p.type === 'terminal');
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
export function findPaneInDirection(fromPaneId, direction) {
  const state = _ctx.state;
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
export function calcMoveModeZoom(paneData) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return Math.min(
    (vw * 0.7) / paneData.width,
    (vh * 0.7) / paneData.height
  );
}
