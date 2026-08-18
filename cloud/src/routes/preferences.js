import { requireAuth } from '../auth/middleware.js';
import { getPreferences, savePreferences } from '../db/preferences.js';

export function setupPreferencesRoutes(app) {

  app.get('/api/preferences', requireAuth, (req, res) => {
    const prefs = getPreferences(req.user.id);
    res.json({
      nightMode:          !!prefs.night_mode,
      terminalTheme:      prefs.terminal_theme,
      notificationSound:  !!prefs.notification_sound,
      autoRemoveDone:     !!prefs.auto_remove_done,
      canvasBg:           prefs.canvas_bg || 'default',
      snoozeDuration:     prefs.snooze_duration ?? 90,
      terminalFont:       prefs.terminal_font || 'JetBrains Mono',
      hudState:           prefs.hud_state ? JSON.parse(prefs.hud_state) : {},
      tutorialsCompleted: prefs.tutorials_completed ? JSON.parse(prefs.tutorials_completed) : {},
      projects:           prefs.projects ? JSON.parse(prefs.projects) : [],
      focusMode:          prefs.focus_mode || 'hover',
      teleportAnimation:  prefs.teleport_animation === undefined ? true : !!prefs.teleport_animation,
      projectsSidebarPosition: prefs.projects_sidebar_position || 'right',
      beadsButtonEnabled: !!prefs.beads_button_enabled,
      paneNamingEnabled: prefs.pane_naming_enabled === undefined ? true : !!prefs.pane_naming_enabled,
      paneNumberHotkeysEnabled: !!prefs.pane_number_hotkeys_enabled,
      newTabButtonEnabled: !!prefs.new_tab_button_enabled,
      paneHeaderOrder: prefs.pane_header_order ? JSON.parse(prefs.pane_header_order) : [],
    });
  });

  app.put('/api/preferences', requireAuth, (req, res) => {
    const {
      nightMode, terminalTheme, notificationSound, autoRemoveDone,
      canvasBg, snoozeDuration, terminalFont, hudState, tutorialsCompleted,
      projects, focusMode, teleportAnimation, projectsSidebarPosition,
      beadsButtonEnabled, paneNamingEnabled, paneNumberHotkeysEnabled,
      newTabButtonEnabled, paneHeaderOrder,
    } = req.body;
    savePreferences(req.user.id, {
      nightMode, terminalTheme, notificationSound, autoRemoveDone,
      canvasBg, snoozeDuration, terminalFont, hudState, tutorialsCompleted,
      projects, focusMode, teleportAnimation, projectsSidebarPosition,
      beadsButtonEnabled, paneNamingEnabled, paneNumberHotkeysEnabled,
      newTabButtonEnabled, paneHeaderOrder,
    });
    res.json({ ok: true });
  });
}
