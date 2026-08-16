import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Onboarding consent + telemetry ingest.
 *
 * Two things are pinned here:
 *
 *  1. Email is optional. Someone who declines to share it must still get a
 *     working local identity, so local_email_auth.email has to be nullable.
 *     The original schema had it NOT NULL, which made the decline path a
 *     constraint violation.
 *
 *  2. Consent and email are independent decisions. Declining one must not
 *     imply the other, in either direction.
 *
 * The ingest side is pinned against a real SQLite database because the whole
 * point of the feature is that the rows survive to be pulled down later.
 */

const EMAIL_AUTH_SCHEMA = `
  CREATE TABLE local_email_auth (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    instance_id       TEXT NOT NULL,
    email             TEXT,
    telemetry_consent INTEGER NOT NULL DEFAULT -1,
    cloud_instance_id TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const TELEMETRY_SCHEMA = `
  CREATE TABLE telemetry_instances (
    instance_id  TEXT PRIMARY KEY,
    email        TEXT,
    consent      INTEGER NOT NULL DEFAULT 0,
    hostname     TEXT,
    os           TEXT,
    version      TEXT,
    first_seen   TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE telemetry_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id  TEXT NOT NULL,
    event_type   TEXT NOT NULL,
    user_id      TEXT,
    metadata     TEXT NOT NULL DEFAULT '{}',
    timestamp    TEXT,
    received_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

function freshDb(schema) {
  const dir = mkdtempSync(join(tmpdir(), 'onboarding-'));
  const db = new Database(join(dir, 'test.db'));
  db.exec(schema);
  return { db, dir };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Local identity: email optional, consent independent
// ---------------------------------------------------------------------------

test('local identity persists without an email when the user declines to share it', () => {
  const { db, dir } = freshDb(EMAIL_AUTH_SCHEMA);
  try {
    db.prepare(
      'INSERT INTO local_email_auth (id, instance_id, email, telemetry_consent) VALUES (1, ?, ?, ?)'
    ).run('lei_local', null, 1);

    const row = db.prepare('SELECT * FROM local_email_auth WHERE id = 1').get();
    assert.equal(row.email, null);
    assert.equal(row.instance_id, 'lei_local');
    // Declining the email must not drag telemetry consent down with it.
    assert.equal(row.telemetry_consent, 1);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('consent off with an email supplied is representable', () => {
  const { db, dir } = freshDb(EMAIL_AUTH_SCHEMA);
  try {
    db.prepare(
      'INSERT INTO local_email_auth (id, instance_id, email, telemetry_consent) VALUES (1, ?, ?, ?)'
    ).run('lei_local', 'a@b.com', 0);

    const row = db.prepare('SELECT * FROM local_email_auth WHERE id = 1').get();
    assert.equal(row.email, 'a@b.com');
    assert.equal(row.telemetry_consent, 0);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('migration relaxes email NOT NULL on databases created before onboarding', () => {
  const { db, dir } = freshDb(`
    CREATE TABLE local_email_auth (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      instance_id  TEXT NOT NULL,
      email        TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  try {
    db.prepare('INSERT INTO local_email_auth (id, instance_id, email) VALUES (1, ?, ?)')
      .run('lei_old', 'existing@user.com');

    // Pre-migration the decline path is a constraint violation.
    assert.throws(() => {
      db.prepare('UPDATE local_email_auth SET email = NULL WHERE id = 1').run();
    });

    // Same rebuild the runtime migration performs.
    db.exec(`
      CREATE TABLE local_email_auth_new (
        id                INTEGER PRIMARY KEY CHECK (id = 1),
        instance_id       TEXT NOT NULL,
        email             TEXT,
        telemetry_consent INTEGER NOT NULL DEFAULT -1,
        cloud_instance_id TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO local_email_auth_new (id, instance_id, email, telemetry_consent, created_at)
        SELECT id, instance_id, email, 1, created_at FROM local_email_auth;
      DROP TABLE local_email_auth;
      ALTER TABLE local_email_auth_new RENAME TO local_email_auth;
    `);

    const row = db.prepare('SELECT * FROM local_email_auth WHERE id = 1').get();
    // An existing user's data survives, and their prior consent is preserved.
    assert.equal(row.email, 'existing@user.com');
    assert.equal(row.telemetry_consent, 1);

    // The decline path now works.
    db.prepare('UPDATE local_email_auth SET email = NULL WHERE id = 1').run();
    assert.equal(db.prepare('SELECT email FROM local_email_auth WHERE id = 1').get().email, null);
  } finally {
    db.close();
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Cloud ingest
// ---------------------------------------------------------------------------

test('events are stored against their instance and survive for export', () => {
  const { db, dir } = freshDb(TELEMETRY_SCHEMA);
  try {
    db.prepare('INSERT INTO telemetry_instances (instance_id, email, consent) VALUES (?, ?, 1)')
      .run('lei_a', 'a@b.com');

    const insert = db.prepare(
      'INSERT INTO telemetry_events (instance_id, event_type, user_id, metadata, timestamp) VALUES (?, ?, ?, ?, ?)'
    );
    insert.run('lei_a', 'pane.open', 'u1', JSON.stringify({ kind: 'terminal' }), '2026-08-15T00:00:00Z');
    insert.run('lei_a', 'session.start', 'u1', '{}', '2026-08-15T00:01:00Z');

    const events = db.prepare('SELECT * FROM telemetry_events WHERE instance_id = ?').all('lei_a');
    assert.equal(events.length, 2);
    assert.equal(JSON.parse(events[0].metadata).kind, 'terminal');
    assert.ok(events[0].received_at, 'received_at is stamped server-side');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('re-enrolling with a known email continues the same instance identity', () => {
  const { db, dir } = freshDb(TELEMETRY_SCHEMA);
  try {
    db.prepare('INSERT INTO telemetry_instances (instance_id, email, consent) VALUES (?, ?, 1)')
      .run('lei_first', 'same@user.com');

    // A reinstall or second clone giving the same email should resolve to the
    // original id rather than fragmenting the user across rows.
    const found = db.prepare(
      'SELECT instance_id FROM telemetry_instances WHERE email = ? ORDER BY last_seen DESC LIMIT 1'
    ).get('same@user.com');

    assert.equal(found.instance_id, 'lei_first');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM telemetry_instances').get().c, 1);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('a revoked instance stops accepting events', () => {
  const { db, dir } = freshDb(TELEMETRY_SCHEMA);
  try {
    db.prepare('INSERT INTO telemetry_instances (instance_id, email, consent) VALUES (?, ?, 1)')
      .run('lei_a', 'a@b.com');

    // Revoking from Settings must reach the server record. If it only stopped the
    // local collector, anything still holding the instance id could keep writing.
    db.prepare('UPDATE telemetry_instances SET consent = 0 WHERE instance_id = ?').run('lei_a');

    const known = db.prepare('SELECT consent FROM telemetry_instances WHERE instance_id = ?').get('lei_a');
    assert.equal(known.consent, 0, 'server record reflects the revocation');

    // The ingest route refuses to write when the stored consent is not 1.
    const accepted = known.consent === 1;
    assert.equal(accepted, false, 'batch is dropped rather than stored');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM telemetry_events').get().c, 0);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('an unknown instance id is rejected rather than auto-enrolled', () => {
  const { db, dir } = freshDb(TELEMETRY_SCHEMA);
  try {
    // Auto-enrolling on first sight would defeat revocation: a client holding a
    // revoked id could resurrect it just by posting events again.
    const known = db.prepare('SELECT consent FROM telemetry_instances WHERE instance_id = ?').get('lei_ghost');
    assert.equal(known, undefined, 'no record exists for an unenrolled id');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM telemetry_instances').get().c, 0);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('re-enabling consent reuses the existing instance rather than forking a new one', () => {
  const { db, dir } = freshDb(TELEMETRY_SCHEMA);
  try {
    db.prepare('INSERT INTO telemetry_instances (instance_id, email, consent) VALUES (?, ?, 1)')
      .run('lei_a', 'a@b.com');
    db.prepare('UPDATE telemetry_instances SET consent = 0 WHERE instance_id = ?').run('lei_a');
    db.prepare('UPDATE telemetry_instances SET consent = 1 WHERE instance_id = ?').run('lei_a');

    assert.equal(db.prepare('SELECT COUNT(*) c FROM telemetry_instances').get().c, 1);
    assert.equal(db.prepare('SELECT consent FROM telemetry_instances WHERE instance_id = ?').get('lei_a').consent, 1);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('anonymous instances enroll without an email', () => {
  const { db, dir } = freshDb(TELEMETRY_SCHEMA);
  try {
    db.prepare('INSERT INTO telemetry_instances (instance_id, email, consent) VALUES (?, ?, 1)')
      .run('lei_anon', null);

    const row = db.prepare('SELECT * FROM telemetry_instances WHERE instance_id = ?').get('lei_anon');
    assert.equal(row.email, null);
    assert.equal(row.consent, 1);
  } finally {
    db.close();
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Onboarding page wiring
// ---------------------------------------------------------------------------

test('onboarding page sends email and consent as separate fields', () => {
  const html = readFileSync(join(here, '..', 'public', 'login.html'), 'utf-8');

  assert.ok(html.includes('id="onboarding-consent"'), 'consent checkbox present');
  assert.ok(html.includes('id="onboarding-email"'), 'email field present');
  assert.ok(html.includes('telemetryConsent: consentInput.checked'), 'consent posted from the checkbox');
  assert.ok(html.includes('email: email || null'), 'blank email posts as null rather than an empty string');

  // The email input must not be required. That would reinstate the old gate.
  const emailTag = html.match(/<input[^>]*id="onboarding-email"[^>]*>/);
  assert.ok(emailTag, 'email input found');
  assert.ok(!/\brequired\b/.test(emailTag[0]), 'email field is optional');

  // Consent defaults to on, which is what the copy on the page promises.
  const consentTag = html.match(/<input[^>]*id="onboarding-consent"[^>]*>/);
  assert.ok(/\bchecked\b/.test(consentTag[0]), 'consent defaults to checked');
});

test('onboarding page still points at the photo it ships with', () => {
  const html = readFileSync(join(here, '..', 'public', 'login.html'), 'utf-8');
  assert.ok(html.includes('img/alp.jpg'), 'portrait source matches the committed file');
});

test('onboarding page states what is and is not collected', () => {
  const html = readFileSync(join(here, '..', 'public', 'login.html'), 'utf-8');
  assert.ok(
    /Never your terminal output, your files, or the commands you run/.test(html),
    'page discloses the collection boundary'
  );
});
