// ─── Viewport ─────────────────────────────────────────────────────────────
// The usable area of the screen, which is smaller than window.innerHeight in
// two ways nothing in the app accounted for: display cutouts and home
// indicators eat the edges, and the mobile soft keyboard covers the bottom
// without ever firing a window resize on iOS.
//
// visualViewport reports the area actually left over once the keyboard is up.
// Its height is mirrored into --app-vh, and the covered strip into
// --keyboard-inset, so layout can respond in CSS while gesture and fit maths
// read the same numbers through getViewportRect().

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

let cachedInsets = null;
let resizeCallbacks = [];

function readInset(styles, name) {
  const value = parseFloat(styles.getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
}

// Safe-area insets are only readable through CSS, since env() has no
// JavaScript equivalent. styles.css mirrors each one onto a custom property
// for exactly this reason.
export function getSafeAreaInsets() {
  if (cachedInsets) return cachedInsets;
  if (typeof window === 'undefined' || !window.getComputedStyle) return ZERO_INSETS;

  const styles = window.getComputedStyle(document.documentElement);
  cachedInsets = {
    top: readInset(styles, '--safe-top'),
    right: readInset(styles, '--safe-right'),
    bottom: readInset(styles, '--safe-bottom'),
    left: readInset(styles, '--safe-left'),
  };
  return cachedInsets;
}

// The rect that content should stay inside: the visual viewport, inset by any
// display cutouts. Gesture clamping and zoom-to-fit both frame against this
// rather than the raw window, so nothing settles under a notch or behind the
// keyboard.
export function getViewportRect() {
  if (typeof window === 'undefined') return { x: 0, y: 0, width: 1, height: 1 };

  const vv = window.visualViewport;
  const width = vv ? vv.width : window.innerWidth;
  const height = vv ? vv.height : window.innerHeight;
  const insets = getSafeAreaInsets();

  return {
    x: insets.left,
    y: insets.top,
    width: Math.max(1, width - insets.left - insets.right),
    height: Math.max(1, height - insets.top - insets.bottom),
  };
}

// How much of the layout viewport the keyboard is covering. Derived from the
// gap between the layout and visual viewports rather than from any keyboard
// API, which no browser exposes.
export function getKeyboardInset() {
  if (typeof window === 'undefined') return 0;
  const vv = window.visualViewport;
  if (!vv) return 0;
  const covered = window.innerHeight - (vv.height + vv.offsetTop);
  // Sub-pixel rounding and the collapsing URL bar both produce small
  // non-zero gaps that are not a keyboard.
  return covered > 80 ? covered : 0;
}

function publish() {
  cachedInsets = null;

  const rect = getViewportRect();
  const keyboard = getKeyboardInset();
  const root = document.documentElement;

  root.style.setProperty('--app-vh', `${rect.height}px`);
  root.style.setProperty('--keyboard-inset', `${keyboard}px`);
  document.body?.classList.toggle('keyboard-open', keyboard > 0);

  for (const cb of resizeCallbacks) {
    try { cb({ rect, keyboard }); } catch (e) { console.error('[Viewport] resize callback failed:', e); }
  }
}

export function onViewportResize(cb) {
  resizeCallbacks.push(cb);
}

export function setupViewportTracking() {
  if (typeof window === 'undefined') return;

  const vv = window.visualViewport;
  if (vv) {
    // resize fires when the keyboard opens or closes; scroll fires when the
    // page is pushed up to keep a focused input visible.
    vv.addEventListener('resize', publish);
    vv.addEventListener('scroll', publish);
  }
  window.addEventListener('resize', publish);
  window.addEventListener('orientationchange', publish);

  publish();
}
