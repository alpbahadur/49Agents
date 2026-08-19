// ─── Canvas Event Listeners ───────────────────────────────────────────────
// Pointer and wheel handling for the canvas itself: panning with the
// left/middle/right button, touch pan and pinch zoom with momentum,
// shift-drag selection rectangles, and the zoom entry point.
//
// The gesture bookkeeping travels as one panState object, so this module
// mutates it in place rather than through a setter per field.

import { renderMinimap, getCanvasBounds } from './minimap.js';
import { setupAddPaneMenu, setupToolbarButtons, setupCustomTooltips, setupCanvasInteraction, setupPasteHandlers, setupMobileNavDrawer } from './menus.js';
import { setupKeyboardShortcuts } from './shortcuts.js';
import { isPlacementActive } from './placement.js';
import { showIframeOverlays, hideIframeOverlays } from './pane-renderers.js';
import { getViewportRect, setupViewportTracking, onViewportResize } from './viewport.js';
import {
  clampZoom, pinchStart, applyPinch, panStart, applyPan, clampPan, fitToBounds,
  computeMomentum, MOMENTUM_FRICTION, MOMENTUM_MIN_VELOCITY,
} from './gestures.js';

let _ctx = null;

export function initCanvasEventsDeps(ctx) { _ctx = ctx; }


export function setupEventListeners() {
  setupAddPaneMenu();
  setupToolbarButtons();
  setupCustomTooltips();
  setupCanvasInteraction();
  setupPasteHandlers();
  setupKeyboardShortcuts();
  setupMobileNavDrawer();

  // The soft keyboard shrinks the visual viewport without resizing the window,
  // so xterm keeps its old row count and the prompt ends up hidden behind the
  // keyboard. Refit whatever is focused whenever that area changes.
  onViewportResize(() => {
    const paneId = _ctx.getExpandedPaneId?.() || _ctx.getLastFocusedPaneId?.();
    const termInfo = paneId && _ctx.terminals?.get(paneId);
    if (!termInfo) return;
    try {
      if (termInfo.safeFitAndSync) termInfo.safeFitAndSync();
      else termInfo.fitAddon?.fit();
    } catch (e) {
      console.error('[Canvas] Terminal refit on viewport change failed:', e);
    }
  });
  setupViewportTracking();

  // Prevent Safari's native pinch-to-zoom (bypasses touch-action: none)
  document.addEventListener('gesturestart', e => e.preventDefault());
  document.addEventListener('gesturechange', e => e.preventDefault());
}

// Handle canvas pan start (mouse)
export function handleCanvasPanStart(e) {
  if (isPlacementActive()) return;
  if (e.target !== _ctx.getCanvas() && e.target !== _ctx.getCanvasContainer()) return;

  // Shift+drag on empty canvas: selection rectangle for broadcast
  if (e.shiftKey) {
    startSelectionRect(e);
    return;
  }

  _ctx.setIsPanning(true);
  _ctx.panState.startX = e.clientX - _ctx.state.panX;
  _ctx.panState.startY = e.clientY - _ctx.state.panY;
  showIframeOverlays();

  const moveHandler = (moveE) => {
    if (!_ctx.getIsPanning()) return;
    _ctx.state.panX = moveE.clientX - _ctx.panState.startX;
    _ctx.state.panY = moveE.clientY - _ctx.panState.startY;
    _ctx.updateCanvasTransform();
  };

  const endHandler = () => {
    _ctx.setIsPanning(false);
    hideIframeOverlays();
    _ctx.saveViewState();
    document.removeEventListener('mousemove', moveHandler);
    document.removeEventListener('mouseup', endHandler);
  };

  document.addEventListener('mousemove', moveHandler);
  document.addEventListener('mouseup', endHandler);
}

export function startSelectionRect(e) {
  const selRect = document.getElementById('selection-rect');
  if (!selRect) return;

  // Convert client coords to canvas coords (account for pan and zoom)
  const startCanvasX = (e.clientX - _ctx.state.panX) / _ctx.state.zoom;
  const startCanvasY = (e.clientY - _ctx.state.panY) / _ctx.state.zoom;

  selRect.style.left = startCanvasX + 'px';
  selRect.style.top = startCanvasY + 'px';
  selRect.style.width = '0px';
  selRect.style.height = '0px';
  selRect.style.display = 'block';

  showIframeOverlays();

  const moveHandler = (moveE) => {
    const curCanvasX = (moveE.clientX - _ctx.state.panX) / _ctx.state.zoom;
    const curCanvasY = (moveE.clientY - _ctx.state.panY) / _ctx.state.zoom;

    const x = Math.min(startCanvasX, curCanvasX);
    const y = Math.min(startCanvasY, curCanvasY);
    const w = Math.abs(curCanvasX - startCanvasX);
    const h = Math.abs(curCanvasY - startCanvasY);

    selRect.style.left = x + 'px';
    selRect.style.top = y + 'px';
    selRect.style.width = w + 'px';
    selRect.style.height = h + 'px';
  };

  const endHandler = () => {
    selRect.style.display = 'none';
    hideIframeOverlays();

    // Get the final rectangle bounds in canvas coords
    const rx = parseFloat(selRect.style.left);
    const ry = parseFloat(selRect.style.top);
    const rw = parseFloat(selRect.style.width);
    const rh = parseFloat(selRect.style.height);

    // Only select if the user actually dragged (not just a shift+click on canvas)
    if (rw > 5 || rh > 5) {
      // Find all panes that overlap the selection rectangle
      _ctx.state.panes.forEach(p => {
        const overlaps =
          p.x < rx + rw &&
          p.x + p.width > rx &&
          p.y < ry + rh &&
          p.y + p.height > ry;

        if (overlaps && !_ctx.selectedPaneIds.has(p.id)) {
          _ctx.selectedPaneIds.add(p.id);
          const el = document.getElementById(`pane-${p.id}`);
          if (el) el.classList.add('broadcast-selected');
        }
      });
      _ctx.updateBroadcastIndicator();
    }

    document.removeEventListener('mousemove', moveHandler);
    document.removeEventListener('mouseup', endHandler);
  };

  document.addEventListener('mousemove', moveHandler);
  document.addEventListener('mouseup', endHandler);
}

// Middle mouse button pan — works even over panes
export function handleMiddleMousePan(e) {
  if (e.button !== 1) return; // only middle mouse
  e.preventDefault();  // prevent browser auto-scroll
  e.stopPropagation(); // prevent pane drag/focus handlers

  _ctx.setIsPanning(true);
  _ctx.panState.startX = e.clientX - _ctx.state.panX;
  _ctx.panState.startY = e.clientY - _ctx.state.panY;
  document.body.style.cursor = 'grabbing';
  _ctx.getCanvasContainer().classList.add('middle-panning');
  showIframeOverlays();

  const moveHandler = (moveE) => {
    if (!_ctx.getIsPanning()) return;
    moveE.preventDefault();
    _ctx.state.panX = moveE.clientX - _ctx.panState.startX;
    _ctx.state.panY = moveE.clientY - _ctx.panState.startY;
    _ctx.updateCanvasTransform();
  };

  const endHandler = (upE) => {
    if (upE.button !== 1) return; // only release on middle mouse up
    _ctx.setIsPanning(false);
    document.body.style.cursor = '';
    _ctx.getCanvasContainer().classList.remove('middle-panning');
    hideIframeOverlays();
    _ctx.saveViewState();
    document.removeEventListener('mousemove', moveHandler);
    document.removeEventListener('mouseup', endHandler);
  };

  document.addEventListener('mousemove', moveHandler);
  document.addEventListener('mouseup', endHandler);
}

// Right mouse button pan — works even over panes (terminals, editors, etc.)
export function handleRightMousePan(e) {
  if (e.button !== 2) return;
  e.preventDefault();
  e.stopPropagation();

  _ctx.setIsPanning(true);
  let didMove = false;
  _ctx.panState.startX = e.clientX - _ctx.state.panX;
  _ctx.panState.startY = e.clientY - _ctx.state.panY;
  document.body.style.cursor = 'grabbing';
  showIframeOverlays();

  // Suppress context menu while dragging
  const suppressContextMenu = (ce) => { ce.preventDefault(); };
  document.addEventListener('contextmenu', suppressContextMenu, true);

  const moveHandler = (moveE) => {
    if (!_ctx.getIsPanning()) return;
    moveE.preventDefault();
    didMove = true;
    _ctx.state.panX = moveE.clientX - _ctx.panState.startX;
    _ctx.state.panY = moveE.clientY - _ctx.panState.startY;
    _ctx.updateCanvasTransform();
  };

  const endHandler = (upE) => {
    if (upE.button !== 2) return;
    _ctx.setIsPanning(false);
    document.body.style.cursor = '';
    hideIframeOverlays();
    _ctx.saveViewState();
    document.removeEventListener('mousemove', moveHandler);
    document.removeEventListener('mouseup', endHandler);
    // Remove context menu suppression after a tick (so the mouseup's contextmenu is still caught)
    setTimeout(() => {
      document.removeEventListener('contextmenu', suppressContextMenu, true);
    }, 0);
  };

  document.addEventListener('mousemove', moveHandler);
  document.addEventListener('mouseup', endHandler);
}

// ─── Touch gestures ───────────────────────────────────────────────────────
// One gesture session spans the whole time fingers are down, and is
// re-baselined whenever the finger count changes. Anchoring only at the
// initial touchstart used to freeze the canvas the moment a pinch dropped to
// one finger, because the pan origin still described a gesture that had
// already ended.

let touchSession = null;

function viewOf() {
  return { panX: _ctx.state.panX, panY: _ctx.state.panY, zoom: _ctx.state.zoom };
}

// Commit a computed view, holding the content box within reach of the
// viewport so a gesture cannot strand the user in empty space.
function commitView(view) {
  const bounded = clampPan(view, getCanvasBounds(), getViewportRect());
  _ctx.state.panX = bounded.panX;
  _ctx.state.panY = bounded.panY;
  if (view.zoom !== undefined) _ctx.state.zoom = view.zoom;
  _ctx.updateCanvasTransform();
}

// Re-anchor the session to the fingers currently down. Called on every change
// in finger count, in either direction.
function rebaseTouchSession(touches) {
  if (!touchSession) return;
  if (touches.length >= 2) {
    touchSession.mode = 'pinch';
    touchSession.pinch = pinchStart(viewOf(), touches);
    touchSession.pan = null;
  } else if (touches.length === 1) {
    touchSession.mode = 'pan';
    touchSession.pan = panStart(viewOf(), touches[0]);
    touchSession.pinch = null;
    touchSession.samples.length = 0;
  }
}

export function handleTouchStart(e) {
  if (isPlacementActive()) return;

  const multiTouch = e.touches.length >= 2;

  // A single finger still only pans from bare canvas: anywhere else it belongs
  // to the pane under it, for scrolling, typing or dragging. Two fingers are
  // unambiguous, so a pinch is honoured wherever it starts — including over a
  // pane, which is most of the screen on a phone and where pinch previously
  // did nothing at all.
  if (!multiTouch && !touchSession) {
    if (e.target !== _ctx.getCanvas() && e.target !== _ctx.getCanvasContainer()) return;
  }

  if (_ctx.panState.momentumRaf) {
    cancelAnimationFrame(_ctx.panState.momentumRaf);
    _ctx.panState.momentumRaf = null;
  }

  e.preventDefault();
  if (multiTouch) e.stopPropagation();

  if (!touchSession) {
    touchSession = { mode: null, pan: null, pinch: null, samples: [] };
    _ctx.getCanvasContainer().addEventListener('touchmove', handleTouchMove, { passive: false, capture: true });
    _ctx.getCanvasContainer().addEventListener('touchend', handleTouchEnd, { capture: true });
    _ctx.getCanvasContainer().addEventListener('touchcancel', handleTouchEnd, { capture: true });
    showIframeOverlays();
  }

  rebaseTouchSession(e.touches);
  _ctx.setIsPanning(touchSession.mode === 'pan');
}

function handleTouchMove(e) {
  if (!touchSession) return;

  // A finger can appear or vanish without a paired event reaching us, so the
  // mode is reconciled against reality rather than trusted.
  if (e.touches.length >= 2 && touchSession.mode !== 'pinch') rebaseTouchSession(e.touches);
  else if (e.touches.length === 1 && touchSession.mode !== 'pan') rebaseTouchSession(e.touches);

  if (touchSession.mode === 'pinch' && e.touches.length >= 2) {
    e.preventDefault();
    e.stopPropagation();
    commitView(applyPinch(touchSession.pinch, e.touches));
  } else if (touchSession.mode === 'pan' && e.touches.length === 1) {
    e.preventDefault();
    const panned = applyPan(touchSession.pan, e.touches[0]);
    commitView({ ...panned, zoom: _ctx.state.zoom });

    touchSession.samples.push({ x: _ctx.state.panX, y: _ctx.state.panY, t: e.timeStamp });
    if (touchSession.samples.length > 3) touchSession.samples.shift();
  }
}

function handleTouchEnd(e) {
  if (!touchSession) return;

  // Fingers remain: the gesture is changing shape, not ending. Re-anchor so a
  // pinch degrades into a pan from the view it actually left behind.
  if (e.touches.length > 0) {
    rebaseTouchSession(e.touches);
    _ctx.setIsPanning(touchSession.mode === 'pan');
    return;
  }

  const samples = touchSession.samples;
  const wasPanning = touchSession.mode === 'pan';
  endTouchSession();

  // touchcancel means the system took the gesture over. Flinging the canvas
  // after an interruption the user did not intend is worse than stopping.
  // e.timeStamp is the release: a finger that stopped and rested fires no
  // further touchmove, so without it a long pause before lifting still flings.
  const momentum = (wasPanning && e.type !== 'touchcancel')
    ? computeMomentum(samples, undefined, e.timeStamp)
    : null;
  if (!momentum) {
    _ctx.saveViewState();
    return;
  }

  let { vx, vy } = momentum;
  const animate = () => {
    vx *= MOMENTUM_FRICTION;
    vy *= MOMENTUM_FRICTION;
    if (Math.abs(vx) < MOMENTUM_MIN_VELOCITY && Math.abs(vy) < MOMENTUM_MIN_VELOCITY) {
      _ctx.panState.momentumRaf = null;
      _ctx.saveViewState();
      return;
    }
    const before = viewOf();
    commitView({ panX: before.panX + vx, panY: before.panY + vy, zoom: before.zoom });
    // Clamping absorbed the movement, so the fling has hit the edge.
    if (_ctx.state.panX === before.panX && _ctx.state.panY === before.panY) {
      _ctx.panState.momentumRaf = null;
      _ctx.saveViewState();
      return;
    }
    _ctx.panState.momentumRaf = requestAnimationFrame(animate);
  };
  _ctx.panState.momentumRaf = requestAnimationFrame(animate);
}

function endTouchSession() {
  if (!touchSession) return;
  touchSession = null;
  _ctx.setIsPanning(false);
  hideIframeOverlays();
  _ctx.getCanvasContainer().removeEventListener('touchmove', handleTouchMove, { capture: true });
  _ctx.getCanvasContainer().removeEventListener('touchend', handleTouchEnd, { capture: true });
  _ctx.getCanvasContainer().removeEventListener('touchcancel', handleTouchEnd, { capture: true });
}

// Frame every pane. The escape hatch for a viewport panned away from all of
// them, where zooming out bottoms out at MIN_ZOOM before anything reappears.
export function zoomToFit() {
  const fit = fitToBounds(getCanvasBounds(), getViewportRect());
  if (!fit) return;
  _ctx.state.panX = fit.panX;
  _ctx.state.panY = fit.panY;
  _ctx.state.zoom = fit.zoom;
  _ctx.updateCanvasTransform();
  _ctx.saveViewState();
  renderMinimap();
}

// Scroll target lock: once a scroll gesture starts on a pane (or canvas),
// keep routing to that target until the gesture ends.
// Touchpad gestures produce small frequent deltas with momentum/inertia gaps,
// so use a longer lock (500ms) to cover the full gesture including inertia.
let scrollLockTimer = null;

export function handleWheel(e) {
  // Ctrl+Scroll anywhere = always canvas zoom
  if (e.ctrlKey) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom(_ctx.state.zoom * delta, e.clientX, e.clientY);
    return;
  }

  // Tab+Scroll anywhere = always pan canvas (even over panes)
  if (_ctx.getTabHeld()) {
    e.preventDefault();
    e.stopPropagation();
    _ctx.state.panX -= e.deltaX || 0;
    _ctx.state.panY -= e.deltaY;
    _ctx.updateCanvasTransform();
    _ctx.saveViewState();
    return;
  }

  // Check if mouse is currently over a pane
  const paneEl = e.target.closest('.pane');
  const onPane = !!paneEl;

  // If mouse is on canvas background, pan the canvas (zoom only via Ctrl+Scroll above)
  if (!onPane) {
    e.preventDefault();
    _ctx.panState.scrollLockTarget = null;
    _ctx.state.panX -= e.deltaX || 0;
    _ctx.state.panY -= e.deltaY;
    _ctx.updateCanvasTransform();
    _ctx.saveViewState();
    return;
  }

  // Mouse is on a pane — Shift+Scroll = pan canvas, normal scroll = let pane handle
  if (e.shiftKey) {
    e.preventDefault();
    _ctx.state.panX -= e.deltaX || e.deltaY;
    _ctx.state.panY -= e.deltaY;
    _ctx.updateCanvasTransform();
    _ctx.saveViewState();
  }
  // Normal scroll on pane: don't preventDefault — let terminal/editor handle it
}

// Set zoom centered on a point
export function setZoom(newZoom, centerX, centerY) {
  // Shares clampZoom with the touch path so the wheel, the buttons and a
  // pinch cannot disagree about the zoom range.
  const zoom = clampZoom(newZoom);
  const zoomRatio = zoom / _ctx.state.zoom;
  _ctx.state.panX = centerX - (centerX - _ctx.state.panX) * zoomRatio;
  _ctx.state.panY = centerY - (centerY - _ctx.state.panY) * zoomRatio;
  _ctx.state.zoom = zoom;

  _ctx.updateCanvasTransform();
  _ctx.saveViewState();
}

