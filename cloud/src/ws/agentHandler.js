/**
 * Agent WebSocket Connection Handler
 *
 * Handles incoming WebSocket connections from agents on the /agent-ws endpoint.
 * Agents connect without authentication on the HTTP upgrade -- they must send
 * an agent:auth message with a valid JWT token as their first message within
 * 10 seconds.
 *
 * After authentication:
 * - Agent is registered in userAgents state map
 * - All browsers for the user are notified (agent:online)
 * - Messages from the agent are forwarded to all user browsers (with agentId)
 * - agent:pong messages update last_seen in the database
 * - On disconnect, browsers are notified (agent:offline)
 */

import { WebSocket } from 'ws';
import { verifyAgentToken } from '../auth/agentAuth.js';
import { updateLastSeen, getAgentById } from '../db/agents.js';
import { checkAgentLimit } from '../billing/enforcement.js';
import { recordEvent } from '../db/events.js';
import { isVersionOutdated } from '../utils/version.js';

/**
 * Handle a newly connected agent WebSocket.
 *
 * @param {WebSocket} ws - The agent WebSocket connection
 * @param {Map} userAgents - userId -> Map<agentId, { ws, hostname, os, version }>
 * @param {Map} userBrowsers - userId -> Set<WebSocket>
 */
export function handleAgentConnection(ws, userAgents, userBrowsers, latestAgentVersion) {
  let authenticated = false;
  let agentId = null;
  let userId = null;
  let connectedAt = null;

  // Agent must send agent:auth as first message within 10 seconds
  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      ws.send(JSON.stringify({
        type: 'agent:auth:fail',
        payload: { reason: 'Auth timeout -- must authenticate within 10 seconds' },
      }));
      ws.close();
    }
  }, 10000);

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (!authenticated) {
        if (msg.type === 'agent:auth') {
          // Verify the agent token
          try {
            const result = await verifyAgentToken(msg.payload.token, msg.payload.instanceKey);
            agentId = result.agentId;
            userId = result.userId;
            authenticated = true;
            clearTimeout(authTimeout);

            // Check agent limit before registering (skip if this agent is reconnecting)
            const isReconnect = userAgents.get(userId)?.has(agentId);
            const blocked = !isReconnect && checkAgentLimit(userId, userAgents);
            if (blocked) {
              ws.send(JSON.stringify({
                type: 'agent:auth:fail',
                payload: { reason: blocked.message },
              }));
              // Also notify browsers so they can show upgrade prompt
              broadcastToBrowsers(userId, userBrowsers, {
                type: 'tier:limit',
                payload: blocked,
              });
              ws.close();
              return;
            }

            // Register agent in the state map
            if (!userAgents.has(userId)) {
              userAgents.set(userId, new Map());
            }
            // An existing connection for this agent is either a reconnect
            // whose old socket has not been cleaned up yet, or a genuine
            // second agent started against the same instance.
            //
            // Replacing a live connection is what makes a running agent
            // vanish: both processes drive the same terminals, and whichever
            // authenticated first is silently dropped. So a connection that
            // is still open wins, and the newcomer is turned away with an
            // explanation. A socket that is closing or closed is a stale
            // reconnect and gets replaced as before.
            const existingAgent = userAgents.get(userId).get(agentId);
            if (existingAgent && existingAgent.ws !== ws) {
              const previous = existingAgent.ws;
              if (previous.readyState === WebSocket.OPEN) {
                console.warn(`[ws:agent] Rejected duplicate connection for ${agentId} (${msg.payload.hostname}) — an agent is already connected`);
                ws.send(JSON.stringify({
                  type: 'agent:auth:fail',
                  payload: {
                    reason: 'Another agent is already connected for this machine. Stop it first, or point this agent at a different server.',
                    code: 'duplicate_agent',
                  },
                }));
                ws.close();
                return;
              }
              previous._replaced = true;
              previous.close();
            }
            // Normalize OS name: Node's process.platform reports 'darwin' but UI expects 'macos'
            const agentOs = msg.payload.os === 'darwin' ? 'macos' : (msg.payload.os || 'unknown');
            // Look up created_at from DB for chronological ordering
            const agentRecord = getAgentById(agentId);
            const createdAt = agentRecord?.created_at || new Date().toISOString();
            userAgents.get(userId).set(agentId, {
              ws,
              hostname: msg.payload.hostname || 'unknown',
              displayName: agentRecord?.display_name || null,
              os: agentOs,
              version: msg.payload.version || null,
              createdAt,
              missedPings: 0,
            });

            // Update last_seen in DB
            updateLastSeen(agentId);

            // Send auth success to the agent
            ws.send(JSON.stringify({
              type: 'agent:auth:ok',
              payload: { agentId },
            }));

            connectedAt = Date.now();
            recordEvent('agent.connect', userId, {
              agentId, hostname: msg.payload.hostname, os: agentOs, version: msg.payload.version || null,
            });
            const connType = isReconnect ? 'reconnected' : 'new connection';
            console.log(`[ws:agent] Authenticated: ${agentId} (${msg.payload.hostname}) for user ${userId} [${connType}]`);

            // Notify all browsers for this user that the agent is online
            broadcastToBrowsers(userId, userBrowsers, {
              type: 'agent:online',
              payload: {
                agentId,
                hostname: msg.payload.hostname,
                displayName: agentRecord?.display_name || null,
                os: agentOs,
                version: msg.payload.version,
                createdAt,
              },
            });

            // Check if agent is outdated and notify
            if (isVersionOutdated(msg.payload.version, latestAgentVersion)) {
              const updatePayload = {
                agentId,
                currentVersion: msg.payload.version,
                latestVersion: latestAgentVersion,
              };
              // Tell the agent
              ws.send(JSON.stringify({ type: 'update:available', payload: updatePayload }));
              // Tell browsers
              broadcastToBrowsers(userId, userBrowsers, {
                type: 'update:available',
                payload: updatePayload,
              });
            }
          } catch (err) {
            console.error('[ws:agent] Auth failed:', err.message);
            ws.send(JSON.stringify({
              type: 'agent:auth:fail',
              payload: { reason: err.message },
            }));
            ws.close();
          }
        } else {
          // First message was not agent:auth -- reject
          ws.send(JSON.stringify({
            type: 'agent:auth:fail',
            payload: { reason: 'Must authenticate first -- send agent:auth as first message' },
          }));
          ws.close();
        }
        return;
      }

      // --- Authenticated message handling ---

      // Handle agent:pong (heartbeat response) -- update last_seen and mark
      // the connection live again, so the heartbeat does not terminate it.
      if (msg.type === 'agent:pong') {
        const agentInfo = userAgents.get(userId)?.get(agentId);
        if (agentInfo) agentInfo.missedPings = 0;
        updateLastSeen(agentId);
        return;
      }

      // Cache claude:states so new browsers get them immediately on connect
      if (msg.type === 'claude:states') {
        const agentInfo = userAgents.get(userId)?.get(agentId);
        if (agentInfo) agentInfo.lastClaudeStates = msg.payload;
      }

      // Forward update:progress to browsers
      if (msg.type === 'update:progress') {
        console.log(`[ws:agent] Forwarding update:progress from ${agentId}: ${msg.payload?.status}`);
        broadcastToBrowsers(userId, userBrowsers, { ...msg, agentId });
        return;
      }

      // Forward all other messages to the user's browsers (add agentId)
      broadcastToBrowsers(userId, userBrowsers, { ...msg, agentId });
    } catch (err) {
      console.error('[ws:agent] Error handling message:', err);
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);

    // Skip cleanup if this connection was replaced by a newer one
    if (ws._replaced) return;

    if (authenticated && userId && agentId) {
      // Record disconnect event before removing from map
      const agentInfo = userAgents.get(userId)?.get(agentId);
      const durationMs = connectedAt ? Date.now() - connectedAt : null;
      recordEvent('agent.disconnect', userId, {
        agentId, hostname: agentInfo?.hostname || null, duration_ms: durationMs,
      });

      // Remove agent from state map
      userAgents.get(userId)?.delete(agentId);
      if (userAgents.get(userId)?.size === 0) {
        userAgents.delete(userId);
      }

      console.log(`[ws:agent] Disconnected: ${agentId} for user ${userId}`);

      // Notify browsers that this agent went offline
      broadcastToBrowsers(userId, userBrowsers, {
        type: 'agent:offline',
        payload: { agentId },
      });
    }
  });

  ws.on('error', (err) => {
    console.error(`[ws:agent] WebSocket error (${agentId || 'unauthenticated'}):`, err.message);
  });
}

/**
 * Send a message to all connected browsers for a given user.
 */
function broadcastToBrowsers(userId, userBrowsers, message) {
  const browsers = userBrowsers.get(userId);
  if (!browsers) return;

  const data = JSON.stringify(message);
  for (const browserWs of browsers) {
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(data);
    }
  }
}
