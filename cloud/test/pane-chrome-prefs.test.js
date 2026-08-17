import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, '..', 'src', 'db', 'schema.sql'), 'utf-8');

/**
 * The three pane-header affordances (beads button, pane naming, number
 * hotkeys) are per-user settings, so their defaults live in the schema. Beads
 * is the odd one out: it defaults OFF, because an unexplained icon in every
 * header is noise for anyone who does not run beads. The other two default ON
 * — they are how panes are labelled and reached.
 *
 * A row written before these columns existed reads back as the column default
 * rather than NULL, which is what keeps existing users' headers unchanged.
 */
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'pane-chrome-prefs-'));
  const db = new Database(join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  db.prepare("INSERT INTO users (id, email, display_name) VALUES ('u1', 'a@b.com', 'A')").run();
  return { db, dir };
}

function withDb(fn) {
  const { db, dir } = freshDb();
  try {
    fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const SELECT = `SELECT beads_button_enabled AS beads,
                       pane_naming_enabled AS naming,
                       pane_number_hotkeys_enabled AS hotkeys
                FROM user_preferences WHERE user_id = 'u1'`;

test('a preferences row defaults beads off and naming/hotkeys on', () => {
  withDb((db) => {
    db.prepare("INSERT INTO user_preferences (user_id) VALUES ('u1')").run();
    const row = db.prepare(SELECT).get();
    assert.equal(row.beads, 0);
    assert.equal(row.naming, 1);
    assert.equal(row.hotkeys, 1);
  });
});

test('each toggle round trips independently', () => {
  withDb((db) => {
    db.prepare(`INSERT INTO user_preferences
      (user_id, beads_button_enabled, pane_naming_enabled, pane_number_hotkeys_enabled)
      VALUES ('u1', 1, 0, 1)`).run();
    const row = db.prepare(SELECT).get();
    assert.equal(row.beads, 1);
    assert.equal(row.naming, 0);
    assert.equal(row.hotkeys, 1);
  });
});

test('the columns are NOT NULL, so a save can never blank a toggle', () => {
  withDb((db) => {
    db.prepare("INSERT INTO user_preferences (user_id) VALUES ('u1')").run();
    assert.throws(
      () => db.prepare("UPDATE user_preferences SET pane_naming_enabled = NULL WHERE user_id = 'u1'").run(),
      /NOT NULL/,
    );
  });
});

test('the migration backfills existing rows with the same defaults', () => {
  withDb((db) => {
    // Rebuild the pre-migration shape, insert a row, then run the ALTERs the
    // way src/db/index.js does on startup.
    db.exec('DROP TABLE user_preferences');
    db.exec(`CREATE TABLE user_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.prepare("INSERT INTO user_preferences (user_id) VALUES ('u1')").run();

    db.prepare('ALTER TABLE user_preferences ADD COLUMN beads_button_enabled INTEGER NOT NULL DEFAULT 0').run();
    db.prepare('ALTER TABLE user_preferences ADD COLUMN pane_naming_enabled INTEGER NOT NULL DEFAULT 1').run();
    db.prepare('ALTER TABLE user_preferences ADD COLUMN pane_number_hotkeys_enabled INTEGER NOT NULL DEFAULT 1').run();

    const row = db.prepare(SELECT).get();
    assert.equal(row.beads, 0, 'an existing user should not suddenly grow a beads button');
    assert.equal(row.naming, 1);
    assert.equal(row.hotkeys, 1);
  });
});
