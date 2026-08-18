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
 * The pane-header affordances are per-user settings, so their defaults live
 * in the schema. Only pane naming defaults ON — it is how panes are labelled.
 * Beads, the number badges and the new-tab button all default OFF: each is
 * either meaningless without a matching workflow or an icon a new user has no
 * reason to recognise, and the point of the defaults is a quiet header.
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
                       pane_number_hotkeys_enabled AS hotkeys,
                       new_tab_button_enabled AS newtab,
                       pane_header_order AS headerOrder
                FROM user_preferences WHERE user_id = 'u1'`;

test('a preferences row defaults to a quiet header, naming aside', () => {
  withDb((db) => {
    db.prepare("INSERT INTO user_preferences (user_id) VALUES ('u1')").run();
    const row = db.prepare(SELECT).get();
    assert.equal(row.beads, 0);
    assert.equal(row.naming, 1);
    assert.equal(row.hotkeys, 0);
    assert.equal(row.newtab, 0);
    assert.equal(row.headerOrder, '[]', 'an empty order means "use the built-in one"');
  });
});

test('each toggle round trips independently', () => {
  withDb((db) => {
    db.prepare(`INSERT INTO user_preferences
      (user_id, beads_button_enabled, pane_naming_enabled, pane_number_hotkeys_enabled, new_tab_button_enabled)
      VALUES ('u1', 1, 0, 1, 1)`).run();
    const row = db.prepare(SELECT).get();
    assert.equal(row.beads, 1);
    assert.equal(row.naming, 0);
    assert.equal(row.hotkeys, 1);
    assert.equal(row.newtab, 1);
  });
});

test('a custom header order round trips as JSON', () => {
  withDb((db) => {
    const order = JSON.stringify(['zoom', 'reload', 'shortcut', 'newtab', 'beads']);
    db.prepare("INSERT INTO user_preferences (user_id, pane_header_order) VALUES ('u1', ?)").run(order);
    assert.deepEqual(JSON.parse(db.prepare(SELECT).get().headerOrder), JSON.parse(order));
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
    // The hotkeys column shipped defaulting to 1 and only later changed to 0
    // for new rows, so this ALTER keeps its original default: an existing user
    // keeps the badges they already had.
    db.prepare('ALTER TABLE user_preferences ADD COLUMN pane_number_hotkeys_enabled INTEGER NOT NULL DEFAULT 1').run();
    db.prepare('ALTER TABLE user_preferences ADD COLUMN new_tab_button_enabled INTEGER NOT NULL DEFAULT 0').run();
    db.prepare("ALTER TABLE user_preferences ADD COLUMN pane_header_order TEXT NOT NULL DEFAULT '[]'").run();

    const row = db.prepare(SELECT).get();
    assert.equal(row.beads, 0, 'an existing user should not suddenly grow a beads button');
    assert.equal(row.naming, 1);
    assert.equal(row.hotkeys, 1, 'and keeps the number badges they already had');
    assert.equal(row.newtab, 0);
  });
});
