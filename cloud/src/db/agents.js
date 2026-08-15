/**
 * Agent registration and management — Placeholder for Phase 3.
 *
 * These functions will be fully implemented when the WebSocket relay
 * and agent connection features are built.
 */

import { getDb } from './index.js';
import { randomUUID } from 'crypto';

function generateAgentId() {
  return 'agent_' + randomUUID().replace(/-/g, '').slice(0, 12);
}

/**
 * Register a new agent for a user.
 */
export function registerAgent(userId, hostname, os, tokenHash) {
  const db = getDb();
  const id = generateAgentId();

  db.prepare(`
    INSERT INTO agents (id, user_id, hostname, os, token_hash)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, hostname) DO UPDATE SET
      os = excluded.os,
      token_hash = excluded.token_hash
  `).run(id, userId, hostname, os || null, tokenHash);

  // SELECT by (user_id, hostname) because ON CONFLICT keeps the original row id
  return db.prepare('SELECT * FROM agents WHERE user_id = ? AND hostname = ?').get(userId, hostname);
}

/**
 * Get all agents belonging to a user.
 */
export function getAgentsByUser(userId) {
  const db = getDb();
  return db.prepare('SELECT * FROM agents WHERE user_id = ? ORDER BY created_at ASC').all(userId);
}

/**
 * Get a single agent by ID.
 */
export function getAgentById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) || null;
}

/**
 * Verify an agent's token hash matches.
 */
export function verifyAgentToken(agentId, tokenHash) {
  const db = getDb();
  const agent = db.prepare('SELECT token_hash FROM agents WHERE id = ?').get(agentId);
  return agent ? agent.token_hash === tokenHash : false;
}

/**
 * Update the last_seen_at timestamp for an agent.
 */
export function updateLastSeen(agentId) {
  const db = getDb();
  db.prepare("UPDATE agents SET last_seen_at = datetime('now') WHERE id = ?").run(agentId);
}

/**
 * Update the display name for an agent.
 */
export function updateAgentDisplayName(agentId, displayName) {
  const db = getDb();
  db.prepare('UPDATE agents SET display_name = ? WHERE id = ?').run(displayName || null, agentId);
}

/**
 * Delete an agent by ID.
 */
export function deleteAgent(agentId) {
  const db = getDb();
  db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
}

/**
 * Record the synthetic agent used in dev/local mode.
 *
 * Dev mode mints an agent ID without going through the pairing routes that
 * normally insert into this table, so nothing references it. pane_layouts
 * has a foreign key on agent_id, which means every layout save from such an
 * instance fails and no pane position is ever persisted.
 *
 * The id is fixed by the caller rather than generated, so this cannot reuse
 * registerAgent. UNIQUE(user_id, hostname) may already be taken by a real
 * paired agent on the same machine; in that case the existing row is left
 * alone and its id returned, so the caller references a row that exists
 * either way.
 */
export function upsertDevAgent(id, userId, hostname, os) {
  const db = getDb();

  const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(id);
  if (existing) {
    db.prepare("UPDATE agents SET last_seen_at = datetime('now') WHERE id = ?").run(id);
    return id;
  }

  const byHostname = db.prepare('SELECT id FROM agents WHERE user_id = ? AND hostname = ?').get(userId, hostname);
  if (byHostname) return byHostname.id;

  db.prepare(`
    INSERT INTO agents (id, user_id, hostname, os, token_hash, last_seen_at)
    VALUES (?, ?, ?, ?, 'dev', datetime('now'))
  `).run(id, userId, hostname, os || null);

  return id;
}
