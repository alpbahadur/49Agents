/**
 * Instance isolation.
 *
 * Several 49Agents stacks can run side by side on one machine (one per
 * worktree, each with its own cloud server on its own port). Without
 * isolation they collide: they share one PID file, one saved cloud URL, one
 * token, and one ttyd port range — so starting the second stack kills the
 * first stack's terminals and `49-agent stop` targets the wrong process.
 *
 * Every instance therefore gets a key derived from the cloud URL it talks to.
 * The default URL keeps the historical flat layout under ~/.49agents/ so
 * existing installs are untouched; any other URL gets its own subdirectory and
 * its own slice of the ttyd port range.
 */

import { createHash } from 'crypto';

export const DEFAULT_CLOUD_URL = 'ws://localhost:1071';

// ttyd listens on one port per terminal. The range is split into fixed-size
// blocks so two instances never probe or reclaim each other's ports.
export const TTYD_RANGE_START = 7700;
export const TTYD_RANGE_END = 7899;
export const TTYD_BLOCK_SIZE = 20;

const TTYD_BLOCK_COUNT = Math.floor((TTYD_RANGE_END - TTYD_RANGE_START + 1) / TTYD_BLOCK_SIZE);

/**
 * Reduce a cloud URL to the identity that matters for isolation: host and
 * port. Scheme and path are ignored so ws:// and wss:// against the same
 * server resolve to the same instance.
 */
function normalizeCloudUrl(cloudUrl) {
  const raw = (cloudUrl || DEFAULT_CLOUD_URL).trim();
  try {
    const url = new URL(raw);
    const port = url.port || (url.protocol === 'wss:' || url.protocol === 'https:' ? '443' : '80');
    return `${url.hostname}:${port}`;
  } catch {
    return raw.replace(/^\w+:\/\//, '').replace(/\/.*$/, '') || 'localhost:1071';
  }
}

/**
 * Compute the instance key for a cloud URL.
 *
 * Returns 'default' for the standard local URL, which maps to the flat
 * ~/.49agents/ layout. Other URLs produce a readable host-port slug, so the
 * directory a maintainer finds on disk names the server it belongs to.
 */
export function getInstanceKey(cloudUrl) {
  if (process.env.TC_INSTANCE) {
    return sanitizeKey(process.env.TC_INSTANCE);
  }

  const normalized = normalizeCloudUrl(cloudUrl);
  if (normalized === normalizeCloudUrl(DEFAULT_CLOUD_URL)) {
    return 'default';
  }

  return sanitizeKey(normalized);
}

function sanitizeKey(value) {
  const slug = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'default';
}

export function isDefaultInstance(instanceKey) {
  return instanceKey === 'default';
}

/**
 * The tmux command prefix for an instance.
 *
 * tmux keeps its sessions per server, and a server is identified by its socket.
 * The default instance uses the standard socket so the sessions a user already
 * has keep working untouched. Any other instance gets a socket of its own, so
 * its terminals never appear in — or get closed by — another instance.
 */
export function getTmuxCommand(instanceKey) {
  if (isDefaultInstance(instanceKey)) return 'tmux';
  return `tmux -L ${instanceKey}`;
}

/**
 * The ttyd port block owned by an instance.
 *
 * 'default' always takes the first block so its terminals keep the ports they
 * have always used. Other instances hash into the remaining blocks. A hash
 * collision between two simultaneously running non-default instances is
 * possible but unlikely, and the consequence is the pre-existing behaviour
 * (they share a range) rather than a new failure mode.
 */
export function getTtydPortRange(instanceKey) {
  if (isDefaultInstance(instanceKey)) {
    return { start: TTYD_RANGE_START, end: TTYD_RANGE_START + TTYD_BLOCK_SIZE - 1 };
  }

  const digest = createHash('sha1').update(instanceKey).digest();
  const blockIndex = 1 + (digest.readUInt32BE(0) % (TTYD_BLOCK_COUNT - 1));
  const start = TTYD_RANGE_START + blockIndex * TTYD_BLOCK_SIZE;

  return { start, end: start + TTYD_BLOCK_SIZE - 1 };
}
