import { getDb } from './index.js';

const DEFAULTS = {
  night_mode: 0,
  terminal_theme: 'default',
  notification_sound: 1,
  auto_remove_done: 0,
  canvas_bg: 'default',
  snooze_duration: 90,
  terminal_font: 'JetBrains Mono',
  hud_state: '{}',
  tutorials_completed: '{}',
  projects: '[]',
  focus_mode: 'hover',
  teleport_animation: 1,
  projects_sidebar_position: 'right',
  beads_button_enabled: 0,
  pane_naming_enabled: 1,
  pane_number_hotkeys_enabled: 1,
};

export function getPreferences(userId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId);
  return row || { user_id: userId, ...DEFAULTS };
}

export function savePreferences(userId, prefs) {
  const db = getDb();
  db.prepare(`
    INSERT INTO user_preferences (user_id, night_mode, terminal_theme, notification_sound, auto_remove_done, canvas_bg, snooze_duration, terminal_font, hud_state, tutorials_completed, projects, focus_mode, teleport_animation, projects_sidebar_position, beads_button_enabled, pane_naming_enabled, pane_number_hotkeys_enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      night_mode = excluded.night_mode,
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
      updated_at = datetime('now')
  `).run(
    userId,
    prefs.nightMode ? 1 : 0,
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
    prefs.paneNumberHotkeysEnabled === false ? 0 : 1
  );
}
