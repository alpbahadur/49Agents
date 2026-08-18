// ─── Shared Constants & Icons ─────────────────────────────────────────────
// SVG icon definitions, color palettes, config objects, and visual constants.
// Pure data — no logic, no side effects, no state.

export const APP_VERSION = '0.2.2';

// ── Pane configuration ──

export const PANE_DEFAULTS = {
  'terminal':       { width: 600, height: 400 },
  'file':           { width: 600, height: 400 },
  'note':           { width: 400, height: 250 },
  'git-graph':      { width: 500, height: 450 },
  'iframe':         { width: 800, height: 600 },
  'beads':          { width: 520, height: 500 },
  'folder':         { width: 400, height: 500 },
  'conversations':  { width: 520, height: 500 },
};

export const PANE_ENDPOINT_MAP = {
  file: 'file-panes', note: 'notes', terminal: 'terminals',
  'git-graph': 'git-graphs', iframe: 'iframes',
  beads: 'beads-panes', folder: 'folder-panes',
  conversations: 'conversations-panes',
};

// ── SVG icons (inner content, without <svg> wrapper) ──

export const ICON_BEADS = '<circle cx="6" cy="12" r="3" fill="currentColor" opacity="0.7"/><circle cx="12" cy="12" r="3" fill="currentColor"/><circle cx="18" cy="12" r="3" fill="currentColor" opacity="0.7"/><line x1="9" y1="12" x2="15" y2="12" stroke="currentColor" stroke-width="1.5"/>';

export const ICON_GIT_GRAPH = '<circle cx="7" cy="6" r="2.5" fill="currentColor"/><circle cx="17" cy="6" r="2.5" fill="currentColor"/><circle cx="7" cy="18" r="2.5" fill="currentColor"/><line x1="7" y1="8.5" x2="7" y2="15.5" stroke="currentColor" stroke-width="2"/><path d="M17 8.5c0 4-10 4-10 7" stroke="currentColor" stroke-width="2" fill="none"/>';

export const ICON_FOLDER = '<path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" fill="none" stroke="currentColor" stroke-width="2"/>';

export const ICON_CONVERSATIONS = '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="1" fill="currentColor"/><circle cx="12" cy="10" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/>';

// ── Claude state indicators ──

export const CLAUDE_STATE_SVGS = {
  working: '<span class="claude-state working"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97s-.03-.66-.07-1l2.11-1.63c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.5.42l-.37 2.65c-.63.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.34-.07.67-.07 1s.03.65.07.97l-2.11 1.66c-.19.15-.25.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1.01c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.63-.26 1.17-.59 1.69-.98l2.49 1.01c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64L19.43 12.97z"/></svg></span>',
  idle: '',
  permission: 'None',
  question: 'None',
  inputNeeded: '<span class="claude-state input-needed"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><circle cx="12" cy="17" r=".5" fill="currentColor"/></svg></span>',
};

export const CLAUDE_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="claude-logo"><path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z"/></svg>`;

export const RESET_ICON_SVG = '<svg class="usage-reset-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';

export const WIFI_OFF_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="var(--ink-45)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <line x1="1" y1="1" x2="23" y2="23"/>
  <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>
  <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>
  <path d="M10.71 5.05A16 16 0 0 1 22.56 9"/>
  <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>
  <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
  <line x1="12" y1="20" x2="12.01" y2="20"/>
</svg>`;

// ── Device colors ──

export const DEVICE_COLORS = [
  { bg: 'rgba(244,143,177,0.25)', border: 'rgba(244,143,177,0.4)', text: 'rgba(244,180,200,0.9)', rgb: '244,143,177' },  // Rose
  { bg: 'rgba(179,157,219,0.25)', border: 'rgba(179,157,219,0.4)', text: 'rgba(200,185,235,0.9)', rgb: '179,157,219' },  // Lavender
  { bg: 'rgba(129,212,250,0.25)', border: 'rgba(129,212,250,0.4)', text: 'rgba(160,220,250,0.9)', rgb: '129,212,250' },  // Sky
  { bg: 'rgba(128,203,196,0.25)', border: 'rgba(128,203,196,0.4)', text: 'rgba(160,215,210,0.9)', rgb: '128,203,196' },  // Mint
  { bg: 'rgba(165,214,167,0.25)', border: 'rgba(165,214,167,0.4)', text: 'rgba(185,225,185,0.9)', rgb: '165,214,167' },  // Sage
  { bg: 'rgba(255,204,128,0.25)', border: 'rgba(255,204,128,0.4)', text: 'rgba(255,215,160,0.9)', rgb: '255,204,128' },  // Peach
  { bg: 'rgba(239,154,154,0.25)', border: 'rgba(239,154,154,0.4)', text: 'rgba(245,180,180,0.9)', rgb: '239,154,154' },  // Coral
  { bg: 'rgba(255,245,157,0.25)', border: 'rgba(255,245,157,0.4)', text: 'rgba(255,245,180,0.9)', rgb: '255,245,157' },  // Lemon
  { bg: 'rgba(159,168,218,0.25)', border: 'rgba(159,168,218,0.4)', text: 'rgba(185,192,230,0.9)', rgb: '159,168,218' },  // Periwinkle
  { bg: 'rgba(248,187,208,0.25)', border: 'rgba(248,187,208,0.4)', text: 'rgba(248,200,220,0.9)', rgb: '248,187,208' },  // Blush
];

// ── Settings ──

export const TERMINAL_FONTS = [
  'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'IBM Plex Mono',
  'Inconsolata', 'Cascadia Code', 'Ubuntu Mono', 'Roboto Mono',
  'Space Mono', 'Anonymous Pro', 'Cousine', 'PT Mono',
  'Overpass Mono', 'Noto Sans Mono', 'DM Mono', 'Red Hat Mono', 'monospace',
];

// `themed: true` means the swatch follows the active theme's canvas token
// instead of pinning a colour, so the default canvas turns pale in light mode
// rather than staying near-black. The named dark shades stay literal: someone
// who explicitly picked "Pure Black" asked for black in either theme.
export const CANVAS_BACKGROUNDS = {
  default:    { name: 'Deep Space',   color: 'var(--canvas)', themed: true },
  black:      { name: 'Pure Black',   color: '#000000' },
  midnight:   { name: 'Midnight',     color: 'var(--canvas)' },
  charcoal:   { name: 'Charcoal',     color: 'var(--surface-solid)' },
  grid:       { name: 'Grid',         color: 'var(--canvas)', grid: true, themed: true },
};

// Light / dark / follow-the-OS. Stored as a string pref; `system` resolves
// through matchMedia at apply time and re-resolves when the OS flips.
export const APP_THEMES = {
  light:  { name: 'Light' },
  dark:   { name: 'Dark' },
  system: { name: 'System' },
};

// ── OS icons ──

export function osIcon(osName) {
  const s = (d) => `<svg class="hud-os-icon" viewBox="0 0 24 24" fill="currentColor"><path d="${d}"/></svg>`;
  switch (osName) {
    case 'linux':
      return s('M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v12h16V6H4zm2 2l4 4-4 4 1.5 1.5L9 12l-5.5-5.5L2 8zm6 8h6v2h-6v-2z');
    case 'windows':
      return s('M3 5l8-1.2V12H3V5zm0 8h8v8.2L3 20v-7zm9-9.8L21 2v10h-9V3.2zM12 13h9v9l-9-1.2V13z');
    case 'macos':
      return s('M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11h1a1 1 0 0 1 1 1v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1a1 1 0 0 1 1-1h1V5zm2 0v11h12V5H6zm4 13h4v1h-4v-1z');
    case 'iOS':
      return s('M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 2v16h10V4H7zm3 14h4v1h-4v-1z');
    case 'android':
      return s('M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 2v16h10V4H7zm2 1h6v1H9V5zm3 13a1 1 0 1 1 0 2 1 1 0 0 1 0-2z');
    default:
      return s('M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-6v2h3v2H7v-2h3v-2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v10h16V6H4z');
  }
}
