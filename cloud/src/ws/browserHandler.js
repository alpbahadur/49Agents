/**
 * Browser WebSocket Connection Handler
 *
 * Handles incoming WebSocket connections from browsers on the /ws endpoint.
 * Authentication is already verified during the HTTP upgrade phase in relay.js.
 *
 * Responsibilities:
 * 1. Register browser in the userBrowsers map
 * 2. Send current list of online agents immediately
 * 3. Route messages from browser -> specific agent (by agentId)
 * 4. Clean up on disconnect
 */

import { WebSocket } from 'ws';
import { check as enforcementCheck, getTierInfo } from '../billing/enforcement.js';
import { recordEvent } from '../db/events.js';
import { isVersionOutdated } from '../utils/version.js';
import { getUndismissedNotifications } from '../db/notifications.js';

// Batch relay message counts — flush to DB every 60 seconds
const relayCounters = new Map(); // userId -> count
setInterval(() => {
  for (const [userId, count] of relayCounters) {
    if (count > 0) {
      recordEvent('ws.relay', userId, { count });
    }
  }
  relayCounters.clear();
}, 60000);

/**
 * Handle a newly connected browser WebSocket.
 *
 * @param {WebSocket} ws - The browser WebSocket connection
 * @param {string} userId - The authenticated user's ID
 * @param {Map} userAgents - userId -> Map<agentId, { ws, hostname, os, version }>
 * @param {Map} userBrowsers - userId -> Set<WebSocket>
 */
export function handleBrowserConnection(ws, userId, userAgents, userBrowsers, latestAgentVersion) {
  const connectedAt = Date.now();

  // Attach metadata to the ws object for admin visibility
  ws._connectedAt = connectedAt;
  ws._lastActivity = null;
  ws._userId = userId;

  // Register this browser connection
  if (!userBrowsers.has(userId)) {
    userBrowsers.set(userId, new Set());
  }
  userBrowsers.get(userId).add(ws);

  recordEvent('browser.connect', userId);
  console.log(`[ws:browser] Connected for user ${userId} (${userBrowsers.get(userId).size} total)`);

  // Send the current list of online agents immediately
  const agents = getOnlineAgents(userId, userAgents);
  ws.send(JSON.stringify({ type: 'agents:list', payload: agents }));

  // Send tier info on connect
  const tierInfo = getTierInfo(userId);
  ws.send(JSON.stringify({ type: 'tier:info', payload: tierInfo }));

  // Send any pending notifications
  const pendingNotifs = getUndismissedNotifications(userId);
  if (pendingNotifs.length > 0) {
    ws.send(JSON.stringify({ type: 'notifications:pending', payload: pendingNotifs }));
  }

  // Send cached claude:states for each online agent so browser doesn't wait for next poll
  for (const agent of agents) {
    const agentInfo = userAgents.get(userId)?.get(agent.agentId);
    if (agentInfo?.lastClaudeStates) {
      ws.send(JSON.stringify({
        type: 'claude:states',
        payload: agentInfo.lastClaudeStates,
        agentId: agent.agentId,
      }));
    }
  }

  // Notify browser of any outdated agents
  if (latestAgentVersion) {
    for (const agent of agents) {
      const agentInfo = userAgents.get(userId)?.get(agent.agentId);
      if (agentInfo && isVersionOutdated(agentInfo.version, latestAgentVersion)) {
        ws.send(JSON.stringify({
          type: 'update:available',
          payload: {
            agentId: agent.agentId,
            currentVersion: agentInfo.version,
            latestVersion: latestAgentVersion,
          },
        }));
      }
    }
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Handle browser keepalive pings (no agentId needed)
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      // Route update:install directly to the target agent
      if (msg.type === 'update:install') {
        const agentId = msg.agentId;
        const agentWs = userAgents.get(userId)?.get(agentId)?.ws;
        if (agentWs && agentWs.readyState === WebSocket.OPEN) {
          console.log(`[ws:browser] Routing update:install to agent ${agentId}`);
          agentWs.send(JSON.stringify({ type: 'update:install', payload: msg.payload || {} }));
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            payload: { message: `Agent ${agentId} is not online` },
          }));
        }
        return;
      }

      // Every message from the browser must include an agentId to route to
      const agentId = msg.agentId;
      if (!agentId) {
        ws.send(JSON.stringify({
          type: 'error',
          payload: { message: 'Missing agentId in message' },
        }));
        return;
      }

      // Enforce tier limits before forwarding
      const blocked = enforcementCheck(userId, msg, userAgents);
      if (blocked) {
        ws.send(JSON.stringify({ type: 'tier:limit', payload: blocked }));
        // Also send an error response if this was a request (so the Promise rejects)
        if (msg.type === 'request' && msg.id) {
          ws.send(JSON.stringify({
            type: 'response',
            id: msg.id,
            payload: { status: 403, body: { error: blocked.message } },
          }));
        }
        return;
      }

      relayCounters.set(userId, (relayCounters.get(userId) || 0) + 1);

      // Track last activity only for direct user actions:
      // terminal input, or pane create/update/delete (REST-over-WS mutations)
      if (msg.type === 'terminal:input' || msg.type === 'terminal:pasteImage' ||
          (msg.type === 'request' && msg.payload?.method && msg.payload.method !== 'GET')) {
        ws._lastActivity = Date.now();
      }

      const agentWs = userAgents.get(userId)?.get(agentId)?.ws;
      if (agentWs && agentWs.readyState === WebSocket.OPEN) {
        // Strip agentId before forwarding to the agent (the agent knows who it is)
        const { agentId: _, ...forwarded } = msg;
        agentWs.send(JSON.stringify(forwarded));
      } else {
        ws.send(JSON.stringify({
          type: 'error',
          payload: { message: `Agent ${agentId} is not online` },
        }));
      }
    } catch (err) {
      console.error('[ws:browser] Error handling message:', err);
    }
  });

  ws.on('close', () => {
    userBrowsers.get(userId)?.delete(ws);
    if (userBrowsers.get(userId)?.size === 0) {
      userBrowsers.delete(userId);
    }
    const durationMs = Date.now() - connectedAt;
    recordEvent('browser.disconnect', userId, { duration_ms: durationMs });
    console.log(`[ws:browser] Disconnected for user ${userId}`);
  });

  ws.on('error', (err) => {
    console.error(`[ws:browser] WebSocket error for user ${userId}:`, err.message);
  });
}

/**
 * Get the list of currently online agents for a user.
 */
function getOnlineAgents(userId, userAgents) {
  const agents = userAgents.get(userId);
  if (!agents) return [];

  return Array.from(agents.entries()).map(([agentId, info]) => ({
    agentId,
    hostname: info.hostname,
    displayName: info.displayName || null,
    os: info.os,
    version: info.version,
    online: true,
    createdAt: info.createdAt || null,
  })).sort((a, b) => {
    // Sort by registration date (oldest first)
    if (!a.createdAt) return 1;
    if (!b.createdAt) return -1;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}
