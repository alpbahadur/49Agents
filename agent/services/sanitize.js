import { dirname, join, resolve } from 'path';
import { realpathSync } from 'fs';

/**
 * Sanitize a session/identifier name to only allow safe characters.
 * Only allows alphanumeric, dash, and underscore characters.
 */
export function sanitizeIdentifier(name) {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!sanitized) {
    throw new Error('Invalid identifier: must contain alphanumeric, dash, or underscore characters');
  }
  return sanitized.slice(0, 64);
}

/**
 * Escape a string for safe use in shell commands.
 * Uses single quotes to prevent all shell interpretation.
 */
export function escapeShellArg(arg) {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Validate that a number is a positive integer within reasonable bounds.
 */
export function validatePositiveInt(value, max = 10000) {
  const num = Math.floor(value);
  if (num <= 0 || num > max || !Number.isFinite(num)) {
    throw new Error(`Invalid number: must be a positive integer up to ${max}`);
  }
  return num;
}


// Canonical forms of the permitted roots, resolved once. Both the literal and
// the canonical form are kept: on macOS /tmp is a symlink to /private/tmp, so
// the same directory has two names and a caller may legitimately use either.
function canonicalRoots(home) {
  const roots = new Set();
  for (const root of [home, '/tmp']) {
    roots.add(root);
    try {
      roots.add(realpathSync(root));
    } catch {
      // A root that cannot be resolved is still worth matching literally.
    }
  }
  return [...roots];
}

/**
 * Canonicalise a path that may not exist yet.
 *
 * realpath fails outright on a missing path, but the destination of an upload
 * or a directory about to be created is exactly the case that needs checking.
 * So the nearest existing ancestor is resolved and the missing tail is appended
 * to it. Any symlink in the part that does exist is followed, which is the
 * point; the tail contains no traversal segments because the caller's path was
 * normalised before being split.
 */
function canonicalise(absPath) {
  const missing = [];
  let current = absPath;

  for (;;) {
    try {
      return missing.length ? join(realpathSync(current), ...missing) : realpathSync(current);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // A path we are not allowed to inspect cannot be shown to be inside the
        // boundary, and guessing in the permissive direction defeats the check.
        throw new Error(`Working directory path not allowed: ${absPath}`);
      }
      const parent = dirname(current);
      // dirname('/') is '/', so this is the terminating case rather than a loop.
      if (parent === current) return absPath;
      missing.unshift(current.slice(parent === '/' ? 1 : parent.length + 1));
      current = parent;
    }
  }
}

/**
 * Validate and resolve a path the agent has been asked to operate on.
 *
 * Returns the normalised absolute path, which callers should use in place of
 * the one they passed in.
 *
 * The normalisation is the point. This used to prefix-match the string it was
 * handed, so anything starting inside a permitted root passed even when it
 * climbed straight back out:
 *
 *   '/tmp/../etc/shadow'        -> allowed, returned verbatim
 *   '$HOME/../../etc/passwd'    -> allowed
 *
 * Some callers happened to be safe because they called resolve() first, but
 * that was their doing rather than this function's guarantee, and the ones that
 * did not — creating and resuming tmux sessions, which pass a client-supplied
 * working directory straight through — inherited the hole.
 *
 * Relative paths are refused rather than resolved. Resolving them would be
 * against the agent's own working directory, which is not something a caller
 * can reason about, and would quietly turn 'foo' from a refusal into an accept
 * whenever the agent happened to be running under the user's home.
 *
 * Symlinks are followed, so a link inside a permitted root that points outside
 * it is refused rather than granting access to its target. That has to cope
 * with paths which do not exist yet — an upload destination, a directory about
 * to be created — so the nearest existing ancestor is canonicalised and the
 * remaining segments appended to it. The remainder cannot itself climb out,
 * because the path is normalised before it is split.
 */
export function validateWorkingDirectory(workingDir) {
  if (typeof workingDir !== 'string' || workingDir === '') {
    throw new Error(`Working directory path not allowed: ${workingDir}`);
  }

  const home = process.env.HOME || '/home';
  let expandedPath = workingDir;

  // Only a leading ~ is a home reference; one in the middle of a name is a
  // literal character, and replace() without an anchor would rewrite it.
  if (expandedPath === '~') {
    expandedPath = home;
  } else if (expandedPath.startsWith('~/')) {
    expandedPath = home + expandedPath.slice(1);
  }

  if (!expandedPath.startsWith('/')) {
    throw new Error(`Working directory path not allowed: ${workingDir}`);
  }

  // Collapses '..', '.' and duplicate separators, so the check below sees where
  // the path actually lands rather than where it starts out.
  const resolved = resolve(expandedPath);
  // Then follow symlinks, so a link out of a permitted root is caught too.
  const canonical = canonicalise(resolved);

  const isAllowed = canonicalRoots(home).some(prefix =>
    canonical === prefix || canonical.startsWith(prefix + '/')
  );

  if (!isAllowed) {
    throw new Error(`Working directory path not allowed: ${workingDir}`);
  }

  return canonical;
}
