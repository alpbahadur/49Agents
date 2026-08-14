import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Guard against a second agent starting for an instance that already has one.
 *
 * Two agents on one instance share a token, so they authenticate as the same
 * agent and the relay drops whichever connected first; they also drive the
 * same tmux sessions. The CLI checks the instance's PID file before starting.
 *
 * The check is restated here rather than imported, because importing the CLI
 * runs it. These tests pin the behaviour the CLI is expected to have.
 */
function findRunningAgent(pidFile, selfPid = process.pid) {
  if (!existsSync(pidFile)) return null;

  let pid;
  try {
    pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid) return null;

  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    try { rmSync(pidFile); } catch { /* already gone */ }
    return null;
  }
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-guard-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('no PID file means nothing is running', () => {
  withTempDir((dir) => {
    assert.equal(findRunningAgent(join(dir, 'agent.pid')), null);
  });
});

test('a PID file naming a live process reports a conflict', () => {
  withTempDir((dir) => {
    const pidFile = join(dir, 'agent.pid');
    // This test process is a convenient stand-in for a running agent, but it
    // must not look like "ourselves" or the check would skip it.
    writeFileSync(pidFile, String(process.pid));
    assert.equal(findRunningAgent(pidFile, process.pid + 1), process.pid);
  });
});

test('a PID file left by a crashed agent is cleared, not treated as a conflict', () => {
  withTempDir((dir) => {
    const pidFile = join(dir, 'agent.pid');
    // 2^22 is above the default pid_max on Linux and macOS, so no live
    // process can own it.
    writeFileSync(pidFile, '4194304');
    assert.equal(findRunningAgent(pidFile), null);
    assert.equal(existsSync(pidFile), false, 'the stale file should be removed');
  });
});

test('a PID file holding garbage does not block startup', () => {
  withTempDir((dir) => {
    const pidFile = join(dir, 'agent.pid');
    for (const junk of ['', '   ', 'not-a-pid', '-1', '0']) {
      writeFileSync(pidFile, junk);
      assert.equal(findRunningAgent(pidFile), null, `should ignore ${JSON.stringify(junk)}`);
    }
  });
});

test('an agent does not mistake its own PID file for a conflict', () => {
  withTempDir((dir) => {
    const pidFile = join(dir, 'agent.pid');
    writeFileSync(pidFile, String(process.pid));
    assert.equal(findRunningAgent(pidFile, process.pid), null);
  });
});
