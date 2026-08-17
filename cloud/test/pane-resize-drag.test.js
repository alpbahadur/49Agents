import test from 'node:test';
import assert from 'node:assert/strict';
import { initPaneInteractionDeps, activateResize } from '../src-client/modules/pane-interaction.js';

/**
 * The snap search is covered in pane-resize-snap.test.js; what this file pins
 * is the drag wiring around it — the part that differs between the two
 * handles. Dragging the bottom-left handle has to invert the horizontal delta
 * and walk pane.x leftward while the right edge stays put, where the
 * bottom-right handle leaves x alone.
 *
 * activateResize talks to the DOM through a small surface (classList, style,
 * querySelectorAll, and document-level listeners), so it runs against stubs
 * rather than pulling in a DOM implementation for four tests.
 */

function stubElement() {
  const classes = new Set();
  return {
    style: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    querySelectorAll: () => [],
  };
}

/**
 * Collects the document-level handlers activateResize installs so a test can
 * drive a drag, and restores the globals afterwards.
 */
function withDragHarness(fn) {
  const prevDocument = global.document;
  const handlers = { mousemove: [], mouseup: [] };

  global.document = {
    body: { classList: { add() {}, remove() {} } },
    addEventListener: (type, fn) => { (handlers[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => {
      const list = handlers[type];
      if (list) handlers[type] = list.filter(h => h !== fn);
    },
    getElementById: () => null,
    createElement: () => ({ style: {}, remove() {} }),
  };

  const dragState = {};
  initPaneInteractionDeps({
    // No neighbours, so nothing to snap to. zoom scales the pointer delta
    // into canvas space; 1 keeps screen and canvas pixels the same here.
    state: { panes: [], zoom: 1 },
    dragState,
    showIframeOverlays() {},
    hideIframeOverlays() {},
    syncTabGroupGeometry() {},
    cloudSaveLayout() {},
    terminals: new Map(),
    getCanvas: () => ({ appendChild() {} }),
  });

  const move = (clientX, clientY) => {
    for (const h of handlers.mousemove) {
      h({ clientX, clientY, preventDefault() {}, shiftKey: false });
    }
  };
  const release = () => { for (const h of [...handlers.mouseup]) h(); };

  try {
    fn({ move, release, dragState });
  } finally {
    global.document = prevDocument;
  }
}

test('the bottom-right handle grows the pane and leaves x alone', () => {
  withDragHarness(({ move, release }) => {
    const paneEl = stubElement();
    const paneData = { id: 'a', type: 'note', x: 100, y: 100, width: 200, height: 150 };

    activateResize(paneEl, paneData, { clientX: 300, clientY: 250 }, 'right');
    move(360, 300); // +60 across, +50 down

    assert.equal(paneData.width, 260);
    assert.equal(paneData.height, 200);
    assert.equal(paneData.x, 100, 'x must not move for a right-edge resize');
    assert.equal(paneEl.style.left, undefined, 'the right handle should never write left');
    release();
  });
});

test('the bottom-left handle grows leftward, anchoring the right edge', () => {
  withDragHarness(({ move, release }) => {
    const paneEl = stubElement();
    const paneData = { id: 'a', type: 'note', x: 300, y: 100, width: 200, height: 150 };
    const rightEdge = paneData.x + paneData.width; // 500

    activateResize(paneEl, paneData, { clientX: 300, clientY: 250 }, 'left');
    move(240, 300); // dragged 60px left, 50px down

    assert.equal(paneData.width, 260, 'moving left grows the pane');
    assert.equal(paneData.height, 200);
    assert.equal(paneData.x, 240, 'x follows the dragged left edge');
    assert.equal(paneData.x + paneData.width, rightEdge, 'the right edge stays anchored');
    assert.equal(paneEl.style.left, '240px');
    release();
  });
});

test('dragging the bottom-left handle inward shrinks the pane', () => {
  withDragHarness(({ move, release }) => {
    const paneEl = stubElement();
    const paneData = { id: 'a', type: 'note', x: 300, y: 100, width: 200, height: 150 };

    activateResize(paneEl, paneData, { clientX: 300, clientY: 250 }, 'left');
    move(370, 250); // dragged 70px right, toward the anchored edge

    assert.equal(paneData.width, 130);
    assert.equal(paneData.x, 370);
    assert.equal(paneData.x + paneData.width, 500, 'still anchored');
    release();
  });
});

test('the left edge stops at the minimum width instead of crossing the right one', () => {
  withDragHarness(({ move, release }) => {
    const paneEl = stubElement();
    const paneData = { id: 'a', type: 'note', x: 300, y: 100, width: 200, height: 150 };

    activateResize(paneEl, paneData, { clientX: 300, clientY: 250 }, 'left');
    move(900, 250); // dragged far past the anchored right edge

    assert.equal(paneData.width, 10, 'clamped to the 10px minimum');
    assert.equal(paneData.x, 490, 'x stops one minimum-width short of the right edge');
    assert.ok(paneData.x < 500, 'the pane never inverts');
    release();
  });
});
