import { createHash, randomBytes } from 'crypto';
import { requireAuth } from '../auth/middleware.js';
import { getAgentsByUser, getAgentById, registerAgent, deleteAgent, updateAgentDisplayName } from '../db/agents.js';
import { deleteLayoutsByAgent } from '../db/layouts.js';
import { generateAgentToken } from '../auth/agentAuth.js';
import { getTierLimits } from '../billing/tiers.js';

// ---------------------------------------------------------------------------
// In-memory store for pending pairing requests (expires in 10 minutes)
// ---------------------------------------------------------------------------
const pendingPairings = new Map(); // code -> { userId, hostname, os, version, status, token, expiresAt }

const PAIRING_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Rate limiter for pair-status endpoint (unauthenticated, brute-force target)
// Allows 5 requests per 10 seconds per IP
// ---------------------------------------------------------------------------
const pairStatusRequests = new Map(); // ip -> { count, windowStart }
const PAIR_RATE_WINDOW_MS = 10_000;
const PAIR_RATE_MAX = 5;

// Sweepers, both of them: they tidy in-memory maps and must never be the
// reason a closed server's process stays alive.
const rateLimitSweep = setInterval(() => {
  const cutoff = Date.now() - PAIR_RATE_WINDOW_MS * 2;
  for (const [ip, entry] of pairStatusRequests) {
    if (entry.windowStart < cutoff) pairStatusRequests.delete(ip);
  }
}, 60_000);
rateLimitSweep.unref?.();

function checkPairRateLimit(ip) {
  const now = Date.now();
  const entry = pairStatusRequests.get(ip);
  if (!entry || (now - entry.windowStart) > PAIR_RATE_WINDOW_MS) {
    pairStatusRequests.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= PAIR_RATE_MAX;
}

/**
 * Generate a 6-character uppercase alphanumeric pairing code.
 */
function generatePairingCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars (0/O, 1/I)
  let code = '';
  const bytes = randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

/**
 * Clean up expired pairings.
 */
function cleanExpiredPairings() {
  const now = Date.now();
  for (const [code, pairing] of pendingPairings) {
    if (now > pairing.expiresAt) {
      pendingPairings.delete(code);
    }
  }
}

// Run cleanup every 2 minutes
const pairingSweep = setInterval(cleanExpiredPairings, 2 * 60 * 1000);
pairingSweep.unref?.();

/**
 * Derive feature limits from the user's subscription tier.
 * Maps canonical tier config to the client-facing shape.
 */
function getFeaturesForTier(tier) {
  const limits = getTierLimits(tier);
  return {
    maxAgents: limits.agents,
    maxTerminalPanes: limits.terminalPanes,
    relay: limits.relay,
    collaboration: limits.collaboration,
  };
}

/**
 * Build user response object (shared by /api/me and /auth/me).
 */
function buildUserResponse(user, agents) {
  const features = getFeaturesForTier(user.tier);
  const resp = {
    id: user.id,
    email: user.email,
    name: user.display_name || user.github_login || user.email,
    login: user.github_login || user.email,
    avatar: user.avatar_url,
    tier: user.tier,
    features,
    agents: agents.map(a => ({
      id: a.id,
      hostname: a.hostname,
      os: a.os,
      version: a.version,
      lastSeen: a.last_seen_at,
    })),
  };
  // app.js starts the guest countdown off this, so a guest session that does
  // not announce itself here silently never expires.
  if (user.is_guest) {
    resp.isGuest = true;
    resp.guestStartedAt = user.guest_started_at;
  }
  return resp;
}

/**
 * Set up API routes on the Express app.
 */
export function setupApiRoutes(app) {
  // GET /api/me — returns the authenticated user's profile
  app.get('/api/me', requireAuth, (req, res) => {
    const user = req.user;
    const agents = getAgentsByUser(user.id);
    res.json(buildUserResponse(user, agents));
  });

  // Alias: /auth/me → same as /api/me
  app.get('/auth/me', requireAuth, (req, res) => {
    const user = req.user;
    const agents = getAgentsByUser(user.id);
    res.json(buildUserResponse(user, agents));
  });

  // GET /api/agents — list the user's registered agents
  app.get('/api/agents', requireAuth, (req, res) => {
    const agents = getAgentsByUser(req.user.id);
    // Strip token_hash from response
    const sanitized = agents.map(({ token_hash, ...rest }) => rest);
    res.json({ agents: sanitized });
  });

  // POST /api/agents/token — generate an agent pairing token
  app.post('/api/agents/token', requireAuth, async (req, res) => {
    try {
      const { hostname, os, version } = req.body || {};

      if (!hostname) {
        return res.status(400).json({ error: 'hostname is required' });
      }

      // Register the agent (upserts if hostname already exists for this user)
      const placeholderHash = 'pending';
      const agent = registerAgent(req.user.id, hostname, os || null, placeholderHash);

      // Generate the agent JWT with the real agent ID
      const token = await generateAgentToken(req.user.id, agent.id, hostname);
      const tokenHash = createHash('sha256').update(token).digest('hex');

      // Update the token hash and version in the database
      const { getDb } = await import('../db/index.js');
      const db = getDb();
      db.prepare('UPDATE agents SET token_hash = ?, version = ? WHERE id = ?')
        .run(tokenHash, version || null, agent.id);

      res.json({
        agentId: agent.id,
        token,
        hostname,
      });
    } catch (err) {
      console.error('[api] Error generating agent token:', err);
      if (err.message?.includes('UNIQUE constraint')) {
        return res.status(409).json({
          error: 'An agent with this hostname is already registered for your account',
        });
      }
      res.status(500).json({ error: 'Failed to generate agent token' });
    }
  });

  // DELETE /api/agents/:id — revoke/delete an agent
  app.delete('/api/agents/:id', requireAuth, (req, res) => {
    const agent = getAgentById(req.params.id);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Ensure the agent belongs to the authenticated user
    if (agent.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    deleteLayoutsByAgent(req.user.id, req.params.id);
    deleteAgent(req.params.id);
    res.json({ ok: true });
  });

  // PATCH /api/agents/:id — update agent display name
  app.patch('/api/agents/:id', requireAuth, (req, res) => {
    const agent = getAgentById(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (agent.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { displayName } = req.body || {};
    if (displayName !== undefined && displayName !== null && typeof displayName !== 'string') {
      return res.status(400).json({ error: 'displayName must be a string' });
    }

    const trimmed = (displayName || '').trim().slice(0, 50);
    updateAgentDisplayName(req.params.id, trimmed || null);
    res.json({ ok: true, displayName: trimmed || null });
  });

  // -------------------------------------------------------------------------
  // Agent Pairing Flow
  //
  // 1. Browser calls POST /api/agents/pair to generate a 6-char code
  // 2. Agent displays the code to the user, then polls GET /api/agents/pair-status
  // 3. User visits /pair?code=XXXXXX in their browser and clicks Approve
  // 4. Browser calls POST /api/agents/approve with the code
  // 5. Agent's next poll returns the token
  // -------------------------------------------------------------------------

  // POST /api/agents/pair — Generate a pairing code for a new agent
  app.post('/api/agents/pair', requireAuth, (req, res) => {
    try {
      const { hostname, os, version } = req.body || {};

      if (!hostname) {
        return res.status(400).json({ error: 'hostname is required' });
      }

      // Generate a unique 6-char code
      let code = generatePairingCode();
      let attempts = 0;
      while (pendingPairings.has(code) && attempts < 10) {
        code = generatePairingCode();
        attempts++;
      }

      // Store the pending pairing
      pendingPairings.set(code, {
        userId: req.user.id,
        hostname,
        os: os || null,
        version: version || null,
        status: 'pending',   // pending | approved
        token: null,          // filled on approval
        agentId: null,        // filled on approval
        expiresAt: Date.now() + PAIRING_TTL_MS,
      });

      console.log(`[api] Pairing code generated: ${code} for user ${req.user.id} (${hostname})`);

      res.json({
        code,
        pairUrl: `/pair?code=${code}`,
        expiresIn: PAIRING_TTL_MS / 1000,
      });
    } catch (err) {
      console.error('[api] Error generating pairing code:', err);
      res.status(500).json({ error: 'Failed to generate pairing code' });
    }
  });

  // GET /api/agents/pair-status — Agent polls this to check if pairing was approved
  app.get('/api/agents/pair-status', (req, res) => {
    const ip = req.ip || 'unknown';
    if (!checkPairRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    const { code } = req.query;

    if (!code) {
      return res.status(400).json({ error: 'code is required' });
    }

    const pairing = pendingPairings.get(code);

    if (!pairing) {
      return res.status(404).json({ error: 'Pairing code not found or expired' });
    }

    // Check if expired
    if (Date.now() > pairing.expiresAt) {
      pendingPairings.delete(code);
      return res.status(410).json({ error: 'Pairing code has expired' });
    }

    if (pairing.status === 'approved') {
      // Return the token and clean up
      const response = {
        status: 'approved',
        token: pairing.token,
        agentId: pairing.agentId,
      };
      pendingPairings.delete(code);
      return res.json(response);
    }

    // Still pending
    res.json({ status: 'pending' });
  });

  // POST /api/agents/approve — Browser approves a pairing request
  app.post('/api/agents/approve', requireAuth, async (req, res) => {
    try {
      const { code } = req.body || {};

      if (!code) {
        return res.status(400).json({ error: 'code is required' });
      }

      const pairing = pendingPairings.get(code);

      if (!pairing) {
        return res.status(404).json({ error: 'Pairing code not found or expired' });
      }

      // Check if expired
      if (Date.now() > pairing.expiresAt) {
        pendingPairings.delete(code);
        return res.status(410).json({ error: 'Pairing code has expired' });
      }

      // Verify the code belongs to the authenticated user
      if (pairing.userId !== req.user.id) {
        return res.status(403).json({ error: 'This pairing code does not belong to your account' });
      }

      // Already approved?
      if (pairing.status === 'approved') {
        return res.json({ ok: true, agentId: pairing.agentId, message: 'Already approved' });
      }

      // Register the agent in the database
      const placeholderHash = 'pending';
      const agent = registerAgent(req.user.id, pairing.hostname, pairing.os, placeholderHash);

      // Generate a long-lived agent JWT
      const token = await generateAgentToken(req.user.id, agent.id, pairing.hostname);
      const tokenHash = createHash('sha256').update(token).digest('hex');

      // Update the token hash and version in the database
      const { getDb } = await import('../db/index.js');
      const db = getDb();
      db.prepare('UPDATE agents SET token_hash = ?, version = ? WHERE id = ?')
        .run(tokenHash, pairing.version || null, agent.id);

      // Mark pairing as approved and store the token for the agent to retrieve
      pairing.status = 'approved';
      pairing.token = token;
      pairing.agentId = agent.id;

      console.log(`[api] Pairing approved: ${code} -> agent ${agent.id} for user ${req.user.id}`);

      res.json({ ok: true, agentId: agent.id });
    } catch (err) {
      console.error('[api] Error approving pairing:', err);
      if (err.message?.includes('UNIQUE constraint')) {
        return res.status(409).json({
          error: 'An agent with this hostname is already registered for your account',
        });
      }
      res.status(500).json({ error: 'Failed to approve pairing' });
    }
  });

}
