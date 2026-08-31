/**
 * Local Auth Storage — manages cloud authentication state for local-hosted instances.
 *
 * Stores a single row in the local_auth table representing the cloud-authenticated
 * user identity. This module is only active when running in local mode (no OAuth
 * configured, not production).
 */

import { getDb } from '../db/index.js';
import { getUserById } from '../db/users.js';
import { config } from '../config.js';

/**
 * Returns true if the server is running in local mode: no sign-in of its own,
 * a single auto-provisioned identity. config.authMode is the authority (see
 * config.js); SKIP_CLOUD_AUTH still opts a contributor's dev server out, since
 * it grants a fixed dev user instead of the local shared one.
 */
export function isLocalMode() {
  return config.authMode === 'open' && !process.env.SKIP_CLOUD_AUTH;
}

/**
 * Create the local_auth table if it doesn't exist.
 * Called during database initialization.
 */
export function ensureLocalAuthTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_auth (
      id                INTEGER PRIMARY KEY CHECK (id = 1),
      cloud_user_id     TEXT NOT NULL,
      cloud_token       TEXT NOT NULL,
      instance_id       TEXT,
      display_name      TEXT,
      email             TEXT,
      avatar_url        TEXT,
      github_login      TEXT,
      tier              TEXT,
      telemetry_consent INTEGER NOT NULL DEFAULT -1,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Get the stored cloud auth data.
 * @returns {{ cloudUserId, cloudToken, instanceId, displayName, email, avatarUrl, githubLogin, tier, telemetryConsent } | null}
 */
export function getLocalAuth() {
  const db = getDb();
  const row = db.prepare('SELECT * FROM local_auth WHERE id = 1').get();
  if (!row) return null;

  // Integrity check: the stored cloud_user_id must still resolve to a live user.
  // A user row can be removed (e.g. guest-merge or dedup cleanup) while this
  // pointer is left dangling, which silently breaks browser/agent userId matching.
  let cloudUserId = row.cloud_user_id;
  if (!getUserById(cloudUserId)) {
    // Self-heal: relink to a surviving user by email (the same key upsertUser
    // dedups on), then persist so we don't re-resolve every call.
    const healed = row.email
      ? db.prepare('SELECT id FROM users WHERE email = ?').get(row.email)
      : null;
    if (!healed) {
      // No live user to point at — return null so callers fall through to
      // cookie/guest auth instead of binding to a non-existent identity.
      return null;
    }
    db.prepare("UPDATE local_auth SET cloud_user_id = ?, updated_at = datetime('now') WHERE id = 1")
      .run(healed.id);
    cloudUserId = healed.id;
  }

  return {
    cloudUserId,
    cloudToken: row.cloud_token,
    instanceId: row.instance_id,
    displayName: row.display_name,
    email: row.email,
    avatarUrl: row.avatar_url,
    githubLogin: row.github_login,
    tier: row.tier,
    telemetryConsent: row.telemetry_consent,
  };
}

/**
 * Save cloud auth data (upserts — always one row with id=1).
 */
export function saveLocalAuth({ cloudUserId, cloudToken, instanceId, displayName, email, avatarUrl, githubLogin, tier }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO local_auth (id, cloud_user_id, cloud_token, instance_id, display_name, email, avatar_url, github_login, tier, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      cloud_user_id = excluded.cloud_user_id,
      cloud_token = excluded.cloud_token,
      instance_id = excluded.instance_id,
      display_name = excluded.display_name,
      email = excluded.email,
      avatar_url = excluded.avatar_url,
      github_login = excluded.github_login,
      tier = excluded.tier,
      updated_at = datetime('now')
  `).run(cloudUserId, cloudToken, instanceId || null, displayName || null, email || null, avatarUrl || null, githubLogin || null, tier || null);
}

/**
 * Clear all stored cloud auth data.
 */
export function clearLocalAuth() {
  const db = getDb();
  db.prepare('DELETE FROM local_auth').run();
}

/**
 * Set telemetry consent. -1 = not asked, 0 = declined, 1 = accepted.
 */
export function setTelemetryConsent(consent) {
  const db = getDb();
  db.prepare('UPDATE local_auth SET telemetry_consent = ?, updated_at = datetime(\'now\') WHERE id = 1').run(consent ? 1 : 0);
}
