import { getDb } from './index.js';

const DEFAULTS = {
  night_mode: 0,
  app_theme: 'system',
  starter_terminal_created: 0,
  terminal_theme: 'default',
  notification_sound: 1,
  auto_remove_done: 0,
  canvas_bg: 'default',
  snooze_duration: 90,
  terminal_font: 'JetBrains Mono',
  hud_state: '{}',
  tutorials_completed: '{}',
  projects: '[]',
  // Null, not 'hover': a user with no row has never chosen, and the client
  // picks a device-appropriate default for that case — click focus on a
  // touch-primary device, where hover focus fires on every tap. Sending
  // 'hover' here made that branch unreachable.
  focus_mode: null,
  teleport_animation: 1,
  projects_sidebar_position: 'right',
  beads_button_enabled: 0,
  pane_naming_enabled: 1,
  pane_number_hotkeys_enabled: 0,
  new_tab_button_enabled: 0,
  pane_header_order: '[]',
  view_mode: 'canvas',
  view_mode_hotkey_enabled: 1,
  view_mode_toggle_visible: 1,
};

export function getPreferences(userId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId);
  return row || { user_id: userId, ...DEFAULTS };
}

export function savePreferences(userId, prefs) {
  const db = getDb();
  db.prepare(`
    INSERT INTO user_preferences (user_id, night_mode, app_theme, starter_terminal_created, terminal_theme, notification_sound, auto_remove_done, canvas_bg, snooze_duration, terminal_font, hud_state, tutorials_completed, projects, focus_mode, teleport_animation, projects_sidebar_position, beads_button_enabled, pane_naming_enabled, pane_number_hotkeys_enabled, new_tab_button_enabled, pane_header_order, view_mode, view_mode_hotkey_enabled, view_mode_toggle_visible, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      night_mode = excluded.night_mode,
      app_theme = excluded.app_theme,
      starter_terminal_created = excluded.starter_terminal_created,
      terminal_theme = excluded.terminal_theme,
      notification_sound = excluded.notification_sound,
      auto_remove_done = excluded.auto_remove_done,
      canvas_bg = excluded.canvas_bg,
      snooze_duration = excluded.snooze_duration,
      terminal_font = excluded.terminal_font,
      hud_state = excluded.hud_state,
      tutorials_completed = excluded.tutorials_completed,
      projects = excluded.projects,
      focus_mode = excluded.focus_mode,
      teleport_animation = excluded.teleport_animation,
      projects_sidebar_position = excluded.projects_sidebar_position,
      beads_button_enabled = excluded.beads_button_enabled,
      pane_naming_enabled = excluded.pane_naming_enabled,
      pane_number_hotkeys_enabled = excluded.pane_number_hotkeys_enabled,
      new_tab_button_enabled = excluded.new_tab_button_enabled,
      pane_header_order = excluded.pane_header_order,
      view_mode = excluded.view_mode,
      view_mode_hotkey_enabled = excluded.view_mode_hotkey_enabled,
      view_mode_toggle_visible = excluded.view_mode_toggle_visible,
      updated_at = datetime('now')
  `).run(
    userId,
    prefs.nightMode ? 1 : 0,
    prefs.appTheme || 'system',
    prefs.starterTerminalCreated ? 1 : 0,
    prefs.terminalTheme || 'default',
    prefs.notificationSound ? 1 : 0,
    prefs.autoRemoveDone ? 1 : 0,
    prefs.canvasBg || 'default',
    prefs.snoozeDuration ?? 90,
    prefs.terminalFont || 'JetBrains Mono',
    prefs.hudState ? JSON.stringify(prefs.hudState) : '{}',
    prefs.tutorialsCompleted ? JSON.stringify(prefs.tutorialsCompleted) : '{}',
    prefs.projects ? JSON.stringify(prefs.projects) : '[]',
    prefs.focusMode || 'hover',
    prefs.teleportAnimation === false ? 0 : 1,
    prefs.projectsSidebarPosition || 'right',
    prefs.beadsButtonEnabled ? 1 : 0,
    prefs.paneNamingEnabled === false ? 0 : 1,
    prefs.paneNumberHotkeysEnabled ? 1 : 0,
    prefs.newTabButtonEnabled ? 1 : 0,
    prefs.paneHeaderOrder ? JSON.stringify(prefs.paneHeaderOrder) : '[]',
    prefs.viewMode === 'list' ? 'list' : 'canvas',
    prefs.viewModeHotkeyEnabled === false ? 0 : 1,
    prefs.viewModeToggleVisible === false ? 0 : 1
  );
}
