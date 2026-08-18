// ─── Minimap ──────────────────────────────────────────────────────────────
// Canvas minimap rendering, navigation, and visibility management.

let _ctx = null; // injected dependencies

export function initMinimap(ctx) { _ctx = ctx; }

/**
 * Canvas2D cannot resolve CSS custom properties, so token-based colours have to
 * be read off the document and substituted before they reach fillStyle.
 * Re-read per draw so a theme switch is picked up immediately.
 */
function themeVar(name, fallback) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name).trim() || fallback;
}
const themeInk = (a) => `rgba(${themeVar('--ink-rgb', '255, 255, 255')}, ${a})`;
const themeSink = (a) => `rgba(${themeVar('--sink-rgb', '0, 0, 0')}, ${a})`;
const themeText = () => themeVar('--text-bright', '#ffffff');

// ── State ──
let minimapEnabled = window.innerWidth > 768; // disabled by default on phone
let minimapVisible = false;
let minimapRafId = null;
let minimapEls = null;
let minimapTimerId = null;

export function setMinimapEnabled(val) { minimapEnabled = val; }
export function getMinimapEnabled() { return minimapEnabled; }

function createMinimap() {
  const wrap = document.createElement('div');
  wrap.id = 'minimap';
  wrap.style.display = 'none';
  wrap.innerHTML = `<canvas id="minimap-canvas" width="400" height="300"></canvas>`;
  document.body.appendChild(wrap);

  const cvs = document.getElementById('minimap-canvas');
  const ctx = cvs.getContext('2d');

  wrap.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = cvs.getBoundingClientRect();
    navigateFromMinimap(e, rect, cvs);

    const onMove = (me) => navigateFromMinimap(me, rect, cvs);
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  return { wrap, cvs, ctx };
}

function navigateFromMinimap(e, rect, cvs) {
  const state = _ctx.getState();
  if (state.panes.length === 0) return;
  const bounds = getCanvasBounds();
  if (!bounds) return;
  const padding = 40;
  const bw = bounds.maxX - bounds.minX + padding * 2;
  const bh = bounds.maxY - bounds.minY + padding * 2;
  const scale = Math.min(cvs.width / bw, cvs.height / bh);
  const offsetX = (cvs.width - bw * scale) / 2;
  const offsetY = (cvs.height - bh * scale) / 2;

  const mx = (e.clientX - rect.left) * (cvs.width / rect.width);
  const my = (e.clientY - rect.top) * (cvs.height / rect.height);

  const canvasX = (mx - offsetX) / scale + bounds.minX - padding;
  const canvasY = (my - offsetY) / scale + bounds.minY - padding;

  state.panX = window.innerWidth / 2 - canvasX * state.zoom;
  state.panY = window.innerHeight / 2 - canvasY * state.zoom;
  _ctx.updateCanvasTransform();
  _ctx.saveViewState();
}

export function getCanvasBounds() {
  const state = _ctx.getState();
  if (state.panes.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of state.panes) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x + p.width > maxX) maxX = p.x + p.width;
    if (p.y + p.height > maxY) maxY = p.y + p.height;
  }
  return { minX, minY, maxX, maxY };
}

export function renderMinimap() {
  const state = _ctx.getState();
  if (!minimapEls) minimapEls = createMinimap();
  const { wrap, cvs, ctx } = minimapEls;

  if (state.panes.length === 0) {
    wrap.style.display = 'none';
    if (minimapVisible) { minimapVisible = false; document.body.classList.add('minimap-hidden'); }
    return;
  }

  if (!minimapEnabled) {
    if (minimapVisible) {
      wrap.style.display = 'none';
      minimapVisible = false;
      document.body.classList.add('minimap-hidden');
    }
    return;
  }

  if (!minimapVisible) {
    wrap.style.display = 'block';
    minimapVisible = true;
    document.body.classList.remove('minimap-hidden');
  }

  const bounds = getCanvasBounds();
  if (!bounds) return;

  const padding = 40;
  const bw = bounds.maxX - bounds.minX + padding * 2;
  const bh = bounds.maxY - bounds.minY + padding * 2;
  const scale = Math.min(cvs.width / bw, cvs.height / bh);
  const offsetX = (cvs.width - bw * scale) / 2;
  const offsetY = (cvs.height - bh * scale) / 2;

  const toMiniX = (x) => offsetX + (x - bounds.minX + padding) * scale;
  const toMiniY = (y) => offsetY + (y - bounds.minY + padding) * scale;

  ctx.clearRect(0, 0, cvs.width, cvs.height);

  ctx.fillStyle = themeSink(0.6);
  ctx.beginPath();
  ctx.roundRect(0, 0, cvs.width, cvs.height, 8);
  ctx.fill();

  const typeColors = {
    terminal: 'rgba(78, 201, 176, 0.6)', file: 'rgba(100, 149, 237, 0.6)',
    note: 'rgba(255, 213, 79, 0.6)', 'git-graph': 'rgba(255, 138, 101, 0.6)',
    iframe: 'rgba(171, 130, 255, 0.6)', beads: 'rgba(233, 170, 255, 0.6)',
    folder: 'rgba(139, 195, 74, 0.6)',
  };
  const typeColorsActive = {
    terminal: 'rgba(78, 201, 176, 0.9)', file: 'rgba(100, 149, 237, 0.9)',
    note: 'rgba(255, 213, 79, 0.9)', 'git-graph': 'rgba(255, 138, 101, 0.9)',
    iframe: 'rgba(171, 130, 255, 0.9)', beads: 'rgba(233, 170, 255, 0.9)',
    folder: 'rgba(139, 195, 74, 0.9)',
  };

  const focusedEl = document.querySelector('.pane.focused');
  const focusedId = focusedEl ? focusedEl.dataset.paneId : null;
  const moveModeActive = _ctx.getMoveModeActive();
  const moveModePaneId = _ctx.getMoveModePaneId();

  for (const p of state.panes) {
    const rx = toMiniX(p.x);
    const ry = toMiniY(p.y);
    const rw = p.width * scale;
    const rh = p.height * scale;

    const isFocused = p.id === focusedId;
    const isMoveTarget = moveModeActive && p.id === moveModePaneId;

    ctx.fillStyle = (isFocused || isMoveTarget)
      ? (typeColorsActive[p.type] || themeInk(0.9))
      : (typeColors[p.type] || themeInk(0.4));
    ctx.beginPath();
    ctx.roundRect(rx, ry, Math.max(rw, 2), Math.max(rh, 2), 2);
    ctx.fill();

    if (isFocused || isMoveTarget) {
      ctx.strokeStyle = themeText();
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (p.shortcutNumber && rw > 10 && rh > 10) {
      ctx.fillStyle = themeInk(0.9);
      ctx.font = `bold ${Math.min(Math.max(rh * 0.5, 8), 14)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(p.shortcutNumber), rx + rw / 2, ry + rh / 2);
    }
  }

  const vpLeft = (0 - state.panX) / state.zoom;
  const vpTop = (0 - state.panY) / state.zoom;
  const vpWidth = window.innerWidth / state.zoom;
  const vpHeight = window.innerHeight / state.zoom;

  const vrx = toMiniX(vpLeft);
  const vry = toMiniY(vpTop);
  const vrw = vpWidth * scale;
  const vrh = vpHeight * scale;

  ctx.strokeStyle = themeInk(0.5);
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(vrx, vry, vrw, vrh);
  ctx.setLineDash([]);
}

export function hideMinimap() {
  if (minimapTimerId) { clearTimeout(minimapTimerId); minimapTimerId = null; }
  if (minimapRafId) { cancelAnimationFrame(minimapRafId); minimapRafId = null; }
  if (minimapEls) {
    minimapEls.wrap.style.display = 'none';
    minimapVisible = false;
  }
  document.body.classList.add('minimap-hidden');
}

export function startMinimapLoop() {
  if (minimapRafId || minimapTimerId) return;
  function tick() {
    renderMinimap();
    if (minimapVisible) {
      minimapRafId = requestAnimationFrame(tick);
    } else {
      minimapTimerId = setTimeout(() => {
        minimapRafId = requestAnimationFrame(tick);
      }, 200);
    }
  }
  minimapRafId = requestAnimationFrame(tick);
}

export function calcPlacementPos(placementPos, halfW, halfH) {
  const state = _ctx.getState();
  if (placementPos) {
    return { x: placementPos.x - halfW, y: placementPos.y - halfH };
  }
  const viewCenterX = (window.innerWidth / 2 - state.panX) / state.zoom;
  const viewCenterY = (window.innerHeight / 2 - state.panY) / state.zoom;
  return { x: viewCenterX - halfW, y: viewCenterY - halfH };
}
