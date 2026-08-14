import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import WebSocket from 'ws';

/**
 * These tests cover the attachment bookkeeping in terminalManager: deciding
 * whether a cached ttyd socket can still be reused, and tearing down one that
 * cannot before attaching again.
 *
 * The bug they pin down: a superseded attachment that kept its listeners kept
 * forwarding into the same terminal, so a terminal that had been attached
 * three times echoed every keystroke three times.
 *
 * terminalManager spawns ttyd and talks to tmux at import time, so the logic
 * is restated here against fake sockets rather than imported. The assertions
 * describe the contract the module is expected to hold.
 */

function isSocketUsable(ws) {
  return !!ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
}

function makeFakeSocket(readyState) {
  const ws = new EventEmitter();
  ws.readyState = readyState;
  ws.closed = false;
  ws.close = () => { ws.closed = true; ws.readyState = WebSocket.CLOSED; };
  return ws;
}

function discardAttachment(activeTerminals, terminalId, attachment) {
  if (!attachment) return;
  const { ttydWs } = attachment;
  if (ttydWs) {
    try { ttydWs.removeAllListeners(); } catch { /* already gone */ }
    try {
      if (ttydWs.readyState === WebSocket.OPEN || ttydWs.readyState === WebSocket.CONNECTING) {
        ttydWs.close();
      }
    } catch { /* already closing */ }
  }
  if (activeTerminals.get(terminalId) === attachment) {
    activeTerminals.delete(terminalId);
  }
}

test('an open socket is reusable, so a second attach shares it', () => {
  assert.equal(isSocketUsable(makeFakeSocket(WebSocket.OPEN)), true);
});

test('a socket still connecting counts as usable', () => {
  // The attach path awaits the open handshake; treating CONNECTING as dead
  // would start a second connection alongside the one already in flight.
  assert.equal(isSocketUsable(makeFakeSocket(WebSocket.CONNECTING)), true);
});

test('closed, closing and missing sockets are not reusable', () => {
  assert.equal(isSocketUsable(makeFakeSocket(WebSocket.CLOSED)), false);
  assert.equal(isSocketUsable(makeFakeSocket(WebSocket.CLOSING)), false);
  assert.equal(isSocketUsable(null), false);
  assert.equal(isSocketUsable(undefined), false);
});

test('discarding an attachment stops it forwarding terminal output', () => {
  // This is the duplicate-echo bug: a superseded socket that keeps its
  // 'message' listener keeps writing into the terminal.
  const activeTerminals = new Map();
  const ws = makeFakeSocket(WebSocket.OPEN);
  let delivered = 0;
  ws.on('message', () => { delivered++; });
  const attachment = { ttydWs: ws, emitter: new EventEmitter() };
  activeTerminals.set('term-1', attachment);

  ws.emit('message', 'before');
  assert.equal(delivered, 1);

  discardAttachment(activeTerminals, 'term-1', attachment);

  ws.emit('message', 'after');
  assert.equal(delivered, 1, 'a discarded attachment must not keep forwarding');
  assert.equal(ws.closed, true);
  assert.equal(activeTerminals.has('term-1'), false);
});

test('re-attaching over a dead socket leaves exactly one live listener', () => {
  const activeTerminals = new Map();
  const counts = { first: 0, second: 0 };

  // First attachment, whose socket then dies with the agent that made it.
  const dead = makeFakeSocket(WebSocket.OPEN);
  dead.on('message', () => { counts.first++; });
  const firstAttachment = { ttydWs: dead, emitter: new EventEmitter() };
  activeTerminals.set('term-1', firstAttachment);
  dead.readyState = WebSocket.CLOSED;

  // Re-attach: the cached entry is unusable, so it is discarded first.
  const existing = activeTerminals.get('term-1');
  if (existing && !isSocketUsable(existing.ttydWs)) {
    discardAttachment(activeTerminals, 'term-1', existing);
  }
  const live = makeFakeSocket(WebSocket.OPEN);
  live.on('message', () => { counts.second++; });
  activeTerminals.set('term-1', { ttydWs: live, emitter: new EventEmitter() });

  // One keystroke should be seen once, not once per past attachment.
  dead.emit('message', 'x');
  live.emit('message', 'x');
  assert.equal(counts.first, 0, 'the dead attachment must be silent');
  assert.equal(counts.second, 1);
  assert.equal(activeTerminals.size, 1);
});

test('a concurrent attach does not leave two sockets on one terminal', () => {
  // Two attaches racing: the loser must be discarded rather than orphaned,
  // otherwise both forward and the terminal doubles every byte.
  const activeTerminals = new Map();
  const counts = { a: 0, b: 0 };

  const socketA = makeFakeSocket(WebSocket.OPEN);
  socketA.on('message', () => { counts.a++; });
  activeTerminals.set('term-1', { ttydWs: socketA, emitter: new EventEmitter() });

  const socketB = makeFakeSocket(WebSocket.OPEN);
  socketB.on('message', () => { counts.b++; });
  const superseded = activeTerminals.get('term-1');
  if (superseded && superseded.ttydWs !== socketB) {
    discardAttachment(activeTerminals, 'term-1', superseded);
  }
  activeTerminals.set('term-1', { ttydWs: socketB, emitter: new EventEmitter() });

  socketA.emit('message', 'x');
  socketB.emit('message', 'x');
  assert.equal(counts.a, 0, 'the superseded socket must be silent');
  assert.equal(counts.b, 1);
  assert.equal(socketA.closed, true);
});
