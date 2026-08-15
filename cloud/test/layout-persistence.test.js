import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, '..', 'src', 'db', 'schema.sql'), 'utf-8');

/**
 * pane_layouts.agent_id references agents(id). Dev mode mints a synthetic
 * agent ID without going through the pairing routes that populate that
 * table, so before this fix every layout save from a local instance failed
 * the foreign key and no pane position was ever persisted — which also took
 * tab groups with it, since they ride in the layout metadata.
 *
 * These tests pin the constraint rather than the fix, so they still describe
 * the requirement if the registration moves elsewhere.
 */
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'layout-persist-'));
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

test('a layout referencing an unregistered agent is rejected', () => {
  withDb((db) => {
    assert.throws(
      () => db.prepare('INSERT INTO pane_layouts (id, user_id, agent_id, pane_type) VALUES (?, ?, ?, ?)')
        .run('p1', 'u1', 'agent_dev_local_localhost-2800', 'terminal'),
      /FOREIGN KEY/,
    );
  });
});

test('a layout saves once its agent is registered', () => {
  withDb((db) => {
    db.prepare("INSERT INTO agents (id, user_id, hostname, token_hash) VALUES ('agent_dev_local', 'u1', 'host', 'dev')").run();
    db.prepare('INSERT INTO pane_layouts (id, user_id, agent_id, pane_type) VALUES (?, ?, ?, ?)')
      .run('p1', 'u1', 'agent_dev_local', 'terminal');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM pane_layouts').get().c, 1);
  });
});

test('tab group membership survives a layout round trip', () => {
  withDb((db) => {
    db.prepare("INSERT INTO agents (id, user_id, hostname, token_hash) VALUES ('agent_dev_local', 'u1', 'host', 'dev')").run();
    const metadata = JSON.stringify({ tabGroupId: 'tg-1', tabGroupActive: true });
    db.prepare('INSERT INTO pane_layouts (id, user_id, agent_id, pane_type, metadata) VALUES (?, ?, ?, ?, ?)')
      .run('p1', 'u1', 'agent_dev_local', 'terminal', metadata);

    const row = db.prepare('SELECT metadata FROM pane_layouts WHERE id = ?').get('p1');
    const parsed = JSON.parse(row.metadata);
    assert.equal(parsed.tabGroupId, 'tg-1');
    assert.equal(parsed.tabGroupActive, true);
  });
});

test('the canvas preferences have columns and sane defaults', () => {
  withDb((db) => {
    db.prepare('INSERT INTO user_preferences (user_id) VALUES (?)').run('u1');
    const row = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get('u1');

    // Sent by the client on every save; before this fix they had nowhere to go.
    assert.equal(row.focus_mode, 'hover');
    assert.equal(row.teleport_animation, 1);
    assert.equal(row.projects_sidebar_position, 'right');
  });
});

test('the canvas preferences persist non-default values', () => {
  withDb((db) => {
    db.prepare(`INSERT INTO user_preferences (user_id, focus_mode, teleport_animation, projects_sidebar_position)
                VALUES (?, ?, ?, ?)`).run('u1', 'click', 0, 'left');
    const row = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get('u1');
    assert.equal(row.focus_mode, 'click');
    assert.equal(row.teleport_animation, 0);
    assert.equal(row.projects_sidebar_position, 'left');
  });
});
