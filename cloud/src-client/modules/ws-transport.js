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
    ws.send(JSON.stringify({ type, payload, agentId: agentId || _ctx.getActiveAgentId() }));
    if (type === 'terminal:input') _ctx.telemetry._terminalInputCount++;
  }
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

  // Relay mode: send through WebSocket
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
