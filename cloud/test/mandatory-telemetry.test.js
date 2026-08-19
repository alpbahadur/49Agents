import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import express from 'express';

/**
 * POST /api/telemetry/mandatory — the consent-exempt `visit` and
 * `telemetry_rejected` events.
 *
 * These exist to answer a funnel question the consent-gated telemetry path
 * cannot: how many people loaded the app at all, versus how many reached the
 * onboarding consent question, versus how many said yes. Recording that
 * requires writing before consent exists, which is the opposite of what
 * /api/telemetry/local is built to guarantee — so this is a separate route
 * with its own, deliberately small, allowlist of event types.
 *
 * Run against a real temp SQLite database (not mocked) via a real HTTP
 * request, since the thing being pinned is the route's behavior end to end:
 * an unenrolled, non-consenting caller must still be able to write exactly
 * these two event types and nothing else.
 */

const dir = mkdtempSync(join(tmpdir(), 'mandatory-telemetry-'));
process.env.DATABASE_PATH = join(dir, 'test.db');

const { initDatabase, getDb } = await import('../src/db/index.js');
const { ensureTelemetryTables, setupTelemetryIngestRoutes } = await import('../src/telemetry/ingest.js');

initDatabase();
ensureTelemetryTables();

const app = express();
app.use(express.json());
setupTelemetryIngestRoutes(app);

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

test.after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a visit is recorded for a caller with no prior enrollment', async () => {
  const res = await fetch(`${base}/api/telemetry/mandatory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventType: 'visit', instanceId: null, os: 'macos' }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.ok(body.instanceId, 'server mints an instance id');

  const db = getDb();
  const row = db.prepare('SELECT * FROM telemetry_instances WHERE instance_id = ?').get(body.instanceId);
  assert.ok(row, 'a bare instance row exists');
  assert.equal(row.consent, 0, 'consent is not implied by a visit');
  assert.equal(row.os, 'macos');

  const event = db.prepare('SELECT * FROM telemetry_events WHERE instance_id = ?').get(body.instanceId);
  assert.equal(event.event_type, 'visit');
});

test('a rejection is recorded without ever granting consent', async () => {
  const res = await fetch(`${base}/api/telemetry/mandatory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventType: 'telemetry_rejected', instanceId: null, os: 'windows' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);

  const db = getDb();
  const row = db.prepare('SELECT * FROM telemetry_instances WHERE instance_id = ?').get(body.instanceId);
  assert.equal(row.consent, 0, 'declining does not somehow grant consent');

  const event = db.prepare('SELECT * FROM telemetry_events WHERE instance_id = ?').get(body.instanceId);
  assert.equal(event.event_type, 'telemetry_rejected');
});

test('an existing instance id is reused rather than forking a new row', async () => {
  const first = await (await fetch(`${base}/api/telemetry/mandatory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventType: 'visit', instanceId: null, os: 'linux' }),
  })).json();

  await fetch(`${base}/api/telemetry/mandatory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventType: 'visit', instanceId: first.instanceId, os: 'linux' }),
  });

  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) c FROM telemetry_instances WHERE instance_id = ?')
    .get(first.instanceId).c;
  assert.equal(count, 1, 'the same instance id maps to one row');

  const events = db.prepare('SELECT COUNT(*) c FROM telemetry_events WHERE instance_id = ?')
    .get(first.instanceId).c;
  assert.equal(events, 2, 'both visits are recorded as separate events');
});

test('an event type outside the exempt allowlist is rejected', async () => {
  const res = await fetch(`${base}/api/telemetry/mandatory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventType: 'session.start', instanceId: null }),
  });
  assert.equal(res.status, 400);

  const db = getDb();
  const count = db.prepare("SELECT COUNT(*) c FROM telemetry_events WHERE event_type = 'session.start'").get().c;
  assert.equal(count, 0, 'no event is written for a rejected type');
});

test('the consent-gated ingest path still refuses an unconsenting instance', async () => {
  // A visit does not grant consent, so the same instance must still be
  // refused by the real telemetry path — this is the boundary the mandatory
  // route exists specifically not to cross.
  const enrolled = await (await fetch(`${base}/api/telemetry/mandatory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventType: 'visit', instanceId: null, os: 'macos' }),
  })).json();

  const res = await fetch(`${base}/api/telemetry/local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Instance-Id': enrolled.instanceId },
    body: JSON.stringify({ events: [{ event_type: 'pane.open' }] }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.accepted, 0);
  assert.equal(body.reason, 'no_consent');
});
