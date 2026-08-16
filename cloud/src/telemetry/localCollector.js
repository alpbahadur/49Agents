/**
 * Local Telemetry Collector — batches events and sends them to the cloud server.
 *
 * Only active when running in local mode with telemetry consent. Flushes every
 * 60 seconds, and does a final flush on process shutdown.
 *
 * Two identity paths exist and either can carry consent:
 *   - local_auth        — the OAuth cloud-auth flow, authenticates with a cloud token
 *   - local_email_auth  — the onboarding flow, authenticates with a server-issued
 *                         instance id sent as X-Instance-Id
 */

import { hostname } from 'os';
import { getLocalAuth } from '../auth/localAuth.js';
import { isLocalMode } from '../auth/localAuth.js';
import { getEmailAuth } from '../auth/emailAuth.js';
import { config } from '../config.js';

const FLUSH_INTERVAL_MS = 60000; // 60 seconds
const MAX_QUEUE_SIZE = 500;

let queue = [];
let flushTimer = null;
let active = false;

/**
 * Resolve the current telemetry identity from whichever auth path is in use.
 * Prefers OAuth cloud auth, falls back to the onboarding email identity.
 *
 * @returns {{ consent: boolean, cloudToken: string|null, instanceId: string|null } | null}
 */
function resolveTelemetryIdentity() {
  const localAuth = getLocalAuth();
  if (localAuth && localAuth.cloudToken) {
    return {
      consent: localAuth.telemetryConsent === 1,
      cloudToken: localAuth.cloudToken,
      instanceId: localAuth.instanceId || null,
    };
  }

  const emailAuth = getEmailAuth();
  if (emailAuth) {
    return {
      consent: emailAuth.telemetryConsent === 1,
      cloudToken: null,
      // Prefer the id the cloud assigned; fall back to our local one so events
      // still land if enrollment has not completed yet.
      instanceId: emailAuth.cloudInstanceId || emailAuth.instanceId || null,
    };
  }

  return null;
}

/**
 * Queue an event for cloud reporting.
 * No-ops if the collector is not active.
 */
export function queueTelemetryEvent(eventType, userId = null, metadata = null) {
  if (!active) return;
  if (queue.length >= MAX_QUEUE_SIZE) return; // prevent unbounded growth

  queue.push({
    event_type: eventType,
    user_id: userId,
    metadata: metadata || {},
    timestamp: new Date().toISOString(),
  });
}

/**
 * Flush queued events to the cloud server.
 */
async function flush() {
  if (queue.length === 0) return;

  const identity = resolveTelemetryIdentity();
  if (!identity || !identity.consent || (!identity.cloudToken && !identity.instanceId)) {
    queue = [];
    return;
  }

  const batch = queue.splice(0);
  const cloudUrl = config.cloudAuthUrl;

  const headers = { 'Content-Type': 'application/json' };
  if (identity.cloudToken) headers['Authorization'] = `Bearer ${identity.cloudToken}`;
  if (identity.instanceId) headers['X-Instance-Id'] = identity.instanceId;

  try {
    const res = await fetch(`${cloudUrl}/api/telemetry/local`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        events: batch,
        instance: {
          id: identity.instanceId,
          hostname: hostname(),
          os: process.platform,
          version: config.version || null,
          telemetry_consent: 1,
        },
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.warn(`[telemetry] Cloud rejected telemetry: ${res.status}`);
      // Don't re-queue on rejection — the data is lost
    }
  } catch (err) {
    // Network error — re-queue the events for next flush
    if (queue.length + batch.length <= MAX_QUEUE_SIZE) {
      queue.unshift(...batch);
    }
    // Suppress noisy logs for expected offline scenarios
    if (err.name !== 'AbortError') {
      console.warn('[telemetry] Failed to send telemetry (will retry):', err.message);
    }
  }
}

/**
 * Initialize the telemetry collector.
 * Only starts if in local mode with telemetry consent granted.
 */
export function initLocalTelemetryCollector() {
  if (!isLocalMode()) return;

  const identity = resolveTelemetryIdentity();
  if (!identity || !identity.consent) {
    console.log('[telemetry] Local telemetry collector inactive (no consent or no auth)');
    return;
  }

  active = true;
  console.log('[telemetry] Local telemetry collector started (flush every 60s)');

  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  flushTimer.unref(); // don't prevent process exit

  // Flush on shutdown
  const shutdownFlush = () => {
    if (queue.length > 0) {
      // Best-effort synchronous-ish flush on exit
      flush().catch(() => {});
    }
  };

  process.on('SIGTERM', shutdownFlush);
  process.on('SIGINT', shutdownFlush);
}

/**
 * Re-evaluate whether telemetry should be active (e.g., after consent changes).
 */
export function refreshTelemetryState() {
  const identity = resolveTelemetryIdentity();
  if (!isLocalMode() || !identity || !identity.consent) {
    active = false;
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    return;
  }

  if (!active) {
    active = true;
    flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
    flushTimer.unref();
    console.log('[telemetry] Local telemetry collector activated');
  }
}
