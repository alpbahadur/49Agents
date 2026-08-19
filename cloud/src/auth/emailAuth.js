/**
 * Email Auth — local-side signup for local-hosted instances.
 *
 * Replaces the OAuth flow for local mode. User provides an email,
 * we do an MX lookup to validate the domain, issue a local JWT,
 * store the identity locally, and register with the cloud server.
 *
 * POST /auth/email-signup
 */

import dns from 'dns';
import { promisify } from 'util';
import { SignJWT } from 'jose';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { upsertUser } from '../db/users.js';
import { recordEvent } from '../db/events.js';
import { getDb } from '../db/index.js';

const resolveMx = promisify(dns.resolveMx);

function getSecretKey() {
  return new TextEncoder().encode(config.jwt.secret);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function validateEmailDomain(email) {
  const domain = email.split('@')[1];
  try {
    const records = await resolveMx(domain);
    return records && records.length > 0;
  } catch {
    return false;
  }
}

export function ensureEmailAuthTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_email_auth (
      id                INTEGER PRIMARY KEY CHECK (id = 1),
      instance_id       TEXT NOT NULL,
      email             TEXT,
      telemetry_consent INTEGER NOT NULL DEFAULT -1,
      marketing_consent INTEGER NOT NULL DEFAULT 0,
      onboarding_step   INTEGER NOT NULL DEFAULT 1,
      cloud_instance_id TEXT,
      active_ms         INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migration: onboarding made email optional (users may decline to share it) and
  // added consent tracking. Older databases have email NOT NULL and neither column.
  try {
    db.prepare('SELECT telemetry_consent FROM local_email_auth LIMIT 1').get();
  } catch {
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
  }

  // cloud_instance_id arrived with the server-issued id scheme; a database that
  // already had telemetry_consent may still be missing it.
  try {
    db.prepare('ALTER TABLE local_email_auth ADD COLUMN cloud_instance_id TEXT').run();
  } catch {
    // Column already exists, ignore
  }

  // active_ms moved the onboarding clock server-side so it cannot be reset by
  // clearing browser storage.
  try {
    db.prepare('ALTER TABLE local_email_auth ADD COLUMN active_ms INTEGER NOT NULL DEFAULT 0').run();
  } catch {
    // Column already exists, ignore
  }

  // Marketing consent is tracked separately from telemetry consent. GDPR treats
  // them as different purposes, so one can never be inferred from the other.
  try {
    db.prepare('ALTER TABLE local_email_auth ADD COLUMN marketing_consent INTEGER NOT NULL DEFAULT 0').run();
  } catch {
    // Column already exists, ignore
  }

  // Which onboarding step the user reached, so a reload does not throw away
  // progress and drop them back to the first screen.
  try {
    db.prepare('ALTER TABLE local_email_auth ADD COLUMN onboarding_step INTEGER NOT NULL DEFAULT 1').run();
  } catch {
    // Column already exists, ignore
  }
}

/**
 * Remember which onboarding step the user reached.
 */
export function setOnboardingStep(step) {
  const db = getDb();
  const clamped = step === 2 ? 2 : 1;
  db.prepare('UPDATE local_email_auth SET onboarding_step = ? WHERE id = 1').run(clamped);
  return clamped;
}

/**
 * The step the user last reached, defaulting to the first.
 */
export function getOnboardingStep() {
  const db = getDb();
  const row = db.prepare('SELECT onboarding_step FROM local_email_auth WHERE id = 1').get();
  return row ? (row.onboarding_step || 1) : 1;
}

export function getEmailAuth() {
  const db = getDb();
  const row = db.prepare('SELECT * FROM local_email_auth WHERE id = 1').get();
  if (!row) return null;
  return {
    instanceId: row.instance_id,
    email: row.email,
    telemetryConsent: row.telemetry_consent,
    marketingConsent: row.marketing_consent === 1,
    cloudInstanceId: row.cloud_instance_id,
  };
}

function saveEmailAuth({ instanceId, email, telemetryConsent, marketingConsent = 0 }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO local_email_auth (id, instance_id, email, telemetry_consent, marketing_consent)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      instance_id = excluded.instance_id,
      email = excluded.email,
      telemetry_consent = excluded.telemetry_consent,
      marketing_consent = excluded.marketing_consent
  `).run(instanceId, email, telemetryConsent, marketingConsent);
}

/**
 * Store the instance id the cloud server assigned us at enrollment.
 * Sent as X-Instance-Id on every later telemetry batch.
 */
export function setCloudInstanceId(cloudInstanceId) {
  const db = getDb();
  db.prepare('UPDATE local_email_auth SET cloud_instance_id = ? WHERE id = 1').run(cloudInstanceId);
}

/**
 * Update telemetry consent for the email-auth identity.
 * -1 = not asked, 0 = declined, 1 = accepted.
 */
export function setEmailTelemetryConsent(consent) {
  const db = getDb();
  db.prepare('UPDATE local_email_auth SET telemetry_consent = ? WHERE id = 1').run(consent ? 1 : 0);
}

/**
 * Ensure a local identity exists so a fresh clone opens straight into the app.
 *
 * Onboarding used to gate the login page. It now appears inside the app after
 * ten minutes of use, which means the user is already working before they are
 * ever asked anything. Consent starts unset (-1) and telemetry stays off until
 * they answer, so nothing is collected in the meantime.
 *
 * @returns {{ instanceId: string, created: boolean }}
 */
export function ensureLocalSession() {
  const existing = getEmailAuth();
  if (existing) return { instanceId: existing.instanceId, created: false };

  const instanceId = `lei_${nanoid(16)}`;
  saveEmailAuth({ instanceId, email: null, telemetryConsent: -1 });
  return { instanceId, created: true };
}

/**
 * Accumulated active-use milliseconds for this instance.
 *
 * The onboarding clock is kept server-side on purpose. Holding it in the
 * browser meant clearing site data, opening a private window, or switching
 * browsers silently restarted the ten minutes, and the modal could be dodged
 * indefinitely without ever answering it.
 */
export function getActiveMs() {
  const db = getDb();
  const row = db.prepare('SELECT active_ms FROM local_email_auth WHERE id = 1').get();
  return row ? (row.active_ms || 0) : 0;
}

/**
 * Add to the accumulated active time and return the new total.
 * Increments are clamped: a client cannot jump the counter in one call.
 */
export function addActiveMs(deltaMs) {
  const db = getDb();
  const capped = Math.max(0, Math.min(Number(deltaMs) || 0, 60000));
  db.prepare('UPDATE local_email_auth SET active_ms = COALESCE(active_ms, 0) + ? WHERE id = 1').run(capped);
  return getActiveMs();
}

export async function issueEmailInstanceToken(instanceId, email) {
  const secretKey = getSecretKey();
  return new SignJWT({ sub: instanceId, type: 'local_email_instance', email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setJti(nanoid())
    .sign(secretKey);
}

export function setupEmailAuthRoutes(app) {
  // POST /auth/email-signup
  app.post('/auth/email-signup', async (req, res) => {
    try {
      const { email, telemetryConsent, marketingConsent } = req.body;

      // Email is optional: onboarding lets people continue without sharing it.
      // Telemetry consent is a separate decision, defaulting to off when absent.
      const consent = telemetryConsent === undefined ? false : !!telemetryConsent;
      let trimmed = null;

      if (email !== undefined && email !== null && String(email).trim() !== '') {
        if (typeof email !== 'string') {
          return res.status(400).json({ error: 'Invalid email address.' });
        }

        trimmed = email.trim().toLowerCase();

        if (!EMAIL_RE.test(trimmed)) {
          return res.status(400).json({ error: 'Invalid email address.' });
        }

        const domainValid = await validateEmailDomain(trimmed);
        if (!domainValid) {
          return res.status(400).json({ error: 'Email domain does not appear to be valid.' });
        }
      }

      const instanceId = `lei_${nanoid(16)}`;

      // Create or update local user record. Without an email we still need a
      // usable local identity, so fall back to an instance-derived display name.
      const localUser = upsertUser({
        githubId: null,
        githubLogin: null,
        googleId: null,
        email: trimmed,
        displayName: trimmed ? trimmed.split('@')[0] : 'Local User',
        avatarUrl: null,
      });

      // Marketing consent requires an address to send to. Without one there is
      // nothing to consent to, so it cannot be set.
      const marketing = trimmed && marketingConsent ? 1 : 0;

      saveEmailAuth({
        instanceId,
        email: trimmed,
        telemetryConsent: consent ? 1 : 0,
        marketingConsent: marketing,
      });

      // Issue local JWT cookies reusing the existing cookie mechanism
      const { issueAccessToken, issueRefreshToken, setAuthCookies } = await import('./tokens.js');
      const jwtAccess = await issueAccessToken(localUser);
      const jwtRefresh = await issueRefreshToken(localUser);
      setAuthCookies(res, jwtAccess, jwtRefresh);

      recordEvent('user.login', localUser.id, { provider: 'email', instanceId });

      // Enroll with the cloud so telemetry has somewhere to go. Only when the user
      // consented. An instance that opted out never contacts the cloud at all.
      //
      // Fire-and-forget: a network failure must not block someone from using the
      // app. refreshTelemetryState() runs once the id comes back, which is what
      // actually starts the collector.
      if (consent) {
        const cloudUrl = config.cloudAuthUrl;
        fetch(`${cloudUrl}/api/local-email-signup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instanceId,
            email: trimmed,
            consent: true,
            marketingConsent: marketing === 1,
            hostname: req.hostname,
            os: process.platform,
            version: config.version || null,
          }),
          signal: AbortSignal.timeout(8000),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then(async (data) => {
            if (data && data.instanceId) {
              setCloudInstanceId(data.instanceId);
              const { refreshTelemetryState } = await import('../telemetry/localCollector.js');
              refreshTelemetryState();
            }
          })
          .catch((err) => {
            console.warn('[email-auth] Cloud enrollment failed (non-fatal):', err.message);
          });
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('[email-auth] Signup error:', err);
      res.status(500).json({ error: 'Signup failed. Please try again.' });
    }
  });
}
