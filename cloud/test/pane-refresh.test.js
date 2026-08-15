import test from 'node:test';
import assert from 'node:assert/strict';
import { clearPaneRefresh } from '../src-client/modules/pane-refresh.js';

/**
 * Git-graph, folder and beads panes poll their agent on an interval whose id
 * lives in a per-type Map. Their render functions re-run whenever an agent
 * reconnects, so without this teardown each render overwrote the Map entry and
 * stranded the previous timer: unreachable, still firing, still holding the
 * detached pane subtree alive through its closure.
 *
 * These tests pin the teardown contract rather than any one render function,
 * so they keep describing the requirement if the call sites move.
 */

/** Minimal stand-in for setInterval ids, tracking what was cleared. */
function fakeTimers() {
  const cleared = [];
  const originalClear = globalThis.clearInterval;
  globalThis.clearInterval = (id) => cleared.push(id);
  return { cleared, restore: () => { globalThis.clearInterval = originalClear; } };
}

function withTimers(fn) {
  const t = fakeTimers();
  try {
    fn(t);
  } finally {
    t.restore();
  }
}

test('clears the pending interval and drops the entry', () => {
  withTimers(({ cleared }) => {
    const panes = new Map([['p1', { refreshInterval: 42 }]]);
    clearPaneRefresh(panes, 'p1');
    assert.deepEqual(cleared, [42]);
    assert.equal(panes.has('p1'), false);
  });
});

test('a re-render never strands the previous timer', () => {
  withTimers(({ cleared }) => {
    const panes = new Map();

    // Three renders of the same pane, as an agent flapping offline/online
    // would produce. Each starts a new poll after tearing down the last.
    for (const id of [1, 2, 3]) {
      clearPaneRefresh(panes, 'p1');
      panes.set('p1', { refreshInterval: id });
    }

    // Timers 1 and 2 were superseded and must have been cleared; 3 is live.
    assert.deepEqual(cleared, [1, 2]);
    assert.equal(panes.get('p1').refreshInterval, 3);
    assert.equal(panes.size, 1, 'one entry per pane id, not one per render');
  });
});

test('leaves other panes untouched', () => {
  withTimers(({ cleared }) => {
    const panes = new Map([['p1', { refreshInterval: 1 }], ['p2', { refreshInterval: 2 }]]);
    clearPaneRefresh(panes, 'p1');
    assert.deepEqual(cleared, [1]);
    assert.equal(panes.has('p2'), true);
  });
});

test('tolerates a first render, a missing timer, and a missing map', () => {
  withTimers(({ cleared }) => {
    const panes = new Map();
    // First render: nothing registered yet.
    clearPaneRefresh(panes, 'never-rendered');
    // Entry exists but the poll was never started.
    panes.set('p1', {});
    clearPaneRefresh(panes, 'p1');
    assert.equal(panes.has('p1'), false);
    // Map absent entirely — must not throw.
    clearPaneRefresh(undefined, 'p1');
    assert.deepEqual(cleared, [], 'nothing to clear, so nothing cleared');
  });
});
