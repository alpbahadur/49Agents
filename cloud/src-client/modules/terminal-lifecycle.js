// ─── Terminal Lifecycle & Pane Chrome ─────────────────────────────────────
// Attaching and reattaching a pane to its terminal on the agent, building
// the shared pane shell for terminal and file panes, and the small pieces of
// header chrome they share: device labels and colours, shortcut badges,
// beads tags and Claude session badges.

import { escapeHtml, formatLocationPath, getTerminalFontFamily } from './utils.js';
import { DEVICE_COLORS, CLAUDE_LOGO_SVG, ICON_BEADS } from './constants.js';
import { agentRequest, sendWs } from './ws-transport.js';
import { setupPaneListeners } from './pane-interaction.js';
import { initTerminal, setupFileEditorListeners } from './editors.js';
import { getDeviceColorOverrides } from './hud.js';
import { renderTabBar } from './tab-groups.js';

let _ctx = null;

export function initTerminalLifecycleDeps(ctx) { _ctx = ctx; }


// Attach terminal to WebSocket
export function attachTerminal(pane) {
  const termInfo = _ctx.terminals.get(pane.id);
  if (!termInfo) return;

  const ws = _ctx.getWs();
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendWs('terminal:attach', {
      terminalId: pane.id,
      tmuxSession: pane.tmuxSession,
      cols: termInfo.xterm.cols,
      rows: termInfo.xterm.rows
    }, pane.agentId);
  } else {
    _ctx.pendingAttachments.add(pane.id);
  }
}

// Re-attach a terminal — equivalent to what a page reload does.
// Clears xterm buffer, resets all flags, and sends terminal:attach
// which triggers the full history capture + force redraw on the agent.
export function reattachTerminal(pane) {
  const termInfo = _ctx.terminals.get(pane.id);
  if (!termInfo) return;

  // Clear xterm buffer (scrollback + visible area)
  termInfo.xterm.clear();
  termInfo.xterm.reset();

  // Reset flags so history injection runs again
  termInfo._historyLoaded = false;
  termInfo._initialAttachDone = false;

  // Re-attach — agent will re-capture history, send it, then force redraw.
  // Agent skips history capture when a TUI app is in alternate screen mode,
  // so no stale scrollback is created.
  attachTerminal(pane);
}

// Render a single pane with terminal
export function renderPane(paneData) {
  const existingPane = document.getElementById(`pane-${paneData.id}`);
  if (existingPane) {
    existingPane.remove();
  }

  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.id = `pane-${paneData.id}`;
  pane.style.left = `${paneData.x}px`;
  pane.style.top = `${paneData.y}px`;
  pane.style.width = `${paneData.width}px`;
  pane.style.height = `${paneData.height}px`;
  pane.style.zIndex = paneData.zIndex;
  pane.dataset.paneId = paneData.id;

  if (!paneData.shortcutNumber) paneData.shortcutNumber = _ctx.getNextShortcutNumber();
  const deviceTag = paneData.device ? deviceLabelHtml(paneData.device) : '';
  const beadsTag = beadsTagHtml(paneData.beadsTag);
  pane.innerHTML = `
    <div class="pane-header">
      <span class="pane-title">${deviceTag}${beadsTag}<span style="opacity:0.7;">Terminal</span></span>
      ${_ctx.paneNameHtml(paneData)}
      <div class="pane-header-right">
        ${_ctx.shortcutBadgeHtml(paneData)}
        <button class="beads-tag-btn" aria-label="Set beads issue" data-tooltip="Set beads issue"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="0">${ICON_BEADS}</svg></button>
        <button class="term-refresh-history" aria-label="Reload history" data-tooltip="Reload history"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 3a7 7 0 1 0 1 5"/><polyline points="14 1 14 5 10 5"/></svg></button>
        <div class="pane-zoom-controls">
          <button class="pane-zoom-btn zoom-out" data-tooltip="Zoom out">−</button>
          <button class="pane-zoom-btn zoom-in" data-tooltip="Zoom in">+</button>
        </div>
        <span class="connection-status connecting" data-tooltip="Connecting"></span>
        <button class="pane-new-tab" aria-label="New tab" data-tooltip="New tab (Tab+=)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
        <button class="pane-expand" aria-label="Expand pane" data-tooltip="Expand">⛶</button>
        <button class="pane-close" aria-label="Close pane"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    </div>
    <div class="pane-content">
      <div class="terminal-container"></div>
      <div class="terminal-loading-overlay">Restoring history…</div>
    </div>
    <div class="pane-resize-handle"></div>
    <div class="pane-resize-handle-left"></div>
  `;

  // Fallback: remove loading overlay after 5s if terminal:attached never arrives
  setTimeout(() => {
    const overlay = pane.querySelector('.terminal-loading-overlay');
    if (overlay) {
      overlay.classList.add('fade-out');
      overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
    }
  }, 5000);

  setupPaneListeners(pane, paneData);
  _ctx.getCanvas().appendChild(pane);

  // Initialize xterm.js
  initTerminal(pane, paneData);

  // Render tab bar if this pane is part of a tab group
  if (paneData.tabGroupId) {
    renderTabBar(pane, paneData);
    // Hide if not the active tab
    if (!paneData.tabGroupActive) {
      pane.style.display = 'none';
    }
  }
}

// Render a file pane
export function renderFilePane(paneData) {
  const existingPane = document.getElementById(`pane-${paneData.id}`);
  if (existingPane) {
    existingPane.remove();
  }

  const pane = document.createElement('div');
  pane.className = 'pane file-pane';
  pane.id = `pane-${paneData.id}`;
  pane.style.left = `${paneData.x}px`;
  pane.style.top = `${paneData.y}px`;
  pane.style.width = `${paneData.width}px`;
  pane.style.height = `${paneData.height}px`;
  pane.style.zIndex = paneData.zIndex;
  pane.dataset.paneId = paneData.id;

  if (!paneData.shortcutNumber) paneData.shortcutNumber = _ctx.getNextShortcutNumber();
  const deviceTag = paneData.device ? deviceLabelHtml(paneData.device) : '';

  pane.innerHTML = `
    <div class="pane-header">
      <span class="pane-title">${deviceTag}📄 ${escapeHtml(paneData.fileName || 'Untitled')}</span>
      ${_ctx.paneNameHtml(paneData)}
      <div class="pane-header-right">
        ${_ctx.shortcutBadgeHtml(paneData)}
        <button class="pane-mention-btn" data-tooltip="Mention in Claude Code">@</button>
        <div class="pane-zoom-controls">
          <button class="pane-zoom-btn zoom-out" data-tooltip="Zoom out">−</button>
          <button class="pane-zoom-btn zoom-in" data-tooltip="Zoom in">+</button>
        </div>
        <button class="pane-expand" aria-label="Expand pane" data-tooltip="Expand">⛶</button>
        <button class="pane-close" aria-label="Close pane"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    </div>
    <div class="pane-content">
      <div class="file-container">
        <div class="file-toolbar">
          <button class="file-toolbar-btn save-btn" data-tooltip="Save file">Save</button>
          <button class="file-toolbar-btn discard-btn" data-tooltip="Discard changes">Discard</button>
          <button class="file-toolbar-btn reload-btn" data-tooltip="Reload file">Reload</button>
          <span class="file-status"></span>
          <span class="file-refreshed"></span>
        </div>
        <div class="file-editor"></div>
      </div>
    </div>
    <div class="pane-resize-handle"></div>
    <div class="pane-resize-handle-left"></div>
  `;

  setupPaneListeners(pane, paneData);
  _ctx.getCanvas().appendChild(pane);

  // Store original content for change detection (before Monaco init)
  _ctx.fileEditors.set(paneData.id, {
    originalContent: paneData.content || '',
    hasChanges: false,
    monacoEditor: null
  });

  // Initialize Monaco editor
  initMonacoEditor(pane, paneData);
}

// Detect language from filename for Monaco
export function getLanguageFromFileName(fileName) {
  if (!fileName) return 'plaintext';
  const ext = fileName.split('.').pop().toLowerCase();
  const langMap = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', pyw: 'python',
    rb: 'ruby', rs: 'rust', go: 'go',
    java: 'java', kt: 'kotlin', scala: 'scala',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    cs: 'csharp', fs: 'fsharp',
    html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less',
    json: 'json', jsonc: 'json',
    xml: 'xml', svg: 'xml',
    yaml: 'yaml', yml: 'yaml',
    md: 'markdown', mdx: 'markdown',
    sql: 'sql',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
    ps1: 'powershell',
    php: 'php',
    swift: 'swift', m: 'objective-c',
    r: 'r', R: 'r',
    lua: 'lua', perl: 'perl', pl: 'perl',
    dockerfile: 'dockerfile',
    makefile: 'makefile', mk: 'makefile',
    toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
    vue: 'html', svelte: 'html',
    graphql: 'graphql', gql: 'graphql',
    proto: 'protobuf',
    tf: 'hcl',
    dart: 'dart', elixir: 'elixir', ex: 'elixir', exs: 'elixir',
    clj: 'clojure', cljs: 'clojure',
    zig: 'zig',
  };
  // Also check full filename for special files
  const baseName = fileName.split('/').pop().toLowerCase();
  if (baseName === 'dockerfile') return 'dockerfile';
  if (baseName === 'makefile' || baseName === 'gnumakefile') return 'makefile';
  if (baseName === '.gitignore' || baseName === '.dockerignore') return 'ignore';
  if (baseName === '.env' || baseName.startsWith('.env.')) return 'ini';
  return langMap[ext] || 'plaintext';
}

// Initialize Monaco Editor for a file pane
export async function initMonacoEditor(paneEl, paneData) {
  const container = paneEl.querySelector('.file-editor');
  if (!container) return;

  // Wait for Monaco to be ready
  const monaco = await window.monacoReady;

  const language = getLanguageFromFileName(paneData.fileName || paneData.filePath || '');
  const content = paneData.content || '';

  const editor = monaco.editor.create(container, {
    value: content,
    language: language,
    theme: '49agents-dark',
    fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Monaco, monospace',
    fontSize: 13,
    lineHeight: 1.5,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: false,
    wordWrap: 'off',
    tabSize: 2,
    insertSpaces: true,
    renderLineHighlight: 'line',
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    smoothScrolling: true,
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true, indentation: true },
    folding: true,
    glyphMargin: false,
    lineNumbersMinChars: 3,
    padding: { top: 8, bottom: 8 },
    scrollbar: {
      verticalScrollbarSize: 8,
      horizontalScrollbarSize: 8,
      useShadows: false,
    },
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    overviewRulerBorder: false,
    contextmenu: true,
    fixedOverflowWidgets: true,
  });

  // Store the Monaco instance
  const editorInfo = _ctx.fileEditors.get(paneData.id);
  if (editorInfo) {
    editorInfo.monacoEditor = editor;
  }

  // Now setup file editor listeners (needs Monaco instance)
  setupFileEditorListeners(paneEl, paneData);

  // Handle layout on pane resize
  const resizeObserver = new ResizeObserver(() => {
    editor.layout();
  });
  resizeObserver.observe(container);
  if (editorInfo) {
    editorInfo.resizeObserver = resizeObserver;
  }

  // Prevent pane drag when clicking inside editor
  container.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });
  container.addEventListener('touchstart', (e) => {
    e.stopPropagation();
  }, { passive: true });
}

// DEVICE_COLORS — imported from modules/constants.js

export function getDeviceColor(deviceName) {
  if (!deviceName) return null;
  // User-chosen color takes priority
  const overrides = getDeviceColorOverrides();
  if (overrides[deviceName] != null) {
    return DEVICE_COLORS[overrides[deviceName] % DEVICE_COLORS.length];
  }
  // Fall back to hash-based
  let hash = 0;
  for (let i = 0; i < deviceName.length; i++) {
    hash = ((hash << 5) - hash + deviceName.charCodeAt(i)) | 0;
  }
  return DEVICE_COLORS[Math.abs(hash) % DEVICE_COLORS.length];
}

export function beadsStatusIcon(status, blocked) {
  if (blocked) return '<span class="beads-tag-status beads-status-blocked" data-tooltip="Blocked">\uD83D\uDD12</span>';
  if (status === 'in_progress') return '<span class="beads-tag-status beads-status-progress" data-tooltip="In Progress">\u25D0</span>';
  if (status === 'closed') return '<span class="beads-tag-status beads-status-closed" data-tooltip="Closed">\u25CF</span>';
  return '<span class="beads-tag-status beads-status-open" data-tooltip="Open">\u25CB</span>';
}

export function claudeSessionBadgeHtml(sessionId, sessionName) {
  if (!sessionId) return '';
  const shortId = escapeHtml(sessionId.slice(0, 8));
  const nameHtml = sessionName
    ? `<span class="claude-session-sep">\u2009\u2014\u2009</span><span class="claude-session-name">${escapeHtml(sessionName.slice(0, 50))}</span>`
    : '';
  return `<span class="claude-session-badge" data-tooltip="${escapeHtml(sessionId)}">${CLAUDE_LOGO_SVG.replace('class="claude-logo"', 'class="claude-session-logo"')}<span class="claude-session-id">${shortId}</span>${nameHtml}</span>`;
}

export function beadsTagHtml(beadsTag) {
  if (!beadsTag) return '';
  const shortId = beadsTag.id.replace(/^.*-/, '');
  const statusHtml = beadsStatusIcon(beadsTag.status, beadsTag.blocked);
  return `<span class="beads-tag-badge" data-beads-id="${escapeHtml(beadsTag.id)}" data-beads-title="${escapeHtml(beadsTag.title || '')}">${statusHtml}${escapeHtml(shortId)}<span class="beads-tag-remove" data-tooltip="Remove beads tag">&times;</span></span>`;
}

export async function refreshBeadsTagStatus(pane) {
  try {
    const resp = await _ctx.cloudFetch('GET', `/api/beads/status/${encodeURIComponent(pane.beadsTag.id)}`);
    if (resp && resp.status) {
      // Auto-remove tag when issue is closed
      if (resp.status === 'closed') {
        pane.beadsTag = undefined;
        _ctx.cloudSaveLayout(pane);
        const paneEl = document.getElementById(`pane-${pane.id}`);
        if (paneEl) {
          const badge = paneEl.querySelector('.beads-tag-badge');
          if (badge) badge.remove();
        }
        return;
      }
      const blocked = resp.dependency_count > 0 && resp.status !== 'closed';
      if (pane.beadsTag.status !== resp.status || pane.beadsTag.blocked !== blocked) {
        pane.beadsTag.status = resp.status;
        pane.beadsTag.blocked = blocked;
        _ctx.cloudSaveLayout(pane);
        // Update badge DOM
        const paneEl = document.getElementById(`pane-${pane.id}`);
        if (paneEl) {
          const badge = paneEl.querySelector('.beads-tag-badge');
          if (badge) {
            const statusEl = badge.querySelector('.beads-tag-status');
            if (statusEl) {
              const tmp = document.createElement('span');
              tmp.innerHTML = beadsStatusIcon(resp.status, blocked);
              statusEl.replaceWith(tmp.firstChild);
            }
          }
        }
      }
    }
  } catch (_) { /* silently fail — status will show default */ }
}

// Periodic refresh of beads tag statuses (every 30s)
setInterval(() => {
  for (const pane of _ctx.state.panes) {
    if (pane.beadsTag && pane.beadsTag.id) {
      refreshBeadsTagStatus(pane);
    }
  }
}, 30000);

export function deviceLabelHtml(deviceName, extraStyle = '') {
  // Device identity is now shown via header background tint, not a label
  return '';
}

export function applyDeviceHeaderColor(paneEl, deviceName) {
  if (!deviceName) return;
  const color = getDeviceColor(deviceName);
  if (!color || !color.rgb) return;
  const header = paneEl.querySelector('.pane-header');
  if (!header) return;
  header.style.background = `rgba(${color.rgb}, 0.15)`;
  header.style.borderBottom = `1px solid rgba(${color.rgb}, 0.2)`;
}

// escapeHtml — imported from modules/utils.js

// Expand a pane to full screen
// ============================================================================
