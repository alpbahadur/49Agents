/**
 * Telemetry Ingest: cloud-side receiver for local instance telemetry.
 *
 * Local-hosted instances enroll once (POST /api/local-email-signup) and receive a
 * server-issued instance id. Every later telemetry batch (POST /api/telemetry/local)
 * carries that id in the X-Instance-Id header.
 *
 * There is deliberately no shared secret: local clones are open source, so any key
 * shipped in the repo would be public anyway. The payload is anonymous usage counts,
 * so a spoofed id buys an attacker nothing beyond polluting our own stats.
 *
 * Data lands in the same SQLite database as the rest of the app and is pulled down
 * manually via GET /api/admin/telemetry/export.
 */

import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import { config } from '../config.js';

const MAX_EVENTS_PER_BATCH = 500;
const MAX_METADATA_BYTES = 4096;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Create the telemetry tables if they don't exist.
 * Called during database initialization.
 */
export function ensureTelemetryTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_instances (
      instance_id       TEXT PRIMARY KEY,
      email             TEXT,
      consent           INTEGER NOT NULL DEFAULT 0,
      marketing_consent INTEGER NOT NULL DEFAULT 0,
      hostname          TEXT,
      os                TEXT,
      version           TEXT,
      first_seen        TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS telemetry_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id  TEXT NOT NULL,
      event_type   TEXT NOT NULL,
      user_id      TEXT,
      metadata     TEXT NOT NULL DEFAULT '{}',
      timestamp    TEXT,
      received_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_telemetry_events_instance ON telemetry_events(instance_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_events_received ON telemetry_events(received_at);
    CREATE INDEX IF NOT EXISTS idx_telemetry_instances_email ON telemetry_instances(email);
  `);

  // Marketing consent arrived after the first deploys, so existing rows need it.
  // It defaults to 0: nobody is opted in retroactively.
  try {
    db.prepare('ALTER TABLE telemetry_instances ADD COLUMN marketing_consent INTEGER NOT NULL DEFAULT 0').run();
  } catch {
    // Column already exists, ignore
  }
}

/**
 * Enroll an instance, or re-enroll an existing one when the caller already has an id.
 *
 * Re-enrollment by email is deliberate: a user who reinstalls or clones onto a second
 * machine and gives the same email continues the same telemetry identity rather than
 * fragmenting into a new one.
 */
function enrollInstance({ instanceId, email, consent, marketingConsent, hostname, os, version }) {
  const db = getDb();

  // Reuse the caller's id if we already know it.
  if (instanceId) {
    const existing = db.prepare('SELECT instance_id FROM telemetry_instances WHERE instance_id = ?').get(instanceId);
    if (existing) {
      db.prepare(`
        UPDATE telemetry_instances
        SET email = COALESCE(?, email),
            consent = ?,
            marketing_consent = ?,
            hostname = COALESCE(?, hostname),
            os = COALESCE(?, os),
            version = COALESCE(?, version),
            last_seen = datetime('now')
        WHERE instance_id = ?
      `).run(email, consent ? 1 : 0, marketingConsent ? 1 : 0, hostname, os, version, instanceId);
      return instanceId;
    }
  }

  // Continue an existing identity when the same email comes back.
  if (email) {
    const byEmail = db.prepare(
      'SELECT instance_id FROM telemetry_instances WHERE email = ? ORDER BY last_seen DESC LIMIT 1'
    ).get(email);
    if (byEmail) {
      db.prepare(`
        UPDATE telemetry_instances
        SET consent = ?,
            marketing_consent = ?,
            hostname = COALESCE(?, hostname),
            os = COALESCE(?, os),
            version = COALESCE(?, version),
            last_seen = datetime('now')
        WHERE instance_id = ?
      `).run(consent ? 1 : 0, marketingConsent ? 1 : 0, hostname, os, version, byEmail.instance_id);
      return byEmail.instance_id;
    }
  }

  const newId = `lei_${nanoid(16)}`;
  db.prepare(`
    INSERT INTO telemetry_instances (instance_id, email, consent, marketing_consent, hostname, os, version)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(newId, email || null, consent ? 1 : 0, marketingConsent ? 1 : 0, hostname || null, os || null, version || null);
  return newId;
}

function normalizeEmail(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  return EMAIL_RE.test(trimmed) ? trimmed : null;
}

export function setupTelemetryIngestRoutes(app) {
  // POST /api/local-email-signup is the first contact from a local instance.
  // Returns the instance id the instance must send on later telemetry posts.
  app.post('/api/local-email-signup', (req, res) => {
    try {
      const { instanceId, email, consent, hostname, os, version } = req.body || {};

      const resolvedId = enrollInstance({
        instanceId: typeof instanceId === 'string' ? instanceId : null,
        email: normalizeEmail(email),
        consent: !!consent,
        // Only meaningful with an address to send to.
        marketingConsent: !!(normalizeEmail(email) && req.body.marketingConsent),
        hostname: typeof hostname === 'string' ? hostname.slice(0, 255) : null,
        os: typeof os === 'string' ? os.slice(0, 64) : null,
        version: typeof version === 'string' ? version.slice(0, 64) : null,
      });

      res.json({ ok: true, instanceId: resolvedId });
    } catch (err) {
      console.error('[telemetry-ingest] Signup error:', err);
      res.status(500).json({ error: 'Signup failed' });
    }
  });

  // POST /api/telemetry/local takes batched events from an enrolled instance.
  app.post('/api/telemetry/local', (req, res) => {
    try {
      const headerId = req.get('X-Instance-Id');
      const { events, instance } = req.body || {};

      const instanceId = headerId || (instance && instance.id);
      if (!instanceId || typeof instanceId !== 'string') {
        return res.status(400).json({ error: 'Missing instance id' });
      }

      if (!Array.isArray(events)) {
        return res.status(400).json({ error: 'events must be an array' });
      }

      const db = getDb();
      const known = db.prepare('SELECT consent FROM telemetry_instances WHERE instance_id = ?').get(instanceId);

      // Only instances we have an enrollment record for may write events, and
      // only while that record says consent is granted.
      //
      // Enrolling an unknown id on the spot would defeat revocation: a client
      // still holding a revoked id could resurrect it by posting events. An
      // instance that has genuinely never enrolled calls /api/local-email-signup
      // first, which is where consent is actually established.
      if (!known) {
        return res.status(404).json({ error: 'Unknown instance, enroll first' });
      }

      if (known.consent !== 1) {
        // The instance believes it has consent but our record says revoked.
        // The server record wins.
        return res.json({ ok: true, accepted: 0, reason: 'no_consent' });
      }

      db.prepare(`
        UPDATE telemetry_instances
        SET last_seen = datetime('now'),
            hostname = COALESCE(?, hostname),
            os = COALESCE(?, os),
            version = COALESCE(?, version)
        WHERE instance_id = ?
      `).run(
        instance && typeof instance.hostname === 'string' ? instance.hostname.slice(0, 255) : null,
        instance && typeof instance.os === 'string' ? instance.os.slice(0, 64) : null,
        instance && typeof instance.version === 'string' ? instance.version.slice(0, 64) : null,
        instanceId
      );

      const insert = db.prepare(`
        INSERT INTO telemetry_events (instance_id, event_type, user_id, metadata, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `);

      const batch = events.slice(0, MAX_EVENTS_PER_BATCH);
      let accepted = 0;

      const insertMany = db.transaction((rows) => {
        for (const ev of rows) {
          if (!ev || typeof ev.event_type !== 'string') continue;
          let metadata = '{}';
          try {
            const encoded = JSON.stringify(ev.metadata || {});
            if (encoded.length <= MAX_METADATA_BYTES) metadata = encoded;
          } catch {
            // Unserializable metadata. Keep the event, drop the payload.
          }
          insert.run(
            instanceId,
            ev.event_type.slice(0, 128),
            typeof ev.user_id === 'string' ? ev.user_id : null,
            metadata,
            typeof ev.timestamp === 'string' ? ev.timestamp : null
          );
          accepted++;
        }
      });

      insertMany(batch);

      res.json({ ok: true, accepted });
    } catch (err) {
      console.error('[telemetry-ingest] Ingest error:', err);
      res.status(500).json({ error: 'Ingest failed' });
    }
  });

  // GET /api/admin/telemetry/export pulls the collected data down.
  app.get('/api/admin/telemetry/export', (req, res) => {
    if (!config.adminToken) {
      return res.status(503).json({ error: 'Export not configured (ADMIN_TOKEN unset)' });
    }

    const auth = req.get('Authorization') || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (provided !== config.adminToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const db = getDb();
      const since = typeof req.query.since === 'string' ? req.query.since : null;
      const format = req.query.format === 'csv' ? 'csv' : 'json';

      const instances = db.prepare('SELECT * FROM telemetry_instances ORDER BY last_seen DESC').all();
      const events = since
        ? db.prepare('SELECT * FROM telemetry_events WHERE received_at >= ? ORDER BY received_at DESC').all(since)
        : db.prepare('SELECT * FROM telemetry_events ORDER BY received_at DESC').all();

      if (format === 'csv') {
        const esc = (v) => {
          if (v === null || v === undefined) return '';
          const s = String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const header = 'id,instance_id,email,event_type,user_id,metadata,timestamp,received_at';
        const emailById = new Map(instances.map((i) => [i.instance_id, i.email]));
        const lines = events.map((e) =>
          [e.id, e.instance_id, emailById.get(e.instance_id) || '', e.event_type, e.user_id, e.metadata, e.timestamp, e.received_at]
            .map(esc)
            .join(',')
        );
        res.type('text/csv').send([header, ...lines].join('\n'));
        return;
      }

      res.json({ instances, events, exportedAt: new Date().toISOString() });
    } catch (err) {
      console.error('[telemetry-ingest] Export error:', err);
      res.status(500).json({ error: 'Export failed' });
    }
  });
}
