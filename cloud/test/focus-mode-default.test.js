import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, '..', 'src', 'db', 'schema.sql'), 'utf-8');
const appJs = readFileSync(join(here, '..', 'src-client', 'app.js'), 'utf-8');
const routeJs = readFileSync(join(here, '..', 'src', 'routes', 'preferences.js'), 'utf-8');
const dbPrefsJs = readFileSync(join(here, '..', 'src', 'db', 'preferences.js'), 'utf-8');

/**
 * Hover focus fires on every tap on a touch device, so the client defaults to
 * click focus when it sees a coarse pointer. That branch only runs when the
 * server reports no stored choice, and it was unreachable: the route answered
 * `prefs.focus_mode || 'hover'`, which is always truthy, so the client always
 * took the stored-preference path and touch devices kept hover focus.
 *
 * "Never chosen" has to be representable end to end for the device default to
 * apply, which is what these tests pin.
 */
function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'focus-mode-'));
  const db = new Database(join(dir, 'test.db'));
  try {
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    db.prepare("INSERT INTO users (id, email, display_name) VALUES ('u1', 'a@b.com', 'A')").run();
    fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a user with no preferences row reports no focus mode choice', () => {
  withDb((db) => {
    const row = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get('u1');
    assert.equal(row, undefined);
  });

  // getPreferences falls back to DEFAULTS for that user, and the fallback must
  // leave focus mode unset rather than asserting hover on the user's behalf.
  assert.match(dbPrefsJs, /focus_mode: null/);
});

test('the route passes an absent focus mode through instead of defaulting it', () => {
  // The bug in one line: `|| 'hover'` here makes the client's device default
  // dead code, because the client only consults the device when this is falsy.
  assert.doesNotMatch(routeJs, /focusMode:\s*prefs\.focus_mode \|\| 'hover'/);
  assert.match(routeJs, /focusMode:\s*prefs\.focus_mode \|\| null/);
});

test('a stored choice still wins over the device default', () => {
  withDb((db) => {
    // A row written with an explicit choice must read back as that choice, so
    // someone who picked hover on a tablet keeps it.
    db.prepare("INSERT INTO user_preferences (user_id, focus_mode) VALUES ('u1', 'hover')").run();
    const row = db.prepare('SELECT focus_mode FROM user_preferences WHERE user_id = ?').get('u1');
    assert.equal(row.focus_mode, 'hover');
  });
});

test('the column keeps its hover default for rows that predate the choice', () => {
  withDb((db) => {
    // An insert that names no focus mode still lands on hover, which is what
    // keeps existing desktop users unchanged.
    db.prepare("INSERT INTO user_preferences (user_id) VALUES ('u1')").run();
    const row = db.prepare('SELECT focus_mode FROM user_preferences WHERE user_id = ?').get('u1');
    assert.equal(row.focus_mode, 'hover');
  });
});

test('the client consults the pointer type only when no choice is stored', () => {
  // Order matters: a stored preference has to be checked first, and the
  // coarse-pointer default reached only as the fallback.
  const block = appJs.slice(appJs.indexOf('if (prefs.focusMode)'));
  const guard = block.slice(0, 400);
  assert.match(guard, /if \(prefs\.focusMode\) \{\s*focusMode = prefs\.focusMode;/);
  assert.match(guard, /else if \(matchMedia\('\(pointer: coarse\)'\)\.matches\)/);
  assert.match(guard, /focusMode = 'click'/);
});
