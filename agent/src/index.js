import { RelayClient } from './relayClient.js';
import { createMessageRouter } from './messageRouter.js';
import { terminalManager } from './terminalManager.js';
import { tmuxService } from '../services/tmux.js';
import { getLocalMetrics } from '../services/metrics.js';
import { MSG } from './protocol.js';
import { config } from './config.js';
import { loadToken } from './auth.js';

let relayClient = null;
let statePollingInterval = null;
let metricsInterval = null;
let lastPushedStates = {};

function hasStateChanged(newStates) {
  const newKeys = Object.keys(newStates);
  const oldKeys = Object.keys(lastPushedStates);
  if (newKeys.length !== oldKeys.length) return true;

  for (const id of newKeys) {
    const n = newStates[id];
    const o = lastPushedStates[id];
    if (!o) return true;
    if (n?.isClaude !== o?.isClaude) return true;
    if (n?.state !== o?.state) return true;
    if (n?.location?.name !== o?.location?.name) return true;
  }
  return false;
}

/**
 * Immediately push current Claude states to the relay if changed.
 * Scrapes tmux panes to detect Claude state via screen content.
 * Skips overlapping calls — if a previous poll is still running, the new one
 * is dropped to avoid piling up concurrent file/process inspections.
 */
let statePollingInFlight = false;
async function pushStatesNow() {
  if (!relayClient || !relayClient.isConnected) return;
  if (statePollingInFlight) return; // Prevent overlapping calls
  statePollingInFlight = true;
  try {
    const t0 = Date.now();
    const states = await tmuxService.getAllClaudeStates();
    const dt = Date.now() - t0;
    if (dt > 500) console.warn(`[Agent] getAllClaudeStates took ${dt}ms`);
    if (!hasStateChanged(states)) return;
    lastPushedStates = states;
    relayClient.send(MSG.CLAUDE_STATES, states);
  } catch {
    // Silently ignore push errors
  } finally {
    statePollingInFlight = false;
  }
}

/**
 * Start polling for Claude states (2s interval).
 * Uses tmux screen scraping — no hooks or user configuration required.
 */
function startStatePolling() {
  if (statePollingInterval) return;

  statePollingInterval = setInterval(() => {
    pushStatesNow();
  }, 2000);
}

function stopStatePolling() {
  if (statePollingInterval) {
    clearInterval(statePollingInterval);
    statePollingInterval = null;
  }
}

/**
 * Start periodic metrics push (every 5s).
 */
let metricsPollingInFlight = false;
function startMetricsPolling() {
  if (metricsInterval) return;

  metricsInterval = setInterval(async () => {
    if (!relayClient || !relayClient.isConnected) return;
    if (metricsPollingInFlight) return;
    metricsPollingInFlight = true;

    try {
      const t0 = Date.now();
      const metrics = await getLocalMetrics();
      const dt = Date.now() - t0;
      if (dt > 500) console.warn(`[Agent] getLocalMetrics took ${dt}ms`);
      relayClient.send(MSG.METRICS, metrics);
    } catch {
      // Silently ignore metrics errors
    } finally {
      metricsPollingInFlight = false;
    }
  }, 5000);
}

function stopMetricsPolling() {
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
  }
}

/**
 * Start the agent: connect to cloud relay, set up message routing, discover terminals.
 */
export async function startAgent(options = {}) {
  const token = options.token || loadToken();
  if (!token) {
    console.error('[Agent] No authentication token found. Run "49-agent login" first.');
    process.exit(1);
  }

  const cloudUrl = options.cloudUrl || config.cloudUrl;

  console.log(`[Agent] Starting 49Agents Agent v${config.version}`);
  console.log(`[Agent] Cloud relay: ${cloudUrl}`);
  console.log(`[Agent] Using saved auth token from ${config.configDir}/agent.json`);

  // Event loop lag detector — logs when the loop is blocked for >500ms
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - 1000; // expected 1000ms between ticks
    if (lag > 500) {
      console.warn(`[Agent] EVENT LOOP LAG: ${lag}ms`);
    }
    lastTick = now;
  }, 1000).unref();

  // Discover existing tmux terminals
  const terminals = await tmuxService.discoverExistingTerminals();
  console.log(`[Agent] Discovered ${terminals.length} existing terminal(s)`);

  // Create relay client
  relayClient = new RelayClient(cloudUrl, token);

  // Create message router that sends responses back through relay
  const handleMessage = createMessageRouter((type, payload, extra) => {
    relayClient.send(type, payload, extra);
  });

  // Wire relay messages to the router with timing
  relayClient.on('message', async (msg) => {
    const t0 = Date.now();
    const detail = msg.type === 'request' ? `${msg.payload?.method} ${msg.payload?.path}` : msg.type;
    await handleMessage(msg);
    const dt = Date.now() - t0;
    if (dt > 500) console.warn(`[Agent] handleMessage(${detail}) took ${dt}ms`);
  });

  relayClient.on('authenticated', async (payload) => {
    console.log('[Agent] Connected and authenticated to cloud relay');
    // Push Claude states immediately on connect (don't wait for first interval)
    await pushStatesNow();
    // Start polling (2s screen scraping) and metrics
    startStatePolling();
    startMetricsPolling();
  });

  relayClient.on('authFailed', (payload) => {
    console.error('[Agent] Authentication failed:', payload?.reason);
    if (payload?.code === 'duplicate_agent') {
      // The token is fine — another agent already holds this machine's slot,
      // so telling the user to log in again would send them the wrong way.
      console.error('[Agent] Stop the other agent with "49-agent stop", or set');
      console.error('[Agent] TC_CLOUD_URL to a different server to run alongside it.');
    } else if (/signature verification failed/i.test(payload?.reason || '')) {
      // Each 49Agents instance (local dev server, a self-hosted deploy, the
      // hosted cloud) signs agent tokens with its own secret. A token minted
      // by one will never verify against another — this isn't a stale token,
      // it's a token for the wrong instance.
      console.error(`[Agent] The saved token isn't valid for ${cloudUrl} — it was likely issued`);
      console.error('[Agent] by a different 49Agents instance (e.g. local vs. cloud-hosted).');
      console.error('[Agent] Open the "Add Machine" dialog on that instance\'s dashboard and');
      console.error('[Agent] run 49-agent login with the token it gives you.');
    } else {
      console.error('[Agent] Please re-run "49-agent login" to get a new token.');
    }
    stopStatePolling();
    stopMetricsPolling();
  });

  relayClient.on('disconnected', () => {
    console.log('[Agent] Disconnected from cloud relay');
  });

  // Connect to cloud
  relayClient.connect();

  // Graceful shutdown
  const shutdown = () => {
    console.log('[Agent] Shutting down...');
    stopStatePolling();
    stopMetricsPolling();
    terminalManager.stopAll();
    if (relayClient) {
      relayClient.disconnect();
    }
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return relayClient;
}
