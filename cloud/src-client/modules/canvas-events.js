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
  _ctx.canvasContainer.classList.add('middle-panning');
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
    _ctx.canvasContainer.classList.remove('middle-panning');
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

// Handle touch start for pan/pinch
// Momentum state for touch pan inertia

export function handleTouchStart(e) {
  if (e.target !== _ctx.getCanvas() && e.target !== _ctx.getCanvasContainer()) return;

  // Cancel any in-flight momentum animation
  if (_ctx.panState.momentumRaf) { cancelAnimationFrame(_ctx.panState.momentumRaf); _ctx.panState.momentumRaf = null; }

  if (e.touches.length === 1) {
    e.preventDefault();
    _ctx.setIsPanning(true);
    _ctx.panState.startX = e.touches[0].clientX - _ctx.state.panX;
    _ctx.panState.startY = e.touches[0].clientY - _ctx.state.panY;
    _ctx.panState.lastX = _ctx.state.panX;
    _ctx.panState.lastY = _ctx.state.panY;
    showIframeOverlays();
  } else if (e.touches.length === 2) {
    e.preventDefault();
    _ctx.setIsPanning(false);
    _ctx.panState.initialPinchDistance = getPinchDistance(e.touches);
    _ctx.panState.initialZoom = _ctx.state.zoom;
  }

  // Velocity tracking: store last 3 touch samples for momentum calculation
  const samples = []; // { x, y, t }

  const moveHandler = (moveE) => {
    if (moveE.touches.length === 1 && _ctx.getIsPanning()) {
      moveE.preventDefault();
      _ctx.state.panX = moveE.touches[0].clientX - _ctx.panState.startX;
      _ctx.state.panY = moveE.touches[0].clientY - _ctx.panState.startY;
      _ctx.updateCanvasTransform();

      const now = Date.now();
      samples.push({ x: _ctx.state.panX, y: _ctx.state.panY, t: now });
      if (samples.length > 3) samples.shift();
    } else if (moveE.touches.length === 2) {
      moveE.preventDefault();
      const currentDistance = getPinchDistance(moveE.touches);
      const scale = currentDistance / _ctx.panState.initialPinchDistance;
      const newZoom = Math.max(0.05, Math.min(4, _ctx.panState.initialZoom * scale));

      const centerX = (moveE.touches[0].clientX + moveE.touches[1].clientX) / 2;
      const centerY = (moveE.touches[0].clientY + moveE.touches[1].clientY) / 2;

      setZoom(newZoom, centerX, centerY);
    }
  };

  const endHandler = () => {
    _ctx.setIsPanning(false);
    hideIframeOverlays();
    _ctx.canvasContainer.removeEventListener('touchmove', moveHandler);
    _ctx.canvasContainer.removeEventListener('touchend', endHandler);

    // Compute velocity from recent samples and apply momentum
    if (samples.length >= 2) {
      const oldest = samples[0];
      const newest = samples[samples.length - 1];
      const dt = newest.t - oldest.t;
      if (dt > 0 && dt < 200) { // Only if recent enough to be intentional
        let vx = (newest.x - oldest.x) / dt * 16; // px per frame (~16ms)
        let vy = (newest.y - oldest.y) / dt * 16;
        const friction = 0.92;
        const minV = 0.3;

        const animate = () => {
          vx *= friction;
          vy *= friction;
          if (Math.abs(vx) < minV && Math.abs(vy) < minV) {
            _ctx.panState.momentumRaf = null;
            _ctx.saveViewState();
            return;
          }
          _ctx.state.panX += vx;
          _ctx.state.panY += vy;
          _ctx.updateCanvasTransform();
          _ctx.panState.momentumRaf = requestAnimationFrame(animate);
        };
        _ctx.panState.momentumRaf = requestAnimationFrame(animate);
        return; // saveViewState called when momentum ends
      }
    }
    _ctx.saveViewState();
  };

  _ctx.canvasContainer.addEventListener('touchmove', moveHandler, { passive: false });
  _ctx.canvasContainer.addEventListener('touchend', endHandler);
}

// Get distance between two touch points
export function getPinchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
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
  newZoom = Math.max(0.05, Math.min(4, newZoom));
  const zoomRatio = newZoom / _ctx.state.zoom;
  _ctx.state.panX = centerX - (centerX - _ctx.state.panX) * zoomRatio;
  _ctx.state.panY = centerY - (centerY - _ctx.state.panY) * zoomRatio;
  _ctx.state.zoom = newZoom;

  _ctx.updateCanvasTransform();
  _ctx.saveViewState();
}

