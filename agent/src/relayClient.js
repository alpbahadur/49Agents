import { EventEmitter } from 'events';
import WebSocket from 'ws';
import os from 'os';
import { MSG } from './protocol.js';
import { config } from './config.js';

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const PING_TIMEOUT = 45000; // If no ping received in 45s, assume dead

export class RelayClient extends EventEmitter {
  constructor(cloudUrl, authToken) {
    super();
    this.cloudUrl = cloudUrl || config.cloudUrl;
    this.authToken = authToken;
    this.ws = null;
    this.reconnectDelay = INITIAL_RECONNECT_DELAY;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.authenticated = false;
    this.intentionalClose = false;
  }

  connect() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    const url = `${this.cloudUrl}/agent-ws`;
    console.log(`[RelayClient] Connecting to ${url}...`);

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('[RelayClient] Connected to cloud relay');
      this.reconnectDelay = INITIAL_RECONNECT_DELAY;
      this.authenticate();
      this.resetPingTimer();
    });

    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch (err) {
        console.error('[RelayClient] Failed to parse message:', err);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[RelayClient] Connection closed: ${code} ${reason || ''}`);
      this.authenticated = false;
      this.clearPingTimer();
      this.emit('disconnected', { code, reason: reason?.toString() });

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      console.error('[RelayClient] WebSocket error:', err.message);
      // The 'close' event will fire after this, triggering reconnect
    });
  }

  authenticate() {
    this.send(MSG.AGENT_AUTH, {
      token: this.authToken,
      hostname: os.hostname(),
      os: process.platform,
      version: config.version,
      // Lets a dev-mode cloud server tell apart several agents running on the
      // same machine (one per local instance) instead of treating them as one.
      instanceKey: config.instanceKey,
    });
  }

  handleMessage(message) {
    const { type, payload } = message;

    switch (type) {
      case MSG.AGENT_AUTH_OK:
        console.log(`[RelayClient] Authentication successful — agent registered as "${os.hostname()}" (${payload?.agentId || 'unknown'})`);
        this.authenticated = true;
        this.emit('authenticated', payload);
        break;

      case MSG.AGENT_AUTH_FAIL:
        console.error('[RelayClient] Authentication failed:', payload?.reason);
        this.authenticated = false;
        this.emit('authFailed', payload);
        // Don't reconnect on auth failure — token is invalid
        this.intentionalClose = true;
        this.ws.close();
        break;

      case MSG.AGENT_PING:
        this.send(MSG.AGENT_PONG, { timestamp: Date.now() });
        this.resetPingTimer();
        break;

      default:
        // Forward all other messages to the message router
        this.emit('message', message);
        break;
    }
  }

  resetPingTimer() {
    this.clearPingTimer();
    this.pingTimer = setTimeout(() => {
      console.warn('[RelayClient] No ping received in 45s, reconnecting...');
      if (this.ws) {
        this.ws.close();
      }
    }, PING_TIMEOUT);
  }

  clearPingTimer() {
    if (this.pingTimer) {
      clearTimeout(this.pingTimer);
      this.pingTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;

    console.log(`[RelayClient] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff: 1s -> 2s -> 4s -> 8s -> ... -> 30s cap
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  send(type, payload, extra = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      this.ws.send(JSON.stringify({ type, payload, ...extra }));
      return true;
    } catch (err) {
      console.error('[RelayClient] Send error:', err.message);
      return false;
    }
  }

  disconnect() {
    this.intentionalClose = true;
    this.clearPingTimer();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated;
  }
}
