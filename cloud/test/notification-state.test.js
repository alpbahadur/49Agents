import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearTerminalNotificationState,
  previousClaudeStates,
  notifiedStates,
  snoozedNotifications,
  snoozeCount,
} from '../src-client/modules/notifications.js';

/**
 * These maps are keyed by terminal id and were only pruned on a state
 * transition, which a closed terminal never produces again. Every open/close
 * cycle therefore left entries behind for the lifetime of the tab.
 *
 * snoozeCount is keyed `terminalId:state`, so it needs a prefix sweep — a
 * plain delete on the bare id silently misses every entry.
 */
function reset() {
  previousClaudeStates.clear();
  notifiedStates.clear();
  snoozedNotifications.clear();
  snoozeCount.clear();
}

test('forgets every record for the closed terminal', () => {
  reset();
  previousClaudeStates.set('t1', 'working');
  notifiedStates.set('t1', 'idle');
  snoozedNotifications.set('t1', Date.now() + 1000);
  snoozeCount.set('t1:working', 2);
  snoozeCount.set('t1:permission', 1);

  clearTerminalNotificationState('t1');

  assert.equal(previousClaudeStates.has('t1'), false);
  assert.equal(notifiedStates.has('t1'), false);
  assert.equal(snoozedNotifications.has('t1'), false);
  assert.equal(snoozeCount.size, 0, 'composite keys need a prefix sweep, not a bare delete');
});

test('leaves other terminals intact', () => {
  reset();
  previousClaudeStates.set('t1', 'working');
  previousClaudeStates.set('t2', 'idle');
  snoozeCount.set('t1:working', 1);
  snoozeCount.set('t2:working', 1);

  clearTerminalNotificationState('t1');

  assert.equal(previousClaudeStates.get('t2'), 'idle');
  assert.deepEqual([...snoozeCount.keys()], ['t2:working']);
});

test('does not prefix-match a longer terminal id', () => {
  reset();
  // 't1' must not sweep 't10' — the separator is what makes the prefix safe.
  snoozeCount.set('t10:working', 1);
  previousClaudeStates.set('t10', 'working');

  clearTerminalNotificationState('t1');

  assert.equal(snoozeCount.has('t10:working'), true);
  assert.equal(previousClaudeStates.has('t10'), true);
});

test('closing an unknown terminal is a no-op', () => {
  reset();
  previousClaudeStates.set('t1', 'working');
  clearTerminalNotificationState('never-existed');
  assert.equal(previousClaudeStates.size, 1);
});

test('repeated open and close cycles leave nothing behind', () => {
  reset();
  for (let i = 0; i < 50; i++) {
    const id = `term-${i}`;
    previousClaudeStates.set(id, 'working');
    notifiedStates.set(id, 'idle');
    snoozeCount.set(`${id}:working`, 1);
    clearTerminalNotificationState(id);
  }
  assert.equal(previousClaudeStates.size, 0);
  assert.equal(notifiedStates.size, 0);
  assert.equal(snoozeCount.size, 0);
});
