import { getDb } from './index.js';
import { randomUUID, createHash } from 'crypto';
import { notifyNewUser, notifyGuestUser } from '../notifications/discord.js';
import { DEFAULT_TIER } from '../billing/tiers.js';
import { recordEvent } from './events.js';
import { GUEST_NAMES } from '../data/guest-names.js';

/**
 * Generate a user ID with format: user_ + first 12 chars of a UUID
 */
function generateUserId() {
  return 'user_' + randomUUID().replace(/-/g, '').slice(0, 12);
}

/**
 * Upsert a user from OAuth data (GitHub or Google).
 * Lookup order: provider-specific ID → email fallback (for account linking).
 * If found, update profile. If new, create with generated user ID.
 */
export function upsertUser({ githubId, githubLogin, googleId, email, displayName, avatarUrl, utmSource }) {
  const db = getDb();

  // 1. Try provider-specific ID lookup
  let existing = null;
  if (githubId) {
    existing = db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId);
  }
  if (!existing && googleId) {
    existing = db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);
  }

  // 2. Email fallback for account linking
  if (!existing && email) {
    existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  }

  if (existing) {
    // Update profile fields
    db.prepare(`
      UPDATE users
      SET email = ?, display_name = ?, avatar_url = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(email || existing.email, displayName || existing.display_name, avatarUrl || existing.avatar_url, existing.id);

    // Link GitHub provider if new
    if (githubId && !existing.github_id) {
      db.prepare('UPDATE users SET github_id = ?, github_login = ? WHERE id = ?')
        .run(githubId, githubLogin || null, existing.id);
    } else if (githubId && existing.github_id) {
      db.prepare('UPDATE users SET github_login = ? WHERE id = ?')
        .run(githubLogin || existing.github_login, existing.id);
    }

    // Link Google provider if new
    if (googleId && !existing.google_id) {
      db.prepare('UPDATE users SET google_id = ? WHERE id = ?')
        .run(googleId, existing.id);
    }

    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }

  // 3. Create new user
  const id = generateUserId();
  db.prepare(`
    INSERT INTO users (id, github_id, github_login, google_id, email, display_name, avatar_url, tier, utm_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, githubId || null, githubLogin || null, googleId || null, email || null, displayName || null, avatarUrl || null, DEFAULT_TIER, utmSource || null);

  const newUser = db.prepare('SELECT * FROM users WHERE id = ?').get(id);

  // Record signup event
  recordEvent('user.signup', id, {
    provider: githubId ? 'github' : 'google',
    email: email || null,
    utm_source: utmSource || null,
  });

  // Fire-and-forget Discord notification for new signups
  notifyNewUser(newUser).catch(err => console.warn('[discord] Unhandled:', err.message));

  return newUser;
}

/**
 * Get a user by their internal ID.
 */
export function getUserById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

/**
 * Get a user by their GitHub ID.
 */
export function getUserByGithubId(githubId) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId) || null;
}

/**
 * Update a user's subscription tier.
 */
export function updateUserTier(userId, tier) {
  const db = getDb();
  db.prepare(`
    UPDATE users SET tier = ?, updated_at = datetime('now') WHERE id = ?
  `).run(tier, userId);
}


/**
 * Create a guest user (no OAuth, temporary).
 * Guests get the default tier and a 30-minute session window.
 */
export function createGuestUser() {
  const db = getDb();
  const id = generateUserId();
  const guestName = GUEST_NAMES[Math.floor(Math.random() * GUEST_NAMES.length)];
  db.prepare(`
    INSERT INTO users (id, is_guest, guest_started_at, display_name, tier)
    VALUES (?, 1, datetime('now'), ?, ?)
  `).run(id, guestName, DEFAULT_TIER);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);

  recordEvent('user.guest_start', id, { name: guestName });
  notifyGuestUser(user).catch(err => console.warn('[discord] Unhandled:', err.message));

  return user;
}

/**
 * Transfer guest data to a real user account and delete the guest.
 * Reassigns all foreign-keyed rows from guestId to realUserId.
 */
export function transferGuestData(guestId, realUserId) {
  const db = getDb();

  // Tables that reference users(id) — transfer ownership
  const tables = ['agents', 'terminals', 'notes', 'user_preferences', 'file_panes', 'git_graphs', 'iframes', 'beads_panes', 'folder_panes', 'messages'];
  for (const table of tables) {
    try {
      db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`).run(realUserId, guestId);
    } catch (e) {
      // Table may not exist — skip silently
    }
  }

  // Delete the guest user row
  db.prepare('DELETE FROM users WHERE id = ?').run(guestId);

  recordEvent('user.guest_converted', realUserId, { from_guest: guestId });
}

/**
 * Resolve the single shared identity of an 'open' (local / self-hosted)
 * deployment, creating it once on first use.
 *
 * upsertUser cannot do this job: it matches on github_id, google_id, then
 * email, and a local instance has none of the three until the owner enters an
 * email in the consent modal. Every cookieless request therefore fell through
 * to the INSERT and minted a brand new user row — so a second browser, or a
 * crawler, never landed on the same identity as the agent running on the
 * machine, and the users table grew without bound.
 *
 * The instance id (persisted in local_email_auth) is the stable thing to hang
 * that identity on, so the user id is derived from it rather than random.
 */
export function getOrCreateLocalSharedUser(instanceId, { email, displayName } = {}) {
  const db = getDb();
  const id = 'user_' + createHash('sha256').update(`local:${instanceId}`).digest('hex').slice(0, 12);

  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (existing) {
    // The owner may have supplied an email since this row was created.
    if ((email && email !== existing.email) || (displayName && displayName !== existing.display_name)) {
      db.prepare(`
        UPDATE users
        SET email = ?, display_name = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(email || existing.email, displayName || existing.display_name, id);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    }
    return existing;
  }

  // An owner who entered their email before this row existed already has a
  // user keyed on that email — adopt it rather than splitting their data.
  if (email) {
    const byEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (byEmail) return byEmail;
  }

  db.prepare(`
    INSERT INTO users (id, email, display_name, tier)
    VALUES (?, ?, ?, ?)
  `).run(id, email || null, displayName || 'Local User', DEFAULT_TIER);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  recordEvent('user.local_session', id, { instance_id: instanceId });
  return user;
}
