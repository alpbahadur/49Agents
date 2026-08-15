import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db;

export function initDatabase() {
  // Ensure the data directory exists
  const dbDir = dirname(resolve(config.dbPath));
  mkdirSync(dbDir, { recursive: true });

  db = new Database(config.dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Read and execute the schema
  const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  // Migrations for existing databases
  try {
    db.prepare("ALTER TABLE user_preferences ADD COLUMN hud_state TEXT NOT NULL DEFAULT '{}'").run();
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    db.prepare("ALTER TABLE user_preferences ADD COLUMN auto_remove_done INTEGER NOT NULL DEFAULT 0").run();
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    db.prepare("ALTER TABLE user_preferences ADD COLUMN tutorials_completed TEXT NOT NULL DEFAULT '{}'").run();
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    db.prepare("ALTER TABLE notes ADD COLUMN images TEXT NOT NULL DEFAULT '[]'").run();
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: Add google_id column and relax github_id NOT NULL for multi-provider auth
  try {
    db.prepare('SELECT google_id FROM users LIMIT 1').get();
  } catch (e) {
    // google_id column doesn't exist — run table migration
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE users_new (
        id            TEXT PRIMARY KEY,
        github_id     INTEGER UNIQUE,
        github_login  TEXT,
        google_id     TEXT UNIQUE,
        email         TEXT,
        display_name  TEXT,
        avatar_url    TEXT,
        tier          TEXT NOT NULL DEFAULT 'pro',
        lemon_subscription_id TEXT,
        lemon_portal_url TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users_new (id, github_id, github_login, email, display_name, avatar_url, tier, created_at, updated_at)
        SELECT id, github_id, github_login, email, display_name, avatar_url, tier, created_at, updated_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
    db.pragma('foreign_keys = ON');
    console.log('[db] Migration: Added google_id column and relaxed github_id constraint');
  }

  // Migration: messages table
  try {
    db.prepare('SELECT id FROM messages LIMIT 1').get();
  } catch (e) {
    db.exec(`
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
    `);
    console.log('[db] Migration: Created messages table');
  }

  // Migration: UTM columns on page_views
  try {
    db.prepare("ALTER TABLE page_views ADD COLUMN utm_source TEXT").run();
  } catch (e) { /* already exists */ }
  try {
    db.prepare("ALTER TABLE page_views ADD COLUMN utm_medium TEXT").run();
  } catch (e) { /* already exists */ }
  try {
    db.prepare("ALTER TABLE page_views ADD COLUMN utm_campaign TEXT").run();
  } catch (e) { /* already exists */ }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_pv_utm_source ON page_views(utm_source)");
  } catch (e) { /* already exists */ }

  // Migration: utm_source column on users
  try {
    db.prepare("ALTER TABLE users ADD COLUMN utm_source TEXT").run();
  } catch (e) { /* already exists */ }

  // Migration: Rename stripe columns to lemon columns
  try {
    db.prepare('SELECT lemon_subscription_id FROM users LIMIT 1').get();
  } catch (e) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE users_new (
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
        is_guest      INTEGER NOT NULL DEFAULT 0,
        guest_started_at TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users_new (id, github_id, github_login, google_id, email, display_name, avatar_url, tier, utm_source, is_guest, guest_started_at, created_at, updated_at)
        SELECT id, github_id, github_login, google_id, email, display_name, avatar_url, tier, utm_source,
          COALESCE(is_guest, 0), guest_started_at, created_at, updated_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
    db.pragma('foreign_keys = ON');
    console.log('[db] Migration: Renamed stripe columns to lemon columns');
  }

  // Migration: guest mode columns on users
  try {
    db.prepare("ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0").run();
  } catch (e) { /* already exists */ }
  try {
    db.prepare("ALTER TABLE users ADD COLUMN guest_started_at TEXT").run();
  } catch (e) { /* already exists */ }

  // Migration: display_name column on agents
  try {
    db.prepare("ALTER TABLE agents ADD COLUMN display_name TEXT").run();
  } catch (e) { /* already exists */ }

  // Migration: recent_pane_contexts table
  try {
    db.prepare('SELECT id FROM recent_pane_contexts LIMIT 1').get();
  } catch (e) {
    db.exec(`
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
    `);
    console.log('[db] Migration: Created recent_pane_contexts table');
  }

  // Migration: projects column on user_preferences
  try {
    db.prepare("ALTER TABLE user_preferences ADD COLUMN projects TEXT NOT NULL DEFAULT '[]'").run();
    console.log('[db] Migration: Added projects column to user_preferences');
  } catch (e) { /* already exists */ }

  // Migration: canvas preferences that were only ever held client-side
  try {
    db.prepare("ALTER TABLE user_preferences ADD COLUMN focus_mode TEXT NOT NULL DEFAULT 'hover'").run();
    console.log('[db] Migration: Added focus_mode column to user_preferences');
  } catch (e) { /* already exists */ }
  try {
    db.prepare('ALTER TABLE user_preferences ADD COLUMN teleport_animation INTEGER NOT NULL DEFAULT 1').run();
    console.log('[db] Migration: Added teleport_animation column to user_preferences');
  } catch (e) { /* already exists */ }
  try {
    db.prepare("ALTER TABLE user_preferences ADD COLUMN projects_sidebar_position TEXT NOT NULL DEFAULT 'right'").run();
    console.log('[db] Migration: Added projects_sidebar_position column to user_preferences');
  } catch (e) { /* already exists */ }

  // Migration: notifications tables
  try {
    db.prepare('SELECT id FROM notifications LIMIT 1').get();
  } catch (e) {
    db.exec(`
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
    `);
    console.log('[db] Migration: Created notifications tables');
  }

  console.log(`[db] SQLite database initialized at ${config.dbPath}`);
  return db;
}

export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}
