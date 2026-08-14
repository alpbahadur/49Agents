import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CLOUD_URL,
  TTYD_RANGE_START,
  TTYD_RANGE_END,
  TTYD_BLOCK_SIZE,
  getInstanceKey,
  getTtydPortRange,
  getTmuxCommand,
  isDefaultInstance,
} from '../src/instance.js';

/**
 * getInstanceKey reads TC_INSTANCE, so each test that cares about it restores
 * the previous value afterwards.
 */
function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test('the default cloud URL maps to the default instance', () => {
  withEnv('TC_INSTANCE', undefined, () => {
    assert.equal(getInstanceKey(DEFAULT_CLOUD_URL), 'default');
    assert.equal(getInstanceKey(undefined), 'default');
    assert.equal(getInstanceKey(''), 'default');
    // Same server, different scheme and trailing path.
    assert.equal(getInstanceKey('ws://localhost:1071/'), 'default');
  });
});

test('a non-default port produces its own readable key', () => {
  withEnv('TC_INSTANCE', undefined, () => {
    assert.equal(getInstanceKey('ws://localhost:2000'), 'localhost-2000');
    assert.equal(getInstanceKey('ws://192.168.1.10:1071'), '192-168-1-10-1071');
  });
});

test('different ports on the same host are different instances', () => {
  withEnv('TC_INSTANCE', undefined, () => {
    assert.notEqual(getInstanceKey('ws://localhost:2000'), getInstanceKey('ws://localhost:2001'));
  });
});

test('TC_INSTANCE overrides the URL-derived key', () => {
  withEnv('TC_INSTANCE', 'My Worktree', () => {
    assert.equal(getInstanceKey('ws://localhost:2000'), 'my-worktree');
  });
});

test('a malformed cloud URL still yields a usable key', () => {
  withEnv('TC_INSTANCE', undefined, () => {
    const key = getInstanceKey('localhost:2000');
    assert.equal(typeof key, 'string');
    assert.ok(key.length > 0);
    assert.match(key, /^[a-z0-9-]+$/);
  });
});

test('the default instance keeps the original ttyd port block', () => {
  const range = getTtydPortRange('default');
  assert.equal(range.start, TTYD_RANGE_START);
  assert.equal(range.end, TTYD_RANGE_START + TTYD_BLOCK_SIZE - 1);
  assert.ok(isDefaultInstance('default'));
});

test('other instances get a block outside the default one', () => {
  for (const key of ['localhost-2000', 'localhost-2001', '192-168-1-10-1071']) {
    const range = getTtydPortRange(key);
    assert.ok(range.start > TTYD_RANGE_START + TTYD_BLOCK_SIZE - 1, `${key} overlaps the default block`);
    assert.ok(range.end <= TTYD_RANGE_END, `${key} runs past the end of the range`);
    assert.equal(range.end - range.start + 1, TTYD_BLOCK_SIZE);
    assert.ok(!isDefaultInstance(key));
  }
});

test('the port block for an instance is stable across calls', () => {
  const first = getTtydPortRange('localhost-2000');
  const second = getTtydPortRange('localhost-2000');
  assert.deepEqual(first, second);
});

test('the default instance uses the standard tmux server', () => {
  // Sessions a user already has live on the default socket, so the default
  // instance must not pass -L or they would disappear from their dashboard.
  assert.equal(getTmuxCommand('default'), 'tmux');
});

test('other instances get their own tmux socket', () => {
  assert.equal(getTmuxCommand('localhost-2000'), 'tmux -L localhost-2000');
  assert.notEqual(getTmuxCommand('localhost-2000'), getTmuxCommand('localhost-2001'));
});

test('tmux socket names contain no shell-significant characters', () => {
  // The command is interpolated into a shell string, and the socket name also
  // becomes a filename, so the sanitized key must stay simple.
  for (const url of ['ws://localhost:2000', 'ws://192.168.1.10:1071', 'ws://my host:80/x']) {
    const cmd = getTmuxCommand(getInstanceKey(url));
    assert.match(cmd, /^tmux(?: -L [a-z0-9-]+)?$/, `unsafe tmux command: ${cmd}`);
  }
});
