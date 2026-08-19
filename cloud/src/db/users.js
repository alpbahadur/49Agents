import { getDb } from './index.js';
import { randomUUID } from 'crypto';
import { notifyNewUser } from '../notifications/discord.js';
import { DEFAULT_TIER } from '../billing/tiers.js';
import { recordEvent } from './events.js';

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

