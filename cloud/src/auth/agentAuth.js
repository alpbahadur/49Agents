/**
 * Agent token verification — Placeholder for Phase 3.
 *
 * In Phase 3, agents will authenticate to the cloud relay using
 * signed JWT tokens. This module will handle verification and generation
 * of those tokens.
 */

import { jwtVerify, SignJWT } from 'jose';
import { config } from '../config.js';
import { upsertUser, getUserById } from '../db/users.js';
import { getLocalAuth } from './localAuth.js';

const hasOAuth = !!(config.github.clientId || config.google.clientId);
const isProduction = config.nodeEnv === 'production';
const devModeEnabled = !hasOAuth && !isProduction;

function encodeSecret(secret) {
  return new TextEncoder().encode(secret);
}

/**
 * Verify an agent JWT token.
 *
 * In dev/local mode (no OAuth configured), accepts the special token 'dev'
 * and auto-authenticates as a local dev agent without requiring login.
 *
 * @param {string} token - The JWT token string
 * @param {string} [instanceKey] - Local instance the agent belongs to. Several
 *   agents can run on one machine (one per local server) during development;
 *   this keeps their dev agent IDs distinct so they do not evict each other.
 * @returns {{ agentId: string, userId: string }} Decoded agent identity
 * @throws If the token is invalid or expired
 */
/**
 * The synthetic agent ID used in dev mode. The default instance keeps the
 * original ID so existing local databases and layouts still resolve; other
 * instances get a suffixed ID of their own.
 */
function devAgentId(instanceKey) {
  if (!instanceKey || instanceKey === 'default') return 'agent_dev_local';
  return `agent_dev_local_${String(instanceKey).replace(/[^a-z0-9_-]/gi, '')}`;
}

export async function verifyAgentToken(token, instanceKey) {
  // Dev mode: no OAuth configured AND not production — accept 'dev' token without verification
  if (devModeEnabled && token === 'dev') {
    // Escape hatch: SKIP_CLOUD_AUTH preserves old dev-user behavior
    if (process.env.SKIP_CLOUD_AUTH) {
      const devUser = upsertUser({
        githubId: 'dev-0',
        githubLogin: 'dev-user',
        email: 'dev@localhost',
        displayName: 'Dev User',
        avatarUrl: null,
      });
      return {
        agentId: devAgentId(instanceKey),
        userId: devUser.id,
      };
    }

    // Local mode: use the cloud-authenticated identity
    const localAuth = getLocalAuth();
    if (!localAuth) {
      throw new Error('Local instance not authenticated with cloud. Open the app in your browser to sign in first.');
    }
    const user = getUserById(localAuth.cloudUserId) || upsertUser({
      githubLogin: localAuth.githubLogin,
      email: localAuth.email,
      displayName: localAuth.displayName || 'Local User',
      avatarUrl: localAuth.avatarUrl,
    });
    return {
      agentId: devAgentId(instanceKey),
      userId: user.id,
    };
  }

  const secret = encodeSecret(config.jwt.agentSecret);
  const { payload } = await jwtVerify(token, secret);

  if (payload.type !== 'agent') {
    throw new Error('Invalid token type');
  }

  return {
    agentId: payload.sub,
    userId: payload.userId,
  };
}

/**
 * Generate a JWT token for an agent.
 * @param {string} userId - The owner user ID
 * @param {string} agentId - The agent ID
 * @param {string} hostname - The agent's hostname
 * @returns {Promise<string>} Signed JWT token string
 */
export async function generateAgentToken(userId, agentId, hostname) {
  const secret = encodeSecret(config.jwt.agentSecret);

  return new SignJWT({
    sub: agentId,
    userId,
    hostname,
    type: 'agent',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('365d') // Agent tokens are long-lived
    .sign(secret);
}
