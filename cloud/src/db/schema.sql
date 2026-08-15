CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  github_id     INTEGER UNIQUE,
  github_login  TEXT,
  google_id     TEXT UNIQUE,
  email         TEXT,
  display_name  TEXT,
  avatar_url    TEXT,
  tier          TEXT NOT NULL DEFAULT 'pro',
  utm_source    TEXT,
  lemon_subscription_id TEXT,
  lemon_portal_url TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hostname      TEXT NOT NULL,
  display_name  TEXT,
  os            TEXT,
  version       TEXT,
  token_hash    TEXT NOT NULL,
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, hostname)
);
CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id);

CREATE TABLE IF NOT EXISTS pane_layouts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id      TEXT REFERENCES agents(id) ON DELETE SET NULL,
  pane_type     TEXT NOT NULL,
  position_x    REAL NOT NULL DEFAULT 0,
  position_y    REAL NOT NULL DEFAULT 0,
  width         REAL NOT NULL DEFAULT 600,
  height        REAL NOT NULL DEFAULT 400,
  z_index       INTEGER NOT NULL DEFAULT 0,
  metadata      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_layouts_user ON pane_layouts(user_id);

CREATE TABLE IF NOT EXISTS notes (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content       TEXT NOT NULL DEFAULT '',
  font_size     INTEGER NOT NULL DEFAULT 14,
  images        TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id);

CREATE TABLE IF NOT EXISTS view_state (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  zoom          REAL NOT NULL DEFAULT 1.0,
  pan_x         REAL NOT NULL DEFAULT 0,
  pan_y         REAL NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  night_mode         INTEGER NOT NULL DEFAULT 0,
  terminal_theme     TEXT NOT NULL DEFAULT 'default',
  notification_sound INTEGER NOT NULL DEFAULT 1,
  auto_remove_done   INTEGER NOT NULL DEFAULT 0,
  canvas_bg          TEXT NOT NULL DEFAULT 'default',
  snooze_duration    INTEGER NOT NULL DEFAULT 90,
  terminal_font      TEXT NOT NULL DEFAULT 'JetBrains Mono',
  hud_state          TEXT NOT NULL DEFAULT '{}',
  tutorials_completed TEXT NOT NULL DEFAULT '{}',
  projects           TEXT NOT NULL DEFAULT '[]',
  focus_mode         TEXT NOT NULL DEFAULT 'hover',
  teleport_animation INTEGER NOT NULL DEFAULT 1,
  projects_sidebar_position TEXT NOT NULL DEFAULT 'right',
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS page_views (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  path          TEXT NOT NULL,
  referrer      TEXT,
  user_agent    TEXT,
  browser       TEXT,
  os            TEXT,
  screen_width  INTEGER,
  screen_height INTEGER,
  ip            TEXT,
  hostname      TEXT,
  session_id    TEXT,
  user_id       TEXT,
  utm_source    TEXT,
  utm_medium    TEXT,
  utm_campaign  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pv_created ON page_views(created_at);
CREATE INDEX IF NOT EXISTS idx_pv_hostname ON page_views(hostname);
CREATE INDEX IF NOT EXISTS idx_pv_path ON page_views(path);
-- idx_pv_utm_source created in migration (index.js) to avoid ordering issues

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type    TEXT NOT NULL,
  user_id       TEXT,
  metadata      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_events_user_created ON events(user_id, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender     TEXT NOT NULL CHECK(sender IN ('user', 'admin')),
  body       TEXT NOT NULL,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_user_sender_read ON messages(user_id, sender, read_at);

CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
  message       TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'info' CHECK(type IN ('info', 'warning', 'error')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);

CREATE TABLE IF NOT EXISTS notification_dismissals (
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dismissed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (notification_id, user_id)
);

CREATE TABLE IF NOT EXISTS recent_pane_contexts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  pane_type  TEXT NOT NULL,
  context    TEXT NOT NULL,
  label      TEXT,
  used_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, agent_id, pane_type, context)
);
CREATE INDEX IF NOT EXISTS idx_recent_ctx_lookup ON recent_pane_contexts(user_id, agent_id, pane_type, used_at DESC);
