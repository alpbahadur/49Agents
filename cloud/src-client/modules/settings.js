// ─── Preferences & Settings Modal ─────────────────────────────────────────
// User prefs (theme, font, canvas bg), settings modal UI,
// theme/font pickers, hotkeys reference.
//
// Canvas background and terminal font are owned here. Every other preference
// lives in app.js and is reached through the injected context, because a
// module cannot assign to an imported binding.

import { APP_VERSION, TERMINAL_FONTS, CANVAS_BACKGROUNDS, APP_THEMES } from './constants.js';
import { getTerminalFontFamily } from './utils.js';
import { setSoundEnabled as _setSoundEnabled } from './sounds.js';

let _ctx = null;

export function initSettingsDeps(ctx) { _ctx = ctx; }

let prefsSaveTimer = null;
let currentCanvasBg = 'default';
let currentTerminalFont = 'JetBrains Mono';
let currentAppTheme = 'system';

export function getCurrentCanvasBg() { return currentCanvasBg; }
export function getCurrentAppTheme() { return currentAppTheme; }
export function getCurrentTerminalFont() { return currentTerminalFont; }

/**
 * Set the font without restyling existing terminals. Used when loading saved
 * preferences, which happens before any terminal has been created.
 */
export function setCurrentTerminalFont(fontName) { currentTerminalFont = fontName; }

export function getAllPrefs(overrides) {
  return {
    appTheme: currentAppTheme,
    terminalTheme: _ctx.getCurrentTerminalTheme(),
    notificationSound: _ctx.getNotificationSoundEnabled(),
    autoRemoveDone: _ctx.getAutoRemoveDoneNotifs(),
    canvasBg: currentCanvasBg,
    snoozeDuration: _ctx.getSnoozeDurationMs() / 1000,
    terminalFont: currentTerminalFont,
    focusMode: _ctx.getFocusMode(),
    hudState: {
      fleet_expanded: _ctx.getHudExpanded(),
      agents_expanded: _ctx.getAgentsHudExpanded(),
      device_colors: _ctx.getDeviceColorOverrides(),
      hud_hidden: _ctx.getHudHidden(),
    },
    tutorialsCompleted: _ctx.getTutorialsCompleted(),
    starterTerminalCreated: _ctx.getStarterTerminalCreated(),
    projectsSidebarPosition: _ctx.getProjectsSidebarPosition(),
    teleportAnimation: _ctx.getTeleportAnimation(),
    beadsButtonEnabled: _ctx.getBeadsButtonEnabled(),
    newTabButtonEnabled: _ctx.getNewTabButtonEnabled(),
    paneHeaderOrder: _ctx.getPaneHeaderOrder(),
    paneNamingEnabled: _ctx.getPaneNamingEnabled(),
    paneNumberHotkeysEnabled: _ctx.getPaneNumberHotkeysEnabled(),
    viewMode: _ctx.getViewModePref(),
    viewModeHotkeyEnabled: _ctx.getViewModeHotkeyEnabled(),
    viewModeToggleVisible: _ctx.getViewModeToggleVisible(),
    ...overrides,
  };
}

export function applyTerminalFont(fontName) {
  currentTerminalFont = fontName;
  const family = getTerminalFontFamily(fontName);
  _ctx.getTerminals().forEach(({ xterm }) => {
    xterm.options.fontFamily = family;
  });
}

export function savePrefsToCloud(overrides, opts = {}) {
  if (prefsSaveTimer) clearTimeout(prefsSaveTimer);
  // Debouncing suits settings the user is actively fiddling with. A one-shot
  // marker is different: if the tab closes inside the debounce window the write
  // is lost and the flag reads false on the next load, so those go out at once.
  if (opts.immediate) {
    return _ctx.cloudFetch('PUT', '/api/preferences', getAllPrefs(overrides))
      .catch(e => console.error('[Prefs] Save failed:', e.message));
  }
  prefsSaveTimer = setTimeout(() => {
    _ctx.cloudFetch('PUT', '/api/preferences', getAllPrefs(overrides))
      .catch(e => console.error('[Prefs] Save failed:', e.message));
  }, 500);
}

const darkQuery = typeof matchMedia === 'function'
  ? matchMedia('(prefers-color-scheme: dark)')
  : null;

/** Resolve a stored preference to the concrete theme to paint. */
function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return darkQuery && darkQuery.matches ? 'dark' : 'light';
}

/**
 * Paint a theme. `data-theme` on <html> swaps the token block in styles.css;
 * everything built on --ink-rgb/--surface-* re-tints from that one attribute.
 * Canvas background is reapplied because the default swatch is theme-derived.
 */
export function setAppTheme(pref) {
  currentAppTheme = APP_THEMES[pref] ? pref : 'system';
  document.documentElement.setAttribute('data-theme', resolveTheme(currentAppTheme));
  // Mirrored locally so the pre-render script in index.html can replay the
  // choice on the next load without waiting for /api/preferences.
  try { localStorage.setItem('tc-app-theme', currentAppTheme); } catch (e) {}
  setCanvasBackground(currentCanvasBg);
}

// Following the OS means tracking it for the whole session, not just at boot.
if (darkQuery) {
  const onSystemChange = () => { if (currentAppTheme === 'system') setAppTheme('system'); };
  if (darkQuery.addEventListener) darkQuery.addEventListener('change', onSystemChange);
  else if (darkQuery.addListener) darkQuery.addListener(onSystemChange);
}

export function setCanvasBackground(key) {
  const bg = CANVAS_BACKGROUNDS[key] || CANVAS_BACKGROUNDS.default;
  currentCanvasBg = key;
  // Themed swatches defer to the active theme's canvas token; the rest pin
  // their own colour so an explicit dark pick survives a theme switch.
  document.body.style.backgroundColor = bg.themed ? 'var(--canvas)' : bg.color;
  // Handle grid background
  if (bg.grid) {
    const gridLine = 'var(--ink-05)';
    document.body.style.backgroundImage = `linear-gradient(${gridLine} 1px, transparent 1px), linear-gradient(90deg, ${gridLine} 1px, transparent 1px)`;
    document.body.style.backgroundSize = '40px 40px';
  } else {
    document.body.style.backgroundImage = 'none';
    document.body.style.backgroundSize = '';
  }
}

/**
 * One settings row carrying a switch. The older rows in this modal spell the
 * same markup out inline; new ones go through here so the three pane-chrome
 * toggles below don't triple it again.
 */
function toggleRowHtml(id, label, description, on) {
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--ink-06);">
      <div>
        <div style="font-size:13px;">${label}</div>
        <div style="font-size:11px;color:var(--text-muted);">${description}</div>
      </div>
      <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;">
        <input type="checkbox" id="${id}" ${on ? 'checked' : ''} style="opacity:0;width:0;height:0;">
        <span style="position:absolute;inset:0;background:${on ? 'rgba(var(--accent-rgb),0.5)' : 'var(--ink-10)'};border-radius:11px;transition:0.2s;"></span>
        <span style="position:absolute;top:2px;left:${on ? '20px' : '2px'};width:18px;height:18px;background:var(--on-accent);border-radius:50%;transition:0.2s;"></span>
      </label>
    </div>`;
}

/** Wire a row built by toggleRowHtml: repaint the switch, then persist. */
function bindToggleRow(id, apply) {
  const input = document.getElementById(id);
  if (!input) return;
  input.addEventListener('change', () => {
    const on = input.checked;
    const track = input.nextElementSibling;
    const knob = track.nextElementSibling;
    track.style.background = on ? 'rgba(var(--accent-rgb),0.5)' : 'var(--ink-10)';
    knob.style.left = on ? '20px' : '2px';
    apply(on);
  });
}

const PANE_CONTROL_LABELS = {
  shortcut: 'Number badge',
  beads: 'Beads issue',
  reload: 'Reload history',
  zoom: 'Zoom',
  newtab: 'New tab',
};

/**
 * Reorder row for the pane header controls. Arrows rather than drag and drop:
 * the list is five items long, and arrows work on touch and by keyboard
 * without a drag surface. Expand and close are not listed — they stay pinned
 * to the right so close never moves under the cursor by surprise.
 */
function paneHeaderOrderHtml(order) {
  const rows = order.map((key, i) => `
    <div class="settings-order-row" data-key="${key}" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;background:var(--ink-03);border:1px solid var(--ink-06);border-radius:6px;">
      <span style="font-size:12px;color:var(--text-secondary);">${i + 1}. ${PANE_CONTROL_LABELS[key] || key}</span>
      <span style="display:flex;gap:4px;">
        <button class="settings-order-btn" data-dir="up" data-key="${key}" aria-label="Move ${PANE_CONTROL_LABELS[key] || key} left" ${i === 0 ? 'disabled' : ''} style="width:24px;height:24px;border-radius:4px;border:1px solid var(--ink-10);background:transparent;color:${i === 0 ? '#4a4a68' : '#b8b8d0'};cursor:${i === 0 ? 'default' : 'pointer'};font-family:inherit;">&#8592;</button>
        <button class="settings-order-btn" data-dir="down" data-key="${key}" aria-label="Move ${PANE_CONTROL_LABELS[key] || key} right" ${i === order.length - 1 ? 'disabled' : ''} style="width:24px;height:24px;border-radius:4px;border:1px solid var(--ink-10);background:transparent;color:${i === order.length - 1 ? '#4a4a68' : '#b8b8d0'};cursor:${i === order.length - 1 ? 'default' : 'pointer'};font-family:inherit;">&#8594;</button>
      </span>
    </div>`).join('');
  return `
    <div style="padding:12px 0;border-bottom:1px solid var(--ink-06);">
      <div style="font-size:13px;">Pane Header Button Order</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">Left to right. Expand and close stay pinned at the end.</div>
      <div id="settings-pane-order" style="display:flex;flex-direction:column;gap:4px;">${rows}</div>
    </div>`;
}

/**
 * Re-renders itself after every move so the numbering and the disabled state
 * of the end arrows stay correct.
 */
function bindPaneHeaderOrder() {
  const container = document.getElementById('settings-pane-order');
  if (!container) return;
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.settings-order-btn');
    if (!btn || btn.disabled) return;
    const order = _ctx.getPaneHeaderOrder();
    const from = order.indexOf(btn.dataset.key);
    const to = btn.dataset.dir === 'up' ? from - 1 : from + 1;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    _ctx.setPaneHeaderOrder(order);
    savePrefsToCloud({ paneHeaderOrder: order });
    const fresh = paneHeaderOrderHtml(_ctx.getPaneHeaderOrder());
    const temp = document.createElement('div');
    temp.innerHTML = fresh;
    container.innerHTML = temp.querySelector('#settings-pane-order').innerHTML;
  });
}

export function showSettingsModal() {
  const TERMINAL_THEMES = _ctx.getTerminalThemes();
  const currentTerminalTheme = _ctx.getCurrentTerminalTheme();
  const notificationSoundEnabled = _ctx.getNotificationSoundEnabled();
  const autoRemoveDoneNotifs = _ctx.getAutoRemoveDoneNotifs();
  const focusMode = _ctx.getFocusMode();
  const teleportAnimation = _ctx.getTeleportAnimation();
  const beadsButtonEnabled = _ctx.getBeadsButtonEnabled();
  const paneNamingEnabled = _ctx.getPaneNamingEnabled();
  const paneNumberHotkeysEnabled = _ctx.getPaneNumberHotkeysEnabled();
  const viewModeIsList = _ctx.getViewModePref() === 'list';
  const viewModeHotkeyEnabled = _ctx.getViewModeHotkeyEnabled();
  const viewModeToggleVisible = _ctx.getViewModeToggleVisible();
  const newTabButtonEnabled = _ctx.getNewTabButtonEnabled();
  const paneHeaderOrder = _ctx.getPaneHeaderOrder();
  const projectsSidebarPosition = _ctx.getProjectsSidebarPosition();
  const snoozeDurationMs = _ctx.getSnoozeDurationMs();

  _ctx.telemetry.track('feature.settings_open');
  const existing = document.getElementById('settings-modal');
  if (existing) { existing.remove(); return; }

  const user = window.__tcUser || {};

  const overlay = document.createElement('div');
  overlay.id = 'settings-modal';
  overlay.style.cssText = 'position:fixed;inset:0;background:var(--scrim);display:flex;align-items:center;justify-content:center;z-index:100000;';

  const dialog = document.createElement('div');
  dialog.className = 'tc-scrollbar';
  dialog.style.cssText = 'background:var(--surface-solid);border:1px solid rgba(var(--accent-rgb),0.3);border-radius:12px;padding:24px;max-width:400px;width:90%;color:var(--text-primary);font-family:Montserrat,sans-serif;max-height:80vh;overflow-y:auto;';

  // Current theme/font info for collapsed preview
  const curTheme = TERMINAL_THEMES[currentTerminalTheme] || TERMINAL_THEMES.default || {};
  const curThemeDots = [curTheme.red, curTheme.green, curTheme.blue, curTheme.yellow, curTheme.magenta, curTheme.cyan].filter(Boolean)
    .map(c => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:2px;"></span>`).join('');

  dialog.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <h3 style="margin:0;font-size:16px;font-weight:400;color:var(--text-secondary);">Settings</h3>
      <button id="settings-close-btn" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer;padding:4px 8px;border-radius:4px;line-height:1;">&times;</button>
    </div>

    <div style="background:var(--ink-03);border:1px solid var(--ink-06);border-radius:8px;padding:14px;margin-bottom:16px;">
      <div style="display:flex;align-items:center;gap:12px;">
        ${user.avatar ? `<img src="${user.avatar}" style="width:40px;height:40px;border-radius:50%;border:1px solid var(--ink-10);" alt="">` : '<div style="width:40px;height:40px;border-radius:50%;background:rgba(var(--accent-rgb),0.3);display:flex;align-items:center;justify-content:center;font-size:18px;">U</div>'}
        <div style="flex:1;min-width:0;">
          <div style="font-size:14px;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${user.name || 'User'}</div>
          <div style="font-size:12px;color:var(--text-muted);">@${user.login || 'unknown'} &middot; <span style="color:${user.tier === 'poweruser' ? '#e0a0ff' : user.tier === 'pro' ? 'var(--status-ok)' : user.tier === 'team' ? 'var(--status-info)' : 'var(--text-muted)'};text-transform:uppercase;font-size:10px;letter-spacing:0.5px;">${user.tier || 'free'}</span></div>
        </div>
        <button id="settings-logout-btn" style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);color:var(--status-danger);font-size:11px;padding:5px 12px;border-radius:6px;cursor:pointer;font-family:inherit;white-space:nowrap;">Logout</button>
      </div>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(var(--ink-rgb),0.06);">
      <div>
        <div style="font-size:13px;">Appearance</div>
        <div style="font-size:11px;color:var(--text-muted);">Light, dark, or follow your system</div>
      </div>
      <div id="settings-theme-seg" role="group" aria-label="Appearance" style="display:flex;gap:2px;background:rgba(var(--ink-rgb),0.06);border-radius:8px;padding:2px;">
        ${Object.entries(APP_THEMES).map(([key, t]) => `
          <button type="button" data-theme-choice="${key}" aria-pressed="${currentAppTheme === key}" style="
            border:none;cursor:pointer;font-family:inherit;font-size:11px;
            padding:5px 10px;border-radius:6px;transition:background 0.15s,color 0.15s;
            background:${currentAppTheme === key ? 'rgba(var(--accent-rgb),0.9)' : 'transparent'};
            color:${currentAppTheme === key ? 'var(--on-accent)' : 'var(--text-muted)'};
          ">${t.name}</button>`).join('')}
      </div>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--ink-06);">
      <div>
        <div style="font-size:13px;">Notification Sound</div>
        <div style="font-size:11px;color:var(--text-muted);">Play sound on state changes</div>
      </div>
      <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;">
        <input type="checkbox" id="settings-sound-toggle" ${notificationSoundEnabled ? 'checked' : ''} style="opacity:0;width:0;height:0;">
        <span style="position:absolute;inset:0;background:${notificationSoundEnabled ? 'rgba(var(--accent-rgb),0.5)' : 'var(--ink-10)'};border-radius:11px;transition:0.2s;"></span>
        <span style="position:absolute;top:2px;left:${notificationSoundEnabled ? '20px' : '2px'};width:18px;height:18px;background:var(--on-accent);border-radius:50%;transition:0.2s;"></span>
      </label>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--ink-06);">
      <div>
        <div style="font-size:13px;">Auto-Remove Done Notifications</div>
        <div style="font-size:11px;color:var(--text-muted);">Automatically dismiss "Task complete" after 15s</div>
      </div>
      <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;">
        <input type="checkbox" id="settings-auto-remove-done-toggle" ${autoRemoveDoneNotifs ? 'checked' : ''} style="opacity:0;width:0;height:0;">
        <span style="position:absolute;inset:0;background:${autoRemoveDoneNotifs ? 'rgba(var(--accent-rgb),0.5)' : 'var(--ink-10)'};border-radius:11px;transition:0.2s;"></span>
        <span style="position:absolute;top:2px;left:${autoRemoveDoneNotifs ? '20px' : '2px'};width:18px;height:18px;background:var(--on-accent);border-radius:50%;transition:0.2s;"></span>
      </label>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--ink-06);">
      <div>
        <div style="font-size:13px;">Focus on Hover</div>
        <div style="font-size:11px;color:var(--text-muted);">Hover to focus panes (off = click to focus)</div>
      </div>
      <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;">
        <input type="checkbox" id="settings-focus-mode-toggle" ${focusMode === 'hover' ? 'checked' : ''} style="opacity:0;width:0;height:0;">
        <span style="position:absolute;inset:0;background:${focusMode === 'hover' ? 'rgba(var(--accent-rgb),0.5)' : 'var(--ink-10)'};border-radius:11px;transition:0.2s;"></span>
        <span style="position:absolute;top:2px;left:${focusMode === 'hover' ? '20px' : '2px'};width:18px;height:18px;background:var(--on-accent);border-radius:50%;transition:0.2s;"></span>
      </label>
    </div>

    <div id="settings-telemetry-row" style="display:none;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--ink-06);">
      <div>
        <div style="font-size:13px;">Usage Telemetry</div>
        <div style="font-size:11px;color:var(--text-muted);">Send anonymous usage data to improve 49Agents</div>
      </div>
      <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;">
        <input type="checkbox" id="settings-telemetry-toggle" style="opacity:0;width:0;height:0;">
        <span style="position:absolute;inset:0;background:var(--ink-10);border-radius:11px;transition:0.2s;"></span>
        <span style="position:absolute;top:2px;left:2px;width:18px;height:18px;background:var(--on-accent);border-radius:50%;transition:0.2s;"></span>
      </label>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--ink-06);">
      <div>
        <div style="font-size:13px;">Teleport Animation</div>
        <div style="font-size:11px;color:var(--text-muted);">Animate when jumping to projects/checkpoints</div>
      </div>
      <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;">
        <input type="checkbox" id="settings-teleport-anim-toggle" ${teleportAnimation ? 'checked' : ''} style="opacity:0;width:0;height:0;">
        <span style="position:absolute;inset:0;background:${teleportAnimation ? 'rgba(var(--accent-rgb),0.5)' : 'var(--ink-10)'};border-radius:11px;transition:0.2s;"></span>
        <span style="position:absolute;top:2px;left:${teleportAnimation ? '20px' : '2px'};width:18px;height:18px;background:var(--on-accent);border-radius:50%;transition:0.2s;"></span>
      </label>
    </div>
${toggleRowHtml('settings-pane-naming-toggle', 'Pane Names', 'Show the editable name field in pane headers', paneNamingEnabled)}
${toggleRowHtml('settings-pane-hotkeys-toggle', 'Pane Number Hotkeys', 'Number badges in headers, and Tab+1..9 to jump', paneNumberHotkeysEnabled)}
${toggleRowHtml('settings-new-tab-toggle', 'New Tab Button', 'Add a terminal tab to a pane from its header', newTabButtonEnabled)}
${toggleRowHtml('settings-beads-btn-toggle', 'Beads Issue Button', 'Tag panes with a beads issue from the header', beadsButtonEnabled)}
${toggleRowHtml('settings-view-mode-toggle', 'List View', 'Show panes as a list instead of on the canvas', viewModeIsList)}
${toggleRowHtml('settings-view-mode-hotkey-toggle', 'List View Hotkey', 'Tab+X switches between canvas and list', viewModeHotkeyEnabled)}
${toggleRowHtml('settings-view-mode-btn-toggle', 'List View Button', 'Show the view switch beside the zoom controls', viewModeToggleVisible)}
${paneHeaderOrderHtml(paneHeaderOrder)}

    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--ink-06);">
      <div>
        <div style="font-size:13px;">Projects Sidebar Position</div>
        <div style="font-size:11px;color:var(--text-muted);">Where the sidebar appears (Tab+P)</div>
      </div>
      <div id="settings-sidebar-pos" style="display:flex;gap:4px;">
        ${['left', 'right'].map(pos => `<button class="settings-sidebar-pos-btn" data-pos="${pos}" style="padding:4px 10px;border-radius:4px;border:1px solid ${projectsSidebarPosition === pos ? 'rgba(var(--accent-rgb),0.4)' : 'var(--ink-08)'};background:${projectsSidebarPosition === pos ? 'rgba(var(--accent-rgb),0.2)' : 'transparent'};color:${projectsSidebarPosition === pos ? 'var(--on-accent)' : 'var(--text-secondary)'};font-size:11px;cursor:pointer;font-family:inherit;">${pos}</button>`).join('')}
      </div>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--ink-06);">
      <div>
        <div style="font-size:13px;">Snooze Duration</div>
        <div style="font-size:11px;color:var(--text-muted);">How long to mute per terminal</div>
      </div>
      <span id="settings-snooze-slot"></span>
    </div>

    <div style="padding:12px 0;border-bottom:1px solid var(--ink-06);">
      <div style="font-size:13px;margin-bottom:8px;">Canvas Background</div>
      <div id="settings-bg-list" style="display:flex;gap:6px;flex-wrap:wrap;">
        ${Object.entries(CANVAS_BACKGROUNDS).map(([key, bg]) => {
          const isSel = key === currentCanvasBg;
          return `<div class="settings-bg-item" data-bg="${key}" style="display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:6px;cursor:pointer;background:${isSel ? 'rgba(var(--accent-rgb),0.2)' : 'var(--ink-03)'};border:1px solid ${isSel ? 'rgba(var(--accent-rgb),0.4)' : 'var(--ink-06)'};transition:all 0.15s ease;">
            <span style="width:16px;height:16px;border-radius:4px;border:1px solid var(--ink-15);background:${bg.color};${bg.grid ? 'background-image:linear-gradient(var(--ink-10) 1px,transparent 1px),linear-gradient(90deg,var(--ink-10) 1px,transparent 1px);background-size:4px 4px;' : ''}"></span>
            <span style="font-size:12px;">${bg.name}</span>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div style="padding:12px 0;border-bottom:1px solid var(--ink-06);">
      <div id="settings-theme-header" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;">
        <div style="font-size:13px;">Terminal Theme</div>
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="display:flex;gap:1px;">${curThemeDots}</span>
          <span style="font-size:12px;color:var(--text-muted);">${curTheme.name || currentTerminalTheme}</span>
          <span id="settings-theme-arrow" style="font-size:10px;color:var(--text-muted);transition:transform 0.2s;">▶</span>
        </div>
      </div>
      <div id="settings-theme-body" style="display:none;margin-top:8px;">
        <input id="settings-theme-search" type="text" placeholder="Search themes..." style="width:100%;padding:5px 8px;margin-bottom:6px;background:var(--ink-05);border:1px solid var(--ink-08);border-radius:6px;color:var(--text-primary);font-size:12px;font-family:inherit;outline:none;box-sizing:border-box;" />
        <div id="settings-theme-list" style="max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;"></div>
      </div>
    </div>

    <div style="padding:12px 0;">
      <div id="settings-font-header" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;">
        <div style="font-size:13px;">Terminal Font</div>
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:12px;color:var(--text-muted);font-family:'${currentTerminalFont}',monospace;">${currentTerminalFont}</span>
          <span id="settings-font-arrow" style="font-size:10px;color:var(--text-muted);transition:transform 0.2s;">▶</span>
        </div>
      </div>
      <div id="settings-font-body" style="display:none;margin-top:8px;">
        <input id="settings-font-search" type="text" placeholder="Search fonts..." style="width:100%;padding:5px 8px;margin-bottom:6px;background:var(--ink-05);border:1px solid var(--ink-08);border-radius:6px;color:var(--text-primary);font-size:12px;font-family:inherit;outline:none;box-sizing:border-box;" />
        <div id="settings-font-list" style="max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;"></div>
      </div>
    </div>

    <div style="padding:12px 0;border-top:1px solid var(--ink-06);">
      <div id="settings-hotkeys-header" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;">
        <div style="font-size:13px;">Keyboard Shortcuts</div>
        <span id="settings-hotkeys-arrow" style="font-size:10px;color:var(--text-muted);transition:transform 0.2s;">▶</span>
      </div>
      <div id="settings-hotkeys-body" style="display:none;margin-top:10px;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;">
        <kbd style="background:var(--ink-08);padding:2px 6px;border-radius:4px;font-family:inherit;color:var(--text-primary);">Tab Q</kbd><span style="color:var(--text-muted);">Cycle terminals</span>
        <kbd style="background:var(--ink-08);padding:2px 6px;border-radius:4px;font-family:inherit;color:var(--text-primary);">Tab A</kbd><span style="color:var(--text-muted);">Add menu</span>
        <kbd style="background:var(--ink-08);padding:2px 6px;border-radius:4px;font-family:inherit;color:var(--text-primary);">Tab D</kbd><span style="color:var(--text-muted);">Toggle fleet pane</span>
        <kbd style="background:var(--ink-08);padding:2px 6px;border-radius:4px;font-family:inherit;color:var(--text-primary);">Tab U</kbd><span style="color:var(--text-muted);">Toggle usage pane</span>
        <kbd style="background:var(--ink-08);padding:2px 6px;border-radius:4px;font-family:inherit;color:var(--text-primary);">Tab S</kbd><span style="color:var(--text-muted);">Settings</span>
        <kbd style="background:var(--ink-08);padding:2px 6px;border-radius:4px;font-family:inherit;color:var(--text-primary);">Tab W</kbd><span style="color:var(--text-muted);">Close pane (all if broadcast)</span>
        <kbd style="background:var(--ink-08);padding:2px 6px;border-radius:4px;font-family:inherit;color:var(--text-primary);">Shift+Click</kbd><span style="color:var(--text-muted);">Broadcast select</span>
        <kbd style="background:var(--ink-08);padding:2px 6px;border-radius:4px;font-family:inherit;color:var(--text-primary);">Esc</kbd><span style="color:var(--text-muted);">Clear broadcast / cancel</span>
        <kbd style="background:var(--ink-08);padding:2px 6px;border-radius:4px;font-family:inherit;color:var(--text-primary);">Ctrl+Shift+2</kbd><span style="color:var(--text-muted);">Mention</span>
        <kbd style="background:var(--ink-08);padding:2px 6px;border-radius:4px;font-family:inherit;color:var(--text-primary);">Tab Tab</kbd><span style="color:var(--text-muted);">Enter move mode</span>
        <div style="grid-column:1/3;padding:4px 0 2px 8px;color:var(--text-muted);font-size:11px;border-left:2px solid var(--ink-06);">
          <div style="margin-bottom:3px;"><kbd style="background:var(--ink-06);padding:1px 5px;border-radius:3px;font-family:inherit;color:var(--text-secondary);font-size:11px;">WASD</kbd> / <kbd style="background:var(--ink-06);padding:1px 5px;border-radius:3px;font-family:inherit;color:var(--text-secondary);font-size:11px;">Arrows</kbd> Navigate between panes</div>
          <div style="margin-bottom:3px;"><kbd style="background:var(--ink-06);padding:1px 5px;border-radius:3px;font-family:inherit;color:var(--text-secondary);font-size:11px;">Enter</kbd> / <kbd style="background:var(--ink-06);padding:1px 5px;border-radius:3px;font-family:inherit;color:var(--text-secondary);font-size:11px;">Tab</kbd> Select pane &amp; keep zoom</div>
          <div><kbd style="background:var(--ink-06);padding:1px 5px;border-radius:3px;font-family:inherit;color:var(--text-secondary);font-size:11px;">Esc</kbd> Cancel &amp; restore original zoom</div>
        </div>
        <kbd style="background:var(--ink-08);padding:2px 6px;border-radius:4px;font-family:inherit;color:var(--text-primary);">Ctrl+Scroll</kbd><span style="color:var(--text-muted);">Zoom canvas</span>
        <kbd style="background:var(--ink-08);padding:2px 6px;border-radius:4px;font-family:inherit;color:var(--text-primary);">Scroll</kbd><span style="color:var(--text-muted);">Pan canvas / scroll terminal</span>
        <kbd style="background:var(--ink-08);padding:2px 6px;border-radius:4px;font-family:inherit;color:var(--text-primary);">Ctrl +/-/0</kbd><span style="color:var(--text-muted);">Zoom pane (focused) or canvas</span>
        <kbd style="background:var(--ink-08);padding:2px 6px;border-radius:4px;font-family:inherit;color:var(--text-primary);">Shift+Scroll</kbd><span style="color:var(--text-muted);">Pan canvas (over panes)</span>
        <kbd style="background:var(--ink-08);padding:2px 6px;border-radius:4px;font-family:inherit;color:var(--text-primary);">Middle-drag</kbd><span style="color:var(--text-muted);">Pan canvas (anywhere)</span>
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

  // Sound toggle
  // Appearance segmented control
  const themeSeg = document.getElementById('settings-theme-seg');
  themeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-choice]');
    if (!btn) return;
    const choice = btn.dataset.themeChoice;
    if (choice === currentAppTheme) return;
    setAppTheme(choice);
    themeSeg.querySelectorAll('[data-theme-choice]').forEach(b => {
      const on = b.dataset.themeChoice === choice;
      b.setAttribute('aria-pressed', String(on));
      b.style.background = on ? 'rgba(var(--accent-rgb),0.9)' : 'transparent';
      b.style.color = on ? 'var(--on-accent)' : 'var(--text-muted)';
    });
    savePrefsToCloud({ appTheme: choice });
  });

  const soundToggle = document.getElementById('settings-sound-toggle');
  soundToggle.addEventListener('change', () => {
    const on = soundToggle.checked;
    _ctx.setNotificationSoundEnabled(on);
    _setSoundEnabled(on);
    const track = soundToggle.nextElementSibling;
    const knob = track.nextElementSibling;
    track.style.background = on ? 'rgba(var(--accent-rgb),0.5)' : 'var(--ink-10)';
    knob.style.left = on ? '20px' : '2px';
    savePrefsToCloud({ notificationSound: on });
  });

  // Auto-remove done notifications toggle
  const autoRemoveToggle = document.getElementById('settings-auto-remove-done-toggle');
  autoRemoveToggle.addEventListener('change', () => {
    const on = autoRemoveToggle.checked;
    _ctx.setAutoRemoveDoneNotifs(on);
    const track = autoRemoveToggle.nextElementSibling;
    const knob = track.nextElementSibling;
    track.style.background = on ? 'rgba(var(--accent-rgb),0.5)' : 'var(--ink-10)';
    knob.style.left = on ? '20px' : '2px';
    savePrefsToCloud({ autoRemoveDone: on });
  });

  // Focus mode toggle (hover vs click)
  const focusModeToggle = document.getElementById('settings-focus-mode-toggle');
  focusModeToggle.addEventListener('change', () => {
    const hover = focusModeToggle.checked;
    const mode = hover ? 'hover' : 'click';
    _ctx.setFocusMode(mode);
    const track = focusModeToggle.nextElementSibling;
    const knob = track.nextElementSibling;
    track.style.background = hover ? 'rgba(var(--accent-rgb),0.5)' : 'var(--ink-10)';
    knob.style.left = hover ? '20px' : '2px';
    savePrefsToCloud({ focusMode: mode });
  });

  // Teleport animation toggle
  const teleportAnimToggle = document.getElementById('settings-teleport-anim-toggle');
  teleportAnimToggle.addEventListener('change', () => {
    const on = teleportAnimToggle.checked;
    _ctx.setTeleportAnimation(on);
    const track = teleportAnimToggle.nextElementSibling;
    const knob = track.nextElementSibling;
    track.style.background = on ? 'rgba(var(--accent-rgb),0.5)' : 'var(--ink-10)';
    knob.style.left = on ? '20px' : '2px';
    savePrefsToCloud({ teleportAnimation: on });
  });

  // Pane chrome toggles — each setter reapplies the body classes that hide or
  // show the affordance, so panes already on the canvas update immediately.
  bindToggleRow('settings-pane-naming-toggle', (on) => {
    _ctx.setPaneNamingEnabled(on);
    savePrefsToCloud({ paneNamingEnabled: on });
  });
  bindToggleRow('settings-pane-hotkeys-toggle', (on) => {
    _ctx.setPaneNumberHotkeysEnabled(on);
    savePrefsToCloud({ paneNumberHotkeysEnabled: on });
  });
  bindToggleRow('settings-new-tab-toggle', (on) => {
    _ctx.setNewTabButtonEnabled(on);
    savePrefsToCloud({ newTabButtonEnabled: on });
  });
  // View mode. The mode itself is a toggle rather than a picker because there
  // are only two, and the two rows below it govern how else it can be reached.
  bindToggleRow('settings-view-mode-toggle', (on) => {
    _ctx.setViewMode(on ? 'list' : 'canvas');
  });
  bindToggleRow('settings-view-mode-hotkey-toggle', (on) => {
    _ctx.setViewModeHotkeyEnabled(on);
    savePrefsToCloud({ viewModeHotkeyEnabled: on });
  });
  bindToggleRow('settings-view-mode-btn-toggle', (on) => {
    _ctx.setViewModeToggleVisible(on);
    savePrefsToCloud({ viewModeToggleVisible: on });
  });
  bindToggleRow('settings-beads-btn-toggle', (on) => {
    _ctx.setBeadsButtonEnabled(on);
    savePrefsToCloud({ beadsButtonEnabled: on });
  });
  bindPaneHeaderOrder();

  // Sidebar position buttons
  document.querySelectorAll('.settings-sidebar-pos-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pos = btn.dataset.pos;
      _ctx.setProjectsSidebarPosition(pos);
      // Update button styles
      document.querySelectorAll('.settings-sidebar-pos-btn').forEach(b => {
        const isSel = b.dataset.pos === pos;
        b.style.borderColor = isSel ? 'rgba(var(--accent-rgb),0.4)' : 'var(--ink-08)';
        b.style.background = isSel ? 'rgba(var(--accent-rgb),0.2)' : 'transparent';
        b.style.color = isSel ? 'var(--on-accent)' : 'var(--text-secondary)';
      });
      _ctx.applyProjectsSidebarPosition();
      savePrefsToCloud({ projectsSidebarPosition: pos });
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
        track.style.background = data.consent ? 'rgba(var(--accent-rgb),0.5)' : 'var(--ink-10)';
        knob.style.left = data.consent ? '20px' : '2px';
      }).catch(() => {});
    // Handle toggle changes
    toggle.addEventListener('change', () => {
      const on = toggle.checked;
      track.style.background = on ? 'rgba(var(--accent-rgb),0.5)' : 'var(--ink-10)';
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
  const snoozeSelect = _ctx.createCustomSelect(
    [
      { value: '30', label: '30s' },
      { value: '60', label: '60s' },
      { value: '90', label: '90s' },
      { value: '300', label: '5min' },
      { value: '600', label: '10min' }
    ],
    String(snoozeDurationMs / 1000),
    (val) => {
      _ctx.setSnoozeDurationMs(parseInt(val) * 1000);
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
      el.style.background = isSel ? 'rgba(var(--accent-rgb),0.2)' : 'var(--ink-03)';
      el.style.borderColor = isSel ? 'rgba(var(--accent-rgb),0.4)' : 'var(--ink-06)';
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
      const isSel = key === _ctx.getCurrentTerminalTheme();
      const dots = [t.red, t.green, t.blue, t.yellow, t.magenta, t.cyan].filter(Boolean)
        .map(c => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:2px;"></span>`).join('');
      html += `<div class="settings-theme-item" data-theme="${key}" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;cursor:pointer;background:${isSel ? 'rgba(var(--accent-rgb),0.2)' : 'transparent'};border:1px solid ${isSel ? 'rgba(var(--accent-rgb),0.4)' : 'transparent'};transition:all 0.15s ease;">
        <span style="min-width:16px;text-align:center;font-size:12px;">${isSel ? '✓' : ''}</span>
        <span style="font-size:13px;flex:1;">${t.name}</span>
        <span style="display:flex;gap:1px;">${dots}</span>
      </div>`;
    }
    themeList.innerHTML = html || '<div style="font-size:12px;color:var(--text-muted);padding:6px;">No matching themes</div>';
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
    _ctx.applyTerminalTheme(themeKey);
    _ctx.telemetry.track('feature.theme_change', { theme_name: themeKey });
    renderThemeList(themeSearch.value);
    // Update collapsed preview
    const t = TERMINAL_THEMES[themeKey] || {};
    const headerPreview = document.getElementById('settings-theme-header').querySelector('div:last-child');
    const dots = [t.red, t.green, t.blue, t.yellow, t.magenta, t.cyan].filter(Boolean)
      .map(c => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:2px;"></span>`).join('');
    headerPreview.innerHTML = `<span style="display:flex;gap:1px;">${dots}</span><span style="font-size:12px;color:var(--text-muted);">${t.name}</span><span id="settings-theme-arrow" style="font-size:10px;color:var(--text-muted);transform:rotate(90deg);transition:transform 0.2s;">▶</span>`;
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
        <span style="min-width:16px;text-align:center;font-size:12px;">${isSel ? '✓' : ''}</span>
        <span style="font-size:13px;font-family:'${font}',monospace;">${font}</span>
      </div>`;
    }
    fontList.innerHTML = html || '<div style="font-size:12px;color:var(--text-muted);padding:6px;">No matching fonts</div>';
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
    headerPreview.innerHTML = `<span style="font-size:12px;color:var(--text-muted);font-family:'${fontName}',monospace;">${fontName}</span><span id="settings-font-arrow" style="font-size:10px;color:var(--text-muted);transform:rotate(90deg);transition:transform 0.2s;">▶</span>`;
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
