import test from 'node:test';
import assert from 'node:assert/strict';
import { initPaneInteractionDeps, findResizeSnapTargets } from '../src-client/modules/pane-interaction.js';

/**
 * The bottom-left resize handle drags the pane's LEFT edge, which the original
 * snap search never modelled — it only ever compared the right and bottom
 * edges. These tests pin the direction-aware behaviour: with
 * horizontalEdge 'left' the anchored right edge is supplied by the caller
 * (paneData.x/width mutate mid-drag) and snapWidth is measured back from it.
 */

const SNAP_GAP = 10;

function withPanes(panes, fn) {
  const prevDocument = global.document;
  global.document = {
    getElementById: (id) => (panes.some(p => `pane-${p.id}` === id) ? { style: {} } : null),
  };
  initPaneInteractionDeps({ state: { panes } });
  try {
    fn();
  } finally {
    global.document = prevDocument;
  }
}

test('right-edge resize snaps the right edge to a neighbour on the right', () => {
  const target = { id: 'a', x: 100, y: 100, width: 200, height: 200 };
  const neighbour = { id: 'b', x: 340, y: 100, width: 200, height: 200 };

  withPanes([target, neighbour], () => {
    // Right edge lands at 330, five px short of the 340 - GAP snap line.
    const snaps = findResizeSnapTargets(target, 230, 200);
    assert.ok(snaps?.w, 'expected a width snap');
    assert.equal(snaps.w.snapWidth, neighbour.x - target.x - SNAP_GAP);
  });
});

test('left-edge resize snaps the left edge to a neighbour on the left', () => {
  const target = { id: 'a', x: 300, y: 100, width: 200, height: 200 };
  const neighbour = { id: 'b', x: 60, y: 100, width: 200, height: 200 };
  const anchoredRight = target.x + target.width; // 500

  withPanes([target, neighbour], () => {
    // Growing leftward: left edge would sit at 500 - 220 = 280, close to the
    // neighbour's right edge (260) plus the gap.
    const snaps = findResizeSnapTargets(target, 220, 200, 'left', anchoredRight);
    assert.ok(snaps?.w, 'expected a width snap');
    const neighbourRight = neighbour.x + neighbour.width;
    assert.equal(snaps.w.snapWidth, anchoredRight - neighbourRight - SNAP_GAP);
    // Resulting left edge sits one gap clear of the neighbour.
    assert.equal(anchoredRight - snaps.w.snapWidth, neighbourRight + SNAP_GAP);
  });
});

test('left-edge resize aligns the left edge with a neighbour left edge', () => {
  const target = { id: 'a', x: 300, y: 100, width: 200, height: 200 };
  const neighbour = { id: 'b', x: 150, y: 100, width: 100, height: 200 };
  const anchoredRight = 500;

  withPanes([target, neighbour], () => {
    // Left edge would sit at 500 - 340 = 160, ten px from the neighbour's 150.
    const snaps = findResizeSnapTargets(target, 340, 200, 'left', anchoredRight);
    assert.ok(snaps?.w, 'expected a width snap');
    assert.equal(snaps.w.snapWidth, anchoredRight - neighbour.x);
  });
});

test('left-edge resize ignores neighbours only reachable to the right', () => {
  const target = { id: 'a', x: 300, y: 100, width: 200, height: 200 };
  // Sits just past the anchored right edge — irrelevant when dragging left.
  const neighbour = { id: 'b', x: 520, y: 100, width: 200, height: 200 };

  withPanes([target, neighbour], () => {
    const snaps = findResizeSnapTargets(target, 220, 200, 'left', 500);
    assert.equal(snaps?.w ?? null, null);
  });
});

test('the anchored right edge overrides stale pane geometry mid-drag', () => {
  // Mimics a drag in progress: paneData.x/width have already been rewritten
  // for the current frame, so only the caller still knows the original right.
  const target = { id: 'a', x: 280, y: 100, width: 220, height: 200 };
  const neighbour = { id: 'b', x: 60, y: 100, width: 200, height: 200 };

  withPanes([target, neighbour], () => {
    const snaps = findResizeSnapTargets(target, 230, 200, 'left', 500);
    assert.ok(snaps?.w, 'expected a width snap');
    assert.equal(snaps.w.snapWidth, 500 - (neighbour.x + neighbour.width) - SNAP_GAP);
  });
});

test('bottom-edge snapping still works while the left edge is the moving one', () => {
  const target = { id: 'a', x: 300, y: 100, width: 200, height: 200 };
  const below = { id: 'b', x: 300, y: 320, width: 200, height: 200 };

  withPanes([target, below], () => {
    // Bottom edge at 100 + 205 = 305, just short of 320 - GAP.
    const snaps = findResizeSnapTargets(target, 220, 205, 'left', 500);
    assert.ok(snaps?.h, 'expected a height snap');
    assert.equal(snaps.h.snapHeight, below.y - target.y - SNAP_GAP);
  });
});
