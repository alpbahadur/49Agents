/**
 * Agent tarball maintenance.
 *
 * The tarball users download from /dl/49-agent.tar.gz is a build artifact: it
 * is gitignored, so a fresh clone or a new worktree has no copy and the
 * installer 404s. Rather than expecting everyone to remember the tar command,
 * the server builds it on startup when it is missing or older than the agent
 * sources, and prunes builds it has not needed for a while.
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const TARBALL_NAME = '49-agent.tar.gz';

// Builds untouched for this long are removed on startup.
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/**
 * The newest mtime across the agent sources, so we can tell whether the
 * existing tarball predates a code change.
 */
function newestSourceMtime(agentDir) {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        try {
          const m = statSync(full).mtimeMs;
          if (m > newest) newest = m;
        } catch { /* file vanished mid-walk */ }
      }
    }
  };
  walk(agentDir);
  return newest;
}

/**
 * Remove tarballs in the download directory that have not been modified for
 * MAX_AGE_MS. The current build is rebuilt on demand, so an old copy is only
 * taking up space.
 */
function pruneStaleTarballs(dlDir) {
  let entries;
  try {
    entries = readdirSync(dlDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const name of entries) {
    if (!name.endsWith('.tar.gz')) continue;
    const full = join(dlDir, name);
    try {
      if (statSync(full).mtimeMs < cutoff) {
        unlinkSync(full);
        console.log(`[cloud] Removed stale agent tarball: ${name}`);
      }
    } catch { /* already gone */ }
  }
}

/**
 * Ensure /dl/49-agent.tar.gz exists and is at least as new as the agent
 * sources. Returns the tarball path, or null if it could not be built.
 *
 * @param {string} repoRoot - Directory containing agent/ and cloud/
 * @param {string} dlDir - Directory the tarball is served from
 */
export function ensureAgentTarball(repoRoot, dlDir) {
  const agentDir = resolve(repoRoot, 'agent');
  const tarballPath = join(dlDir, TARBALL_NAME);

  if (!existsSync(agentDir)) {
    // Deployments that ship only the cloud half have nothing to build from.
    return existsSync(tarballPath) ? tarballPath : null;
  }

  mkdirSync(dlDir, { recursive: true });
  pruneStaleTarballs(dlDir);

  const tarballMtime = existsSync(tarballPath) ? statSync(tarballPath).mtimeMs : 0;
  if (tarballMtime && tarballMtime >= newestSourceMtime(agentDir)) {
    return tarballPath;
  }

  console.log(`[cloud] Building agent tarball (${tarballMtime ? 'sources changed' : 'missing'})...`);
  const result = spawnSync('tar', ['czf', tarballPath, 'agent/'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: 120000,
  });

  if (result.status !== 0) {
    console.warn('[cloud] Could not build agent tarball:', result.stderr?.trim() || 'tar failed');
    return existsSync(tarballPath) ? tarballPath : null;
  }

  console.log('[cloud] Agent tarball ready at /dl/' + TARBALL_NAME);
  return tarballPath;
}
