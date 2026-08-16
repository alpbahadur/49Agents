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
// Onboarding modal wiring
//
// The modal lives in the app itself, not on the login page: it appears after
// ten minutes of use, by which point the user is already working.
// ---------------------------------------------------------------------------

function appHtml() {
  return readFileSync(join(here, '..', 'public', 'index.html'), 'utf-8');
}

test('onboarding modal sends email and consent as separate fields', () => {
  const html = appHtml();
  const js = readFileSync(join(here, '..', 'src-client', 'app.js'), 'utf-8');

  assert.ok(html.includes('id="onboarding-consent"'), 'consent checkbox present');
  assert.ok(html.includes('id="onboarding-email"'), 'email field present');
  assert.ok(js.includes('telemetryConsent: consentInput.checked'), 'consent posted from the checkbox');
  assert.ok(js.includes('email: email || null'), 'blank email posts as null rather than an empty string');

  // The email input must not be required. That would reinstate the old gate.
  const emailTag = html.match(/<input[^>]*id="onboarding-email"[^>]*>/);
  assert.ok(emailTag, 'email input found');
  assert.ok(!/\brequired\b/.test(emailTag[0]), 'email field is optional');

  // Consent defaults to on, which is what the copy in the modal promises.
  const consentTag = html.match(/<input[^>]*id="onboarding-consent"[^>]*>/);
  assert.ok(/\bchecked\b/.test(consentTag[0]), 'consent defaults to checked');
});

test('onboarding modal still points at the photo it ships with', () => {
  assert.ok(appHtml().includes('img/alp.jpg'), 'portrait source matches the committed file');
});

test('onboarding modal states what is and is not collected', () => {
  const html = appHtml();
  const detail = html.match(/<span class="consent-detail"[\s\S]*?<\/span>/)[0];

  // Both halves have to be present. Naming only what is collected leaves the
  // reader to guess where the line is. The exact wording is free to change,
  // so this checks the promise rather than the phrasing.
  assert.ok(/session length/i.test(detail), 'names what is collected');
  assert.ok(/anything you write or see/i.test(detail), 'names the exclusion in plain terms');

  // The full exclusion list is long enough to overwhelm the modal, so it lives
  // in the tooltip. It still has to be somewhere.
  const title = detail.match(/title="([^"]*)"/);
  assert.ok(title, 'exclusions are available on hover');
  for (const item of ['terminal', 'file contents', 'commands', 'prompts', 'file paths', 'repository names']) {
    assert.ok(title[1].toLowerCase().includes(item), `excluded: ${item}`);
  }
});

test('onboarding is split into two steps', () => {
  const html = appHtml();
  const js = readFileSync(join(here, '..', 'src-client', 'app.js'), 'utf-8');
  const block = js.slice(js.indexOf('const _onboarding'), js.indexOf('// Expanded pane state'));

  // Telemetry and email are separate asks, so they get separate screens.
  assert.ok(/data-step="1"/.test(html), 'step 1 present');
  assert.ok(/data-step="2"/.test(html), 'step 2 present');
  assert.ok(/data-step="2"[^>]*hidden/.test(html), 'step 2 starts hidden');

  // The telemetry control lives on step 1 and the email on step 2.
  const step1 = html.slice(html.indexOf('data-step="1"'), html.indexOf('data-step="2"'));
  assert.ok(/onboarding-consent/.test(step1), 'telemetry is on step 1');
  assert.ok(!/onboarding-email/.test(step1), 'email is not on step 1');

  // Continue advances before it submits.
  assert.ok(/this\._step === 1/.test(block), 'Continue advances on step 1');
  assert.ok(/_goToStep\(2\)/.test(block), 'moves to step 2');
});

test('a telemetry choice made on step 1 survives moving to step 2', () => {
  const html = appHtml();
  const js = readFileSync(join(here, '..', 'src-client', 'app.js'), 'utf-8');
  const block = js.slice(js.indexOf('const _onboarding'), js.indexOf('// Expanded pane state'));

  // Steps are hidden rather than replaced, so the checkbox keeps its state.
  // Rebuilding the markup per step would silently reset the user's answer.
  assert.ok(/el\.hidden = Number\(el\.dataset\.step\) !== step/.test(block), 'steps toggle hidden');
  assert.ok(!/innerHTML\s*=/.test(block), 'markup is never rebuilt between steps');
  assert.ok(/id="onboarding-consent"/.test(html), 'the checkbox is a persistent node');
});

test('marketing consent is a separate control the user can see and undo', () => {
  const html = appHtml();
  const tag = html.match(/<input[^>]*id="onboarding-marketing"[^>]*>/)[0];
  const telemetry = html.match(/<input[^>]*id="onboarding-consent"[^>]*>/)[0];

  // Pre-ticked at the product owner's direction. This is NOT valid consent
  // under GDPR (Planet49, C-673/17), so EU/UK sends on this basis are unlawful;
  // the pre-tick is a deliberate, documented business decision. If it is ever
  // reversed, drop `checked` here rather than reworking the copy.
  assert.ok(/\bchecked\b/.test(tag), 'ships pre-ticked (deliberate)');

  // Whatever the default, it must remain a distinct control with its own label,
  // never folded into the telemetry toggle.
  assert.ok(telemetry !== tag, 'marketing is separate from telemetry');
  assert.ok(/marketing/i.test(html), 'names marketing plainly');
  assert.ok(/unsubscribe/i.test(html), 'promises a way out');
});

test('an explicit untick is never silently reversed', () => {
  const js = readFileSync(join(here, '..', 'src-client', 'app.js'), 'utf-8');
  const block = js.slice(js.indexOf('const _onboarding'), js.indexOf('// Expanded pane state'));

  // The box re-ticks itself as the email field changes, so a user who unticked
  // it deliberately must be remembered. Re-ticking over their choice would turn
  // a weak default into an outright dark pattern.
  assert.ok(/userClearedMarketing/.test(block), 'tracks a deliberate untick');
  assert.ok(/marketing\.checked = !userClearedMarketing/.test(block), 'respects it on re-sync');
});

test('marketing consent cannot be set without an email', () => {
  const js = readFileSync(join(here, '..', 'src-client', 'app.js'), 'utf-8');
  const block = js.slice(js.indexOf('const _onboarding'), js.indexOf('// Expanded pane state'));
  const server = readFileSync(join(here, '..', 'src', 'auth', 'emailAuth.js'), 'utf-8');

  // The box may be ticked before an address is typed, so the submit path is
  // what actually gates it client-side.
  assert.ok(/marketingConsent: !!\(email && marketingInput/.test(block), 'client will not claim it without one');

  // And the server refuses it regardless of what the client sends.
  assert.ok(/const marketing = trimmed && marketingConsent \? 1 : 0/.test(server), 'server requires an address');
});

test('the star CTA points at the real repository and opens safely', () => {
  const html = appHtml();
  const tag = html.match(/<a[^>]*id="onboarding-star"[^>]*>/s) || html.match(/<a[^>]*class="star-cta"[^>]*>/s);
  assert.ok(tag, 'star link present');

  assert.ok(/github\.com\/alpbahadur\/49Agents/.test(tag[0]), 'points at the repo');
  assert.ok(/target="_blank"/.test(tag[0]), 'opens in a new tab so the modal survives');
  // Without noopener the opened page can reach back through window.opener.
  assert.ok(/rel="[^"]*noopener/.test(tag[0]), 'sets noopener');
});

test('Continue remains the only thing that answers the question', () => {
  const html = appHtml();

  // The star link is the loud action, but it must not double as a way out:
  // leaving via the star should still leave the consent question unanswered.
  assert.ok(/id="onboarding-submit"/.test(html), 'Continue still present');
  assert.ok(/class="onboarding-continue"/.test(html), 'Continue is the quiet text link');
});

test('onboarding modal has no way out except answering', () => {
  const html = appHtml();
  const js = readFileSync(join(here, '..', 'src-client', 'app.js'), 'utf-8');

  // Continue is always a valid answer (consent has a default, email is
  // optional), so there is deliberately no close control to bail out with.
  assert.ok(!/onboarding-close|onboarding-dismiss|onboarding-later/.test(html), 'no close control');
  assert.ok(!/Escape/.test(js.slice(js.indexOf('const _onboarding'), js.indexOf('// Expanded pane state'))),
    'Esc does not dismiss the modal');
});

test('onboarding waits for real usage, not wall-clock time', () => {
  const js = readFileSync(join(here, '..', 'src-client', 'app.js'), 'utf-8');
  const block = js.slice(js.indexOf('const _onboarding'), js.indexOf('// Expanded pane state'));

  // Time must only accrue while the tab is visible, otherwise someone who walks
  // away meets the modal on a screen they abandoned.
  assert.ok(/visibilityState !== 'visible'/.test(block), 'hidden tabs do not accrue time');
});

test('the onboarding clock lives on the server, not in the browser', () => {
  const js = readFileSync(join(here, '..', 'src-client', 'app.js'), 'utf-8');
  const block = js.slice(js.indexOf('const _onboarding'), js.indexOf('// Expanded pane state'));

  // Storing elapsed time client-side meant clearing site data or opening a
  // private window silently restarted the ten minutes.
  assert.ok(!/localStorage/.test(block), 'no browser storage drives the trigger');
  assert.ok(/api\/auth\/onboarding\/tick/.test(block), 'elapsed time is reported to the server');
  assert.ok(/api\/auth\/onboarding/.test(block), 'due state is read from the server');
});

test('an unanswered modal is restored if something removes it', () => {
  const js = readFileSync(join(here, '..', 'src-client', 'app.js'), 'utf-8');
  const block = js.slice(js.indexOf('const _onboarding'), js.indexOf('// Expanded pane state'));

  // Continue is the only way out, so hiding or deleting the node must not work.
  assert.ok(/MutationObserver/.test(block), 'the modal watches for tampering');
  assert.ok(/isConnected/.test(block), 'a removed modal is reattached');
  assert.ok(/display\\s\*:\\s\*none/.test(block), 'inline hiding is undone');
});

test('answering disconnects the guard so the modal can close', () => {
  const js = readFileSync(join(here, '..', 'src-client', 'app.js'), 'utf-8');
  const block = js.slice(js.indexOf('const _onboarding'), js.indexOf('// Expanded pane state'));
  assert.ok(/_guard\?\.disconnect\(\)/.test(block), 'guard stands down once answered');
});

test('a client cannot jump the onboarding clock in one call', () => {
  const src = readFileSync(join(here, '..', 'src', 'auth', 'emailAuth.js'), 'utf-8');
  // deltaMs arrives from the browser, so a single tick is clamped.
  assert.ok(/Math\.min\(Number\(deltaMs\)[^,]*, 60000\)/.test(src), 'per-call increment is capped');
});

test('an answered consent question is never asked again', () => {
  const js = readFileSync(join(here, '..', 'src-client', 'app.js'), 'utf-8');
  const block = js.slice(js.indexOf('const _onboarding'), js.indexOf('// Expanded pane state'));
  const server = readFileSync(join(here, '..', 'src', 'auth', 'cloudCallback.js'), 'utf-8');

  // The client only opens the modal when the server says it applies.
  assert.ok(/!state\.applicable/.test(block), 'client defers to the server');

  // And the server only says so while consent is genuinely unanswered (-1).
  // A decline is an answer and must stick.
  assert.ok(
    /raw !== -1[\s\S]*?applicable: false/.test(server),
    'an answered question is no longer applicable'
  );
});

// ---------------------------------------------------------------------------
// Local mode has no sign-in
// ---------------------------------------------------------------------------

test('OAuth routes are registered only when not in local mode', () => {
  const src = readFileSync(join(here, '..', 'src', 'index.js'), 'utf-8');

  // The hosted instance still needs GitHub and Google. Local clones must not
  // register them at all, rather than shipping dead buttons.
  assert.ok(
    /if \(!isLocalMode\(\)\) \{\s*setupGitHubAuth\(app\);\s*setupGoogleAuth\(app\);/.test(src),
    'OAuth setup is gated on cloud mode'
  );

  // Logout ships with the GitHub routes, so local mode has to provide its own.
  assert.ok(/app\.post\('\/auth\/logout', localLogout\)/.test(src), 'local mode keeps logout');
});

test('local mode never sends anyone to a login page', () => {
  const src = readFileSync(join(here, '..', 'src', 'index.js'), 'utf-8');
  const mw = readFileSync(join(here, '..', 'src', 'auth', 'middleware.js'), 'utf-8');

  // Every path that would have shown a login screen has to fall through to the
  // app, where a session is created on arrival.
  assert.ok(/isLocalMode\(\)\) return res\.redirect\('\/'\)/.test(src), '/login redirects to the app');
  assert.ok(/res\.redirect\(isLocalMode\(\) \? '\/' : '\/login'\)/.test(src), 'catch-all redirects to the app');
  assert.ok(/res\.redirect\(isLocalMode\(\) \? '\/' : '\/login'\)/.test(mw), 'auth failures redirect to the app');
});
