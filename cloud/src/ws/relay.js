/**
 * WebSocket Relay Coordinator
 *
 * Central relay that manages all WebSocket connections for the cloud server.
 * Sets up two WebSocket endpoints:
 *   /ws        - Browser connections (auth via JWT cookie on upgrade)
 *   /agent-ws  - Agent connections (auth via agent:auth message after connect)
 *
 * The relay is a dumb pipe -- it does NOT parse terminal content or store I/O.
 * It simply routes messages between authenticated browsers and their agents.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { jwtVerify } from 'jose';
import { getSecretKey } from '../auth/github.js';
import { getUserById } from '../db/users.js';
import { upsertUser } from '../db/users.js';
import { getLocalAuth } from '../auth/localAuth.js';
import { handleBrowserConnection } from './browserHandler.js';
import { handleAgentConnection } from './agentHandler.js';
import { config } from '../config.js';

// Core state maps
const userAgents = new Map();    // userId -> Map<agentId, { ws, hostname, os, version }>
const userBrowsers = new Map();  // userId -> Set<WebSocket>

/**
 * Parse cookies from a raw HTTP request Cookie header.
 * Returns an object of { name: value } pairs.
 */
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;

  cookieHeader.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });

  return cookies;
}

/**
 * Authenticate a browser WebSocket upgrade request using JWT cookies.
 * Tries tc_access first, then falls back to tc_refresh.
 * Returns the userId on success, or null on failure.
 */
async function authenticateBrowserUpgrade(request) {
  const cookies = parseCookies(request.headers.cookie);
  const accessToken = cookies.tc_access;
  const refreshToken = cookies.tc_refresh;
  const secretKey = getSecretKey();

  // Try access token first
  if (accessToken) {
    try {
      const { payload } = await jwtVerify(accessToken, secretKey);
      const user = getUserById(payload.sub);
      if (user) return user.id;
    } catch (err) {
      // If not an expiry error, token is malformed -- don't try refresh
      if (err.code !== 'ERR_JWT_EXPIRED') return null;
      // Otherwise fall through to refresh token
    }
  }

  // Try refresh token
  if (refreshToken) {
    try {
      const { payload } = await jwtVerify(refreshToken, secretKey);
      if (payload.type !== 'refresh') return null;

      const user = getUserById(payload.sub);
      if (user) return user.id;
    } catch (err) {
      // Refresh token also invalid
      return null;
    }
  }

  return null;
}

/**
 * Set up WebSocket relay on the given HTTP server.
 *
 * Creates two WebSocketServer instances in noServer mode and routes
 * HTTP upgrade requests to the correct one based on URL pathname.
 *
 * @param {http.Server} server - The HTTP server instance
 * @returns {{ browserWss, agentWss, userAgents, userBrowsers }}
 */
export function setupWebSocketRelay(server, options = {}) {
  const wsCompression = {
    zlibDeflateOptions: { level: 1 }, // fastest compression
    threshold: 128, // only compress messages > 128 bytes
  };
  const maxPayload = 1 * 1024 * 1024; // 1 MB — prevents memory exhaustion from oversized messages
  const browserWss = new WebSocketServer({ noServer: true, perMessageDeflate: wsCompression, maxPayload });
  const agentWss = new WebSocketServer({ noServer: true, perMessageDeflate: wsCompression, maxPayload });
  const latestAgentVersion = options.latestAgentVersion || null;

  // Handle HTTP upgrade requests -- route to the correct WSS
  server.on('upgrade', async (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');

    if (url.pathname === '/ws') {
      // Browser WS -- authenticate via JWT cookie (or dev mode bypass)
      try {
        let userId;

        // Dev/local mode: no OAuth configured AND not production
        if (!config.github.clientId && !config.google.clientId && config.nodeEnv !== 'production') {
          if (process.env.SKIP_CLOUD_AUTH) {
            // Escape hatch: use dev user
            const devUser = upsertUser({
              githubId: 'dev-0',
              githubLogin: 'dev-user',
              email: 'dev@localhost',
              displayName: 'Dev User',
              avatarUrl: null,
            });
            userId = devUser.id;
          } else {
            // Local mode: try cloud auth first, then JWT cookies (guest sessions)
            const localAuth = getLocalAuth();
            if (localAuth) {
              const user = getUserById(localAuth.cloudUserId);
              if (user) {
                userId = user.id;
              }
            }
            // Fall through to JWT cookie auth if no cloud auth (supports guest mode)
            if (!userId) {
              userId = await authenticateBrowserUpgrade(request);
            }
            if (!userId) {
              socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
              socket.destroy();
              return;
            }
          }
        } else {
          userId = await authenticateBrowserUpgrade(request);
        }

        if (!userId) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        browserWss.handleUpgrade(request, socket, head, (ws) => {
          handleBrowserConnection(ws, userId, userAgents, userBrowsers, latestAgentVersion);
        });
      } catch (err) {
        console.error('[ws] Browser upgrade auth error:', err);
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      }
    } else if (url.pathname === '/agent-ws') {
      // Agent WS -- no auth on upgrade; auth happens via first message (agent:auth)
      agentWss.handleUpgrade(request, socket, head, (ws) => {
        handleAgentConnection(ws, userAgents, userBrowsers, latestAgentVersion);
      });
    } else {
      socket.destroy();
    }
  });

  // Heartbeat: ping agents every 30s and drop the ones that stopped answering.
  //
  // Terminating unresponsive sockets matters because a connected agent now
  // takes precedence over a newcomer claiming the same agent ID. A socket
  // that is half-open — the machine slept, the network dropped — still reads
  // as OPEN locally, so without this it would hold that claim forever and the
  // agent could never reconnect.
  const heartbeatInterval = setInterval(() => {
    for (const [userId, agents] of userAgents) {
      for (const [agentId, agentInfo] of agents) {
        if (agentInfo.ws.readyState !== WebSocket.OPEN) continue;

        // Two consecutive unanswered pings (about 60s) is taken as dead. The
        // agent answers every ping, so one missed round trip is already
        // unusual; two rules out a single slow moment.
        if (agentInfo.missedPings >= 2) {
          console.warn(`[ws:agent] Agent ${agentId} (${agentInfo.hostname}) stopped responding to pings — closing`);
          agentInfo.ws.terminate();
          continue;
        }

        agentInfo.missedPings = (agentInfo.missedPings || 0) + 1;
        agentInfo.ws.send(JSON.stringify({ type: 'agent:ping' }));
      }
    }
  }, 30000);

  // Clean up on server close
  server.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  console.log('[ws] WebSocket relay initialized (/ws for browsers, /agent-ws for agents)');

  return { browserWss, agentWss, userAgents, userBrowsers };
}
