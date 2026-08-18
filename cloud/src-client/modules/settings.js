// ─── Preferences & Settings Modal ─────────────────────────────────────────
// User prefs (theme, font, canvas bg, night mode), settings modal UI,
// theme/font pickers, hotkeys reference.
//
// Canvas background and terminal font are owned here. Every other preference
// lives in app.js and is reached through the injected context, because a
// module cannot assign to an imported binding.

import { APP_VERSION, TERMINAL_FONTS, CANVAS_BACKGROUNDS } from './constants.js';
import { getTerminalFontFamily } from './utils.js';
import { setSoundEnabled as _setSoundEnabled } from './sounds.js';

let _ctx = null;

export function initSettingsDeps(ctx) { _ctx = ctx; }

let prefsSaveTimer = null;
let currentCanvasBg = 'default';
let currentTerminalFont = 'JetBrains Mono';

export function getCurrentCanvasBg() { return currentCanvasBg; }
export function getCurrentTerminalFont() { return currentTerminalFont; }

/**
 * Set the font without restyling existing terminals. Used when loading saved
 * preferences, which happens before any terminal has been created.
 */
export function setCurrentTerminalFont(fontName) { currentTerminalFont = fontName; }

export function getAllPrefs(overrides) {
  return {
    nightMode: !!document.getElementById('night-mode-overlay'),
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
    projectsSidebarPosition: _ctx.getProjectsSidebarPosition(),
    teleportAnimation: _ctx.getTeleportAnimation(),
    beadsButtonEnabled: _ctx.getBeadsButtonEnabled(),
    paneNamingEnabled: _ctx.getPaneNamingEnabled(),
    paneNumberHotkeysEnabled: _ctx.getPaneNumberHotkeysEnabled(),
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

export function savePrefsToCloud(overrides) {
  if (prefsSaveTimer) clearTimeout(prefsSaveTimer);
  prefsSaveTimer = setTimeout(() => {
    _ctx.cloudFetch('PUT', '/api/preferences', getAllPrefs(overrides))
      .catch(e => console.error('[Prefs] Save failed:', e.message));
  }, 500);
}

export function setCanvasBackground(key) {
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

export function setNightMode(enabled) {
  let overlay = document.getElementById('night-mode-overlay');
  if (enabled && !overlay) {
    overlay = document.createElement('div');
    overlay.id = 'night-mode-overlay';
    document.body.appendChild(overlay);
  } else if (!enabled && overlay) {
    overlay.remove();
  }
}

/**
 * One settings row carrying a switch. The older rows in this modal spell the
 * same markup out inline; new ones go through here so the three pane-chrome
 * toggles below don't triple it again.
 */
function toggleRowHtml(id, label, description, on) {
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
      <div>
        <div style="font-size:13px;">${label}</div>
        <div style="font-size:11px;color:#6a6a8a;">${description}</div>
      </div>
      <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;">
        <input type="checkbox" id="${id}" ${on ? 'checked' : ''} style="opacity:0;width:0;height:0;">
        <span style="position:absolute;inset:0;background:${on ? 'rgba(var(--accent-rgb),0.5)' : 'rgba(255,255,255,0.1)'};border-radius:11px;transition:0.2s;"></span>
        <span style="position:absolute;top:2px;left:${on ? '20px' : '2px'};width:18px;height:18px;background:#fff;border-radius:50%;transition:0.2s;"></span>
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
    track.style.background = on ? 'rgba(var(--accent-rgb),0.5)' : 'rgba(255,255,255,0.1)';
    knob.style.left = on ? '20px' : '2px';
    apply(on);
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
  const projectsSidebarPosition = _ctx.getProjectsSidebarPosition();
  const snoozeDurationMs = _ctx.getSnoozeDurationMs();

  _ctx.telemetry.track('feature.settings_open');
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
${toggleRowHtml('settings-pane-naming-toggle', 'Pane Names', 'Show the editable name field in pane headers', paneNamingEnabled)}
${toggleRowHtml('settings-pane-hotkeys-toggle', 'Pane Number Hotkeys', 'Number badges in headers, and Tab+1..9 to jump', paneNumberHotkeysEnabled)}
${toggleRowHtml('settings-beads-btn-toggle', 'Beads Issue Button', 'Tag panes with a beads issue from the header', beadsButtonEnabled)}

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
          <span id="settings-theme-arrow" style="font-size:10px;color:#6a6a8a;transition:transform 0.2s;">▶</span>
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
          <span id="settings-font-arrow" style="font-size:10px;color:#6a6a8a;transition:transform 0.2s;">▶</span>
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
        <span id="settings-hotkeys-arrow" style="font-size:10px;color:#6a6a8a;transition:transform 0.2s;">▶</span>
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
    _ctx.setNotificationSoundEnabled(on);
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
    _ctx.setAutoRemoveDoneNotifs(on);
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
    const mode = hover ? 'hover' : 'click';
    _ctx.setFocusMode(mode);
    const track = focusModeToggle.nextElementSibling;
    const knob = track.nextElementSibling;
    track.style.background = hover ? 'rgba(var(--accent-rgb),0.5)' : 'rgba(255,255,255,0.1)';
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
    track.style.background = on ? 'rgba(var(--accent-rgb),0.5)' : 'rgba(255,255,255,0.1)';
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
  bindToggleRow('settings-beads-btn-toggle', (on) => {
    _ctx.setBeadsButtonEnabled(on);
    savePrefsToCloud({ beadsButtonEnabled: on });
  });

  // Sidebar position buttons
  document.querySelectorAll('.settings-sidebar-pos-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pos = btn.dataset.pos;
      _ctx.setProjectsSidebarPosition(pos);
      // Update button styles
      document.querySelectorAll('.settings-sidebar-pos-btn').forEach(b => {
        const isSel = b.dataset.pos === pos;
        b.style.borderColor = isSel ? 'rgba(var(--accent-rgb),0.4)' : 'rgba(255,255,255,0.08)';
        b.style.background = isSel ? 'rgba(var(--accent-rgb),0.2)' : 'transparent';
        b.style.color = isSel ? '#fff' : '#8b8bb0';
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
      const isSel = key === _ctx.getCurrentTerminalTheme();
      const dots = [t.red, t.green, t.blue, t.yellow, t.magenta, t.cyan].filter(Boolean)
        .map(c => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:2px;"></span>`).join('');
      html += `<div class="settings-theme-item" data-theme="${key}" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;cursor:pointer;background:${isSel ? 'rgba(var(--accent-rgb),0.2)' : 'transparent'};border:1px solid ${isSel ? 'rgba(var(--accent-rgb),0.4)' : 'transparent'};transition:all 0.15s ease;">
        <span style="min-width:16px;text-align:center;font-size:12px;">${isSel ? '✓' : ''}</span>
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
    _ctx.applyTerminalTheme(themeKey);
    _ctx.telemetry.track('feature.theme_change', { theme_name: themeKey });
    renderThemeList(themeSearch.value);
    // Update collapsed preview
    const t = TERMINAL_THEMES[themeKey] || {};
    const headerPreview = document.getElementById('settings-theme-header').querySelector('div:last-child');
    const dots = [t.red, t.green, t.blue, t.yellow, t.magenta, t.cyan].filter(Boolean)
      .map(c => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:2px;"></span>`).join('');
    headerPreview.innerHTML = `<span style="display:flex;gap:1px;">${dots}</span><span style="font-size:12px;color:#6a6a8a;">${t.name}</span><span id="settings-theme-arrow" style="font-size:10px;color:#6a6a8a;transform:rotate(90deg);transition:transform 0.2s;">▶</span>`;
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
    headerPreview.innerHTML = `<span style="font-size:12px;color:#6a6a8a;font-family:'${fontName}',monospace;">${fontName}</span><span id="settings-font-arrow" style="font-size:10px;color:#6a6a8a;transform:rotate(90deg);transition:transform 0.2s;">▶</span>`;
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
