// Multi-touch driving for the gesture specs.
//
// page.touchscreen only taps, and a tap cannot express the thing most worth
// testing: two fingers moving independently. CDP's Input.dispatchTouchEvent
// takes an arbitrary list of touch points and produces events indistinguishable
// from a real screen, which is what the capture-phase canvas listener sees.

export async function touchSession(page) {
  const cdp = await page.context().newCDPSession(page);

  const send = (type, points) => cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i })),
  });

  return {
    start: (points) => send('touchStart', points),
    move: (points) => send('touchMove', points),
    end: (points) => send('touchEnd', points),
    // CDP rejects touchCancel with any points attached, which matches the DOM:
    // a cancelled gesture has no fingers left to describe.
    cancel: () => send('touchCancel', []),
    detach: () => cdp.detach().catch(() => {}),
  };
}

// Read the canvas transform back as numbers. The app writes pan and zoom
// straight onto the element, so this is the honest measure of what a gesture
// achieved, rather than trusting internal state.
export async function readView(page) {
  return page.evaluate(() => {
    const el = document.getElementById('canvas');
    const t = getComputedStyle(el).transform;
    if (!t || t === 'none') return { panX: 0, panY: 0, zoom: 1 };
    // matrix(a, b, c, d, tx, ty) — uniform scale, so a is the zoom.
    const parts = t.match(/matrix\(([^)]+)\)/);
    if (!parts) return { panX: 0, panY: 0, zoom: 1 };
    const n = parts[1].split(',').map(Number);
    return { zoom: n[0], panX: n[4], panY: n[5] };
  });
}

// Interpolate a two-finger gesture so the handler sees a stream of moves, the
// way a real pinch arrives, instead of one jump it could special-case.
export async function pinch(touch, from, to, steps = 8) {
  await touch.start([{ x: from.a.x, y: from.a.y, id: 0 }, { x: from.b.x, y: from.b.y, id: 1 }]);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const lerp = (p, q) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    const a = lerp(from.a, to.a);
    const b = lerp(from.b, to.b);
    await touch.move([{ x: a.x, y: a.y, id: 0 }, { x: b.x, y: b.y, id: 1 }]);
  }
  await touch.end([{ x: to.a.x, y: to.a.y, id: 0 }, { x: to.b.x, y: to.b.y, id: 1 }]);
}

export async function drag(touch, from, to, steps = 6) {
  await touch.start([{ x: from.x, y: from.y, id: 0 }]);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await touch.move([{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, id: 0 }]);
  }
  await touch.end([{ x: to.x, y: to.y, id: 0 }]);
}
