// ─── Gesture Math ─────────────────────────────────────────────────────────
// Pure viewport arithmetic for canvas pan and zoom. Nothing here touches the
// DOM or the app context, so the behaviour that used to be buried inside
// touch handlers can be exercised directly by the test suite.
//
// A "view" is {panX, panY, zoom} and is never mutated: every function returns
// a fresh view. Screen space relates to world space as
// screen = world * zoom + pan.

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;

export function clampZoom(zoom) {
  // Only NaN needs rescuing: it would poison the transform and every
  // subsequent gesture. An infinite scale is a legitimate overshoot and
  // clamps to the ceiling like any other too-large value.
  if (Number.isNaN(zoom)) return 1;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

const WHEEL_ZOOM_SENSITIVITY = 0.008;
const WHEEL_ZOOM_MAX_STEP = 0.05;

// Trackpad pinch-to-zoom is delivered as ctrl+wheel with deltaY scaled to
// gesture speed, so the zoom factor must scale with |deltaY| too — a flat
// per-event ratio compounds multiplicatively across the many small events
// a fling's momentum tail produces, turning a light pinch into a runaway
// zoom. Clamping the per-event factor keeps any single wheel tick — real
// or momentum — from moving the zoom by more than a small, steady amount.
export function wheelZoomFactor(deltaY) {
  const step = Math.max(-WHEEL_ZOOM_MAX_STEP, Math.min(WHEEL_ZOOM_MAX_STEP, -deltaY * WHEEL_ZOOM_SENSITIVITY));
  return 1 + step;
}

export function pinchDistance(a, b) {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

export function pinchCenter(a, b) {
  return {
    x: (a.clientX + b.clientX) / 2,
    y: (a.clientY + b.clientY) / 2,
  };
}

// Zoom about a fixed screen point, keeping the world point under it in place.
export function applyZoomAt(view, newZoom, centerX, centerY) {
  const zoom = clampZoom(newZoom);
  const ratio = zoom / view.zoom;
  return {
    panX: centerX - (centerX - view.panX) * ratio,
    panY: centerY - (centerY - view.panY) * ratio,
    zoom,
  };
}

// Baseline captured when a two-finger gesture begins, or is re-established
// after a finger is added or lifted mid-gesture.
export function pinchStart(view, touches) {
  const center = pinchCenter(touches[0], touches[1]);
  return {
    distance: pinchDistance(touches[0], touches[1]),
    zoom: view.zoom,
    panX: view.panX,
    panY: view.panY,
    centerX: center.x,
    centerY: center.y,
  };
}

// Scale and translate in one step. Zooming about the pinch midpoint alone is
// not enough: dragging two fingers across the screen has to move the canvas
// with them, which means tracking how far the midpoint itself has travelled.
export function applyPinch(start, touches) {
  if (!start || !start.distance) {
    return { panX: start?.panX ?? 0, panY: start?.panY ?? 0, zoom: start?.zoom ?? 1 };
  }
  const scale = pinchDistance(touches[0], touches[1]) / start.distance;
  const zoom = clampZoom(start.zoom * scale);
  const center = pinchCenter(touches[0], touches[1]);

  // World point that sat under the midpoint when the gesture began; it should
  // still sit under the midpoint now, wherever the midpoint has moved to.
  const worldX = (start.centerX - start.panX) / start.zoom;
  const worldY = (start.centerY - start.panY) / start.zoom;

  return {
    panX: center.x - worldX * zoom,
    panY: center.y - worldY * zoom,
    zoom,
  };
}

// Baseline for a single-finger pan. Also used to re-anchor when a pinch
// degrades to one finger, which otherwise leaves the canvas frozen until
// every finger has lifted.
export function panStart(view, touch) {
  return {
    startX: touch.clientX - view.panX,
    startY: touch.clientY - view.panY,
  };
}

export function applyPan(start, touch) {
  return {
    panX: touch.clientX - start.startX,
    panY: touch.clientY - start.startY,
  };
}

// Keep at least `keepVisible` pixels of the content box inside the viewport,
// so a fling cannot strand the user in empty space with no way back.
export function clampPan(view, bounds, viewport, keepVisible = 80) {
  if (!bounds) return { panX: view.panX, panY: view.panY };

  const axis = (pan, min, max, origin, extent) => {
    const lower = origin + keepVisible - max * view.zoom;
    const upper = origin + extent - keepVisible - min * view.zoom;
    // Content narrower than the slack the margins demand: centre it instead
    // of picking an arbitrary edge.
    if (lower > upper) return (lower + upper) / 2;
    return Math.max(lower, Math.min(upper, pan));
  };

  return {
    panX: axis(view.panX, bounds.minX, bounds.maxX, viewport.x || 0, viewport.width),
    panY: axis(view.panY, bounds.minY, bounds.maxY, viewport.y || 0, viewport.height),
  };
}

// Frame the whole content box. This is the escape hatch for a viewport that
// has been panned away from every pane, where zooming out bottoms out at
// MIN_ZOOM long before anything becomes visible again.
export function fitToBounds(bounds, viewport, padding = 24) {
  if (!bounds) return null;

  const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
  const availWidth = Math.max(1, viewport.width - padding * 2);
  const availHeight = Math.max(1, viewport.height - padding * 2);

  const zoom = clampZoom(Math.min(availWidth / contentWidth, availHeight / contentHeight));

  const centerX = bounds.minX + contentWidth / 2;
  const centerY = bounds.minY + contentHeight / 2;

  return {
    panX: (viewport.x || 0) + viewport.width / 2 - centerX * zoom,
    panY: (viewport.y || 0) + viewport.height / 2 - centerY * zoom,
    zoom,
  };
}

// Velocity in pixels per frame from recent pan samples. A sample window longer
// than `maxAge` describes a slow drag rather than a flick, so it yields no
// momentum.
//
// `releaseAt` is the moment the last finger left. It matters because a finger
// that stops and rests fires no further touchmove, so the samples still
// describe whatever movement preceded the pause however long ago it was. Judged
// on the window alone, resting and then lifting flings the canvas — the one
// gesture where the user has most clearly asked it to stop.
export function computeMomentum(samples, maxAge = 200, releaseAt = null) {
  if (!samples || samples.length < 2) return null;

  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  const dt = newest.t - oldest.t;
  if (dt <= 0 || dt > maxAge) return null;

  if (releaseAt != null && releaseAt - newest.t > maxAge) return null;

  return {
    vx: (newest.x - oldest.x) / dt * 16,
    vy: (newest.y - oldest.y) / dt * 16,
  };
}

export const MOMENTUM_FRICTION = 0.92;
export const MOMENTUM_MIN_VELOCITY = 0.3;
