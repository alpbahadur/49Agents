// ─── WebSocket Transport ──────────────────────────────────────────────────
// Outbound side of the relay connection: sending messages, and the
// REST-over-WebSocket request/response correlation used in place of fetch()
// for agent-proxied endpoints.
//
// The socket itself is created and owned by app.js, which also handles
// incoming messages — the inbound switch touches most of the app, so it stays
// there. This module reaches the socket through the injected context.
//
// pendingRequests and pendingScanCallbacks are exported because app.js
// resolves them when responses arrive and clears them on disconnect.

import { jsonByteLength, fitsInRelay, formatBytes, RELAY_BUDGET_BYTES } from './payload-budget.js';

let _ctx = null;

export function initWsTransportDeps(ctx) { _ctx = ctx; }

// Pending request/response correlation
export const pendingRequests = new Map();
export const pendingScanCallbacks = new Map(); // id -> onPartial callback for streaming scan results

/**
 * Send a message over the relay. Falls silently when the socket is not open,
 * matching the original behaviour: callers treat sends as best-effort.
 */
export function sendWs(type, payload, agentId) {
  const ws = _ctx.getWs();
  if (ws && ws.readyState === WebSocket.OPEN) {
    const message = { type, payload, agentId: agentId || _ctx.getActiveAgentId() };

    // Oversized is not a failed send: the relay closes the socket, taking every
    // pane with it. Dropping one message is strictly better than that, even
    // for a fire-and-forget caller who will not notice.
    const bytes = jsonByteLength(message);
    if (bytes > RELAY_BUDGET_BYTES) {
      console.error(
        `[WS] Refusing to send ${formatBytes(bytes)} '${type}' message: over the `
        + `${formatBytes(RELAY_BUDGET_BYTES)} relay limit, and sending it would close the connection.`,
      );
      return false;
    }

    ws.send(JSON.stringify(message));
    if (type === 'terminal:input') _ctx.telemetry._terminalInputCount++;
    return true;
  }
  return false;
}

// REST-over-WS: replaces fetch() for agent-proxied endpoints
// Falls back to direct fetch() when no relay/agent is available (local server mode)
// Optional agentId param routes to a specific agent (defaults to activeAgentId)
// options.onPartial: callback(repos[]) called as scan results stream in
export function agentRequest(method, path, body, agentId, options) {
  const { onPartial } = options || {};
  const ws = _ctx.getWs();
  const resolvedAgentId = agentId || _ctx.getActiveAgentId();
  // Local mode: no relay WebSocket or no agent — use direct fetch
  if (!ws || ws.readyState !== WebSocket.OPEN || !resolvedAgentId) {
    const opts = { method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' } };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
    return fetch(path, opts).then(r => {
      if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
      return r.json();
    });
  }

  // Relay mode: send through WebSocket.
  // Checked before anything is queued, because the failure mode for an
  // oversized message is the socket closing rather than the request failing —
  // so 'too big' has to become a rejected promise here or it becomes a dropped
  // connection there. Chunk large payloads instead; see modules/file-upload.js.
  const request = { type: 'request', agentId: resolvedAgentId, payload: { method, path, body } };
  if (!fitsInRelay(request)) {
    return Promise.reject(new Error(
      `${method} ${path}: payload is ${formatBytes(jsonByteLength(request))}, over the `
      + `${formatBytes(RELAY_BUDGET_BYTES)} relay limit`,
    ));
  }

  return new Promise((resolve, reject) => {
    const id = (crypto.randomUUID ? crypto.randomUUID() : 'req_' + Math.random().toString(36).slice(2) + Date.now().toString(36));
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      pendingScanCallbacks.delete(id);
      reject(new Error('Agent request timeout'));
    }, 15000);

    pendingRequests.set(id, { resolve, reject, timeout });
    if (onPartial) pendingScanCallbacks.set(id, onPartial);

    ws.send(JSON.stringify({
      type: 'request',
      id,
      agentId: resolvedAgentId,
      payload: { method, path, body }
    }));
  });
}
