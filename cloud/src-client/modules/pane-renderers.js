// ─── Pane Renderers ───────────────────────────────────────────────────────
// Builds the body of each non-terminal pane type — notes (Monaco markdown
// with images), iframes, beads boards, folder trees — plus expanding a pane
// to full screen and collapsing it back.
//
// Freshly built panes are wired for pointer behaviour by
// setupPaneListeners, imported from pane-interaction.js. That module calls
// back into expandPane, collapsePane and the iframe overlays through its
// own context rather than importing this one, which keeps the dependency
// between the two one-directional.

import { escapeHtml, formatBytes, formatLocationPath, truncateUrl } from './utils.js';
import { ICON_BEADS, ICON_FOLDER, ICON_CONVERSATIONS, PANE_DEFAULTS } from './constants.js';
import { agentRequest, sendWs } from './ws-transport.js';
import { setupPaneListeners } from './pane-interaction.js';
import { setupImageButtonHandlers, setupTextOnlyToggle } from './editors.js';
import { calcPlacementPos } from './minimap.js';
import { clearPaneRefresh } from './pane-refresh.js';
import { loadMonaco, loadMarkdown } from './lazy-deps.js';

let _ctx = null;

export function initRenderersDeps(ctx) { _ctx = ctx; }


export function expandPane(paneId) {
  if (_ctx.getExpandedPaneId()) return; // Already have an expanded pane
  _ctx.clearMultiSelect();

  const pane = _ctx.state.panes.find(p => p.id === paneId);
  if (!pane) return;

  const paneEl = document.getElementById(`pane-${paneId}`);
  if (!paneEl) return;

  _ctx.setExpandedPaneId(paneId);
  document.body.classList.add('pane-expanded');

  // Store original position/size for restoration
  paneEl.dataset.originalStyle = paneEl.getAttribute('style') || '';

  // Create backdrop overlay
  const backdrop = document.createElement('div');
  backdrop.className = 'expand-backdrop';
  backdrop.id = 'expand-backdrop';
  backdrop.addEventListener('click', () => collapsePane());
  document.body.appendChild(backdrop);

  // Move pane to body (outside canvas transform) for proper fixed positioning
  document.body.appendChild(paneEl);

  // Add expanded class to pane (CSS will handle fullscreen positioning)
  paneEl.classList.add('expanded');

  // Hide close button, change expand button to collapse button
  const expandBtn = paneEl.querySelector('.pane-expand');
  const closeBtn = paneEl.querySelector('.pane-close');
  if (expandBtn) {
    expandBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 1v5H1"/><path d="M10 1v5h5"/><path d="M6 15v-5H1"/><path d="M10 15v-5h5"/></svg>';
    expandBtn.setAttribute('data-tooltip', 'Minimize (Esc)');
  }
  if (closeBtn) {
    closeBtn.style.display = 'none';
  }


  // Refit terminal if this is a terminal pane
  if (pane.type === 'terminal') {
    const termInfo = _ctx.terminals.get(paneId);
    if (termInfo) {
      const doFit = () => {
        try {
          if (termInfo.safeFitAndSync) termInfo.safeFitAndSync();
          else termInfo.fitAddon.fit();
          termInfo.xterm.focus();
        } catch (e) {
          console.error('[App] Fit error on expand:', e);
        }
      };
      setTimeout(doFit, 50);
      setTimeout(doFit, 150);

      // Refresh terminal to enable scrolling
      termInfo.xterm.refresh(0, termInfo.xterm.rows - 1);
    }
  }

  // Refit and focus Monaco editor if this is a file pane
  if (pane.type === 'file') {
    const editorInfo = _ctx.fileEditors.get(pane.id);
    if (editorInfo?.monacoEditor) {
      const doLayout = () => {
        editorInfo.monacoEditor.layout();
        editorInfo.monacoEditor.focus();
      };
      setTimeout(doLayout, 50);
      setTimeout(doLayout, 150);
    }
  }

}

// Collapse expanded pane back to normal
export function collapsePane() {
  if (!_ctx.getExpandedPaneId()) return;

  const paneId = _ctx.getExpandedPaneId();
  const pane = _ctx.state.panes.find(p => p.id === paneId);
  const paneEl = document.getElementById(`pane-${paneId}`);
  const backdrop = document.getElementById('expand-backdrop');


  // Remove backdrop
  if (backdrop) {
    backdrop.remove();
  }

  if (paneEl) {
    // Remove expanded class
    paneEl.classList.remove('expanded');

    // Restore original style
    const originalStyle = paneEl.dataset.originalStyle;
    if (originalStyle) {
      paneEl.setAttribute('style', originalStyle);
    }
    delete paneEl.dataset.originalStyle;

    // Move pane back to canvas
    _ctx.getCanvas().appendChild(paneEl);

    // Restore expand button and close button
    const expandBtn = paneEl.querySelector('.pane-expand');
    const closeBtn = paneEl.querySelector('.pane-close');
    if (expandBtn) {
      expandBtn.innerHTML = '⛶';
      expandBtn.setAttribute('data-tooltip', 'Expand');
    }
    if (closeBtn) {
      closeBtn.style.display = '';
    }
  }

  // Clear expanded state
  _ctx.setExpandedPaneId(null);
  document.body.classList.remove('pane-expanded');


  // Refit terminal if this is a terminal pane
  if (pane && pane.type === 'terminal') {
    const termInfo = _ctx.terminals.get(paneId);
    if (termInfo) {
      setTimeout(() => {
        try {
          if (termInfo.safeFitAndSync) termInfo.safeFitAndSync();
          else termInfo.fitAddon.fit();
        } catch (e) {
          console.error('[App] Fit error on collapse:', e);
        }
      }, 50);
    }
  }

  // Relayout Monaco editor if this is a file pane
  if (pane && pane.type === 'file') {
    const editorInfo = _ctx.fileEditors.get(paneId);
    if (editorInfo?.monacoEditor) {
      setTimeout(() => editorInfo.monacoEditor.layout(), 50);
    }
  }
}

// Render a sticky note pane
export function renderNotePane(paneData) {
  const existingPane = document.getElementById(`pane-${paneData.id}`);
  if (existingPane) {
    const oldInfo = _ctx.noteEditors.get(paneData.id);
    if (oldInfo) {
      if (oldInfo.monacoEditor) oldInfo.monacoEditor.dispose();
      if (oldInfo.resizeObserver) oldInfo.resizeObserver.disconnect();
      _ctx.noteEditors.delete(paneData.id);
    }
    existingPane.remove();
  }

  const pane = document.createElement('div');
  pane.className = 'pane note-pane';
  pane.id = `pane-${paneData.id}`;
  pane.style.left = `${paneData.x}px`;
  pane.style.top = `${paneData.y}px`;
  pane.style.width = `${paneData.width}px`;
  pane.style.height = `${paneData.height}px`;
  pane.style.zIndex = paneData.zIndex;
  pane.dataset.paneId = paneData.id;

  if (!paneData.shortcutNumber) paneData.shortcutNumber = _ctx.getNextShortcutNumber();
  const fontSize = paneData.fontSize || 14;

  // Build images HTML
  const images = paneData.images || [];
  let imagesHtml = '';
  if (images.length > 0) {
    imagesHtml = '<div class="note-images">' + images.map((src, idx) =>
      `<div class="note-image-wrapper" data-img-idx="${idx}">
        <img src="${src}" class="note-image" draggable="false" />
        <button class="note-image-copy" data-tooltip="Copy image" data-img-idx="${idx}">⧉</button>
        <button class="note-image-download" data-tooltip="Download image" data-img-idx="${idx}"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 1v5M3 4.5L5 7l2-2.5"/><path d="M1 8.5h8"/></svg></button>
        <button class="note-image-remove" data-tooltip="Remove image" data-img-idx="${idx}">&times;</button>
      </div>`
    ).join('') + '</div>';
  }

  pane.innerHTML = `
    <div class="pane-header">
      <span class="pane-title">\u{1F4DD} Note</span>
      ${_ctx.paneNameHtml(paneData)}
      <div class="pane-header-right">
        ${_ctx.shortcutBadgeHtml(paneData)}
        <div class="pane-zoom-controls">
          <button class="pane-zoom-btn zoom-out" aria-label="Zoom out" data-tooltip="Zoom out"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.5" y1="15.5" x2="20.5" y2="20.5"/><line x1="7.5" y1="10.5" x2="13.5" y2="10.5"/></svg></button>
          <button class="pane-zoom-btn zoom-in" aria-label="Zoom in" data-tooltip="Zoom in"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.5" y1="15.5" x2="20.5" y2="20.5"/><line x1="7.5" y1="10.5" x2="13.5" y2="10.5"/><line x1="10.5" y1="7.5" x2="10.5" y2="13.5"/></svg></button>
        </div>
        <button class="note-text-only-btn" aria-label="Preview markdown" data-tooltip="Preview markdown">\u{1F441}</button>
        <button class="pane-close" aria-label="Close pane"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    </div>
    <div class="pane-content">
      <div class="note-container">
        ${imagesHtml}
        <div class="note-editor-mount"></div>
        <div class="note-markdown-preview" style="display:none;"></div>
      </div>
    </div>
    <div class="pane-resize-handle"></div>
    <div class="pane-resize-handle-left"></div>
  `;

  setupPaneListeners(pane, paneData);
  _ctx.getCanvas().appendChild(pane);

  initNoteMonaco(pane, paneData);
  setupTextOnlyToggle(pane, paneData);
}

// Initialize Monaco editor for a note pane (markdown mode)
export async function initNoteMonaco(paneEl, paneData) {
  const mountEl = paneEl.querySelector('.note-editor-mount');
  if (!mountEl) return;

  const monaco = await loadMonaco();
  const fontSize = paneData.fontSize || 14;

  const editor = monaco.editor.create(mountEl, {
    value: paneData.content || '',
    language: 'markdown',
    theme: '49agents-dark',
    fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Monaco, monospace',
    fontSize: fontSize,
    lineHeight: 1.6,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: false,
    wordWrap: 'on',
    tabSize: 2,
    insertSpaces: true,
    renderLineHighlight: 'none',
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    smoothScrolling: true,
    folding: false,
    glyphMargin: false,
    lineNumbers: 'off',
    lineDecorationsWidth: 0,
    lineNumbersMinChars: 0,
    padding: { top: 8, bottom: 8 },
    scrollbar: {
      verticalScrollbarSize: 6,
      horizontalScrollbarSize: 6,
      useShadows: false,
    },
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    overviewRulerBorder: false,
    contextmenu: false,
    fixedOverflowWidgets: true,
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    wordBasedSuggestions: 'off',
    parameterHints: { enabled: false },
    suggest: { enabled: false },
    placeholder: 'Quick notes... (markdown supported)',
  });

  const resizeObserver = new ResizeObserver(() => { editor.layout(); });
  resizeObserver.observe(mountEl);

  _ctx.noteEditors.set(paneData.id, { monacoEditor: editor, resizeObserver });

  // Auto-save on content change (debounced)
  let saveTimeout = null;
  editor.onDidChangeModelContent(() => {
    const content = editor.getValue();
    paneData.content = content;
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      agentRequest('PATCH', `/api/notes/${paneData.id}`, { content }, paneData.agentId)
        .catch(e => console.error('Failed to save note:', e));
    }, 500);
    _ctx.cloudSaveNote(paneData.id, content, paneData.fontSize, paneData.images);
  });

  // Prevent pane drag when clicking in editor
  mountEl.addEventListener('mousedown', (e) => e.stopPropagation());
  mountEl.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

  // Image paste handling on Monaco's DOM
  editor.getDomNode().addEventListener('paste', (e) => {
    if (!e.clipboardData || !e.clipboardData.items) return;
    const imageFiles = [];
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const tier = window.__tcTier;
    if (tier && tier.limits && tier.limits.noteImages !== undefined && tier.limits.noteImages !== null) {
      const total = _ctx.state.panes.filter(p => p.type === 'note' && p.images).reduce((s, p) => s + p.images.length, 0);
      if (total + imageFiles.length > tier.limits.noteImages) {
        _ctx.showUpgradePrompt(
          `Your ${(tier.tier || 'free').charAt(0).toUpperCase() + (tier.tier || 'free').slice(1)} plan allows ${tier.limits.noteImages} images across all notes. You have ${total}. Upgrade for more.`
        );
        return;
      }
    }
    if (!paneData.images) paneData.images = [];
    Promise.all(imageFiles.map(file => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    }))).then(dataUrls => {
      const validUrls = dataUrls.filter(Boolean);
      if (validUrls.length === 0) return;
      paneData.images.push(...validUrls);
      refreshNoteImages(paneEl, paneData);
      agentRequest('PATCH', `/api/notes/${paneData.id}`, { images: paneData.images }, paneData.agentId)
        .catch(e => console.error('Failed to save note images:', e));
      _ctx.cloudSaveNote(paneData.id, paneData.content, paneData.fontSize, paneData.images);
    });
  });

  setupImageButtonHandlers(paneEl, paneData);
}

// Helper to refresh images in note pane
export function refreshNoteImages(paneEl, paneData) {
  const container = paneEl.querySelector('.note-container');
  const mountEl = paneEl.querySelector('.note-editor-mount');
  const existing = container.querySelector('.note-images');
  if (existing) existing.remove();
  if (paneData.images && paneData.images.length > 0) {
    const imagesDiv = document.createElement('div');
    imagesDiv.className = 'note-images';
    imagesDiv.innerHTML = paneData.images.map((src, idx) =>
      `<div class="note-image-wrapper" data-img-idx="${idx}">
        <img src="${src}" class="note-image" draggable="false" />
        <button class="note-image-copy" data-tooltip="Copy image" data-img-idx="${idx}">⧉</button>
        <button class="note-image-download" data-tooltip="Download image" data-img-idx="${idx}"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 1v5M3 4.5L5 7l2-2.5"/><path d="M1 8.5h8"/></svg></button>
        <button class="note-image-remove" data-tooltip="Remove image" data-img-idx="${idx}">&times;</button>
      </div>`
    ).join('');
    container.insertBefore(imagesDiv, mountEl);
    setupImageButtonHandlers(paneEl, paneData);
  }
}

// Render markdown to HTML for preview mode (sanitized to prevent XSS)
export async function renderMarkdownPreview(markdown) {
  try {
    const { marked, DOMPurify } = await loadMarkdown();
    const raw = await marked.parse(markdown || '', { breaks: true, gfm: true });
    return DOMPurify.sanitize(raw);
  } catch (e) {
    // Offline, or the CDN is unreachable. Show the source escaped rather than
    // rendering it: loadMarkdown only resolves with a sanitiser in hand, so
    // reaching here means there is nothing safe to render HTML with.
    console.error('[Renderers] Markdown libraries unavailable:', e);
    return escapeHtml(markdown || '').replace(/\n/g, '<br>');
  }
}

// Truncate URL for display in pane header
// truncateUrl — imported from modules/utils.js

// Render an iframe pane
export function renderIframePane(paneData) {

  const existingPane = document.getElementById(`pane-${paneData.id}`);
  if (existingPane) existingPane.remove();

  const pane = document.createElement('div');
  pane.className = 'pane iframe-pane';
  pane.id = `pane-${paneData.id}`;
  pane.style.left = `${paneData.x}px`;
  pane.style.top = `${paneData.y}px`;
  pane.style.width = `${paneData.width}px`;
  pane.style.height = `${paneData.height}px`;
  pane.style.zIndex = paneData.zIndex;
  pane.dataset.paneId = paneData.id;

  if (!paneData.shortcutNumber) paneData.shortcutNumber = _ctx.getNextShortcutNumber();
  pane.innerHTML = `
    <div class="pane-header">
      <span class="pane-title">🌐 ${escapeHtml(truncateUrl(paneData.url))}</span>
      ${_ctx.paneNameHtml(paneData)}
      <div class="pane-header-right">
        ${_ctx.shortcutBadgeHtml(paneData)}
        <button class="pane-mention-btn" data-tooltip="Mention in Claude Code">@</button>
        <button class="iframe-refresh" aria-label="Refresh" data-tooltip="Refresh"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 3a7 7 0 1 0 1 5"/><polyline points="14 1 14 5 10 5"/></svg></button>
        <button class="iframe-open-external" aria-label="Open in browser" data-tooltip="Open in browser"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 2h4v4"/><path d="M14 2L7 9"/><path d="M13 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4"/></svg></button>
        <button class="iframe-edit-url" aria-label="Edit URL" data-tooltip="Edit URL"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 2l3 3-8 8H3v-3z"/></svg></button>
        <button class="pane-expand" aria-label="Expand pane"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 9 4 4 9 4"/><polyline points="15 4 20 4 20 9"/><polyline points="20 15 20 20 15 20"/><polyline points="9 20 4 20 4 15"/></svg></button>
        <button class="pane-close" aria-label="Close pane"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    </div>
    <div class="pane-content">
      <iframe class="iframe-embed" src="${escapeHtml(paneData.url)}"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              loading="lazy"></iframe>
      <div class="iframe-overlay"></div>
    </div>
    <div class="pane-resize-handle"></div>
    <div class="pane-resize-handle-left"></div>
  `;

  setupPaneListeners(pane, paneData);
  setupIframeListeners(pane, paneData);
  _ctx.getCanvas().appendChild(pane);
}

// Setup iframe-specific event listeners
export function setupIframeListeners(paneEl, paneData) {
  const overlay = paneEl.querySelector('.iframe-overlay');
  const iframe = paneEl.querySelector('.iframe-embed');
  const editUrlBtn = paneEl.querySelector('.iframe-edit-url');

  // Mention button
  const mentionBtn = paneEl.querySelector('.pane-mention-btn');
  if (mentionBtn) {
    mentionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _ctx.enterMentionMode({
        type: 'iframe',
        text: paneData.url,
        sourceAgentId: paneData.agentId
      });
    });
  }

  // Refresh button
  paneEl.querySelector('.iframe-refresh').addEventListener('click', (e) => {
    e.stopPropagation();
    iframe.src = paneData.url;
  });

  // Open in browser button
  paneEl.querySelector('.iframe-open-external').addEventListener('click', (e) => {
    e.stopPropagation();
    window.open(paneData.url, '_blank');
  });

  editUrlBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    let newUrl = prompt('Enter new URL:', paneData.url);
    if (!newUrl || !newUrl.trim() || newUrl.trim() === paneData.url) return;
    newUrl = newUrl.trim();
    if (!/^https?:\/\//i.test(newUrl)) newUrl = 'http://' + newUrl;

    try {
      new URL(newUrl);
    } catch {
      alert('Invalid URL format');
      return;
    }

    try {
      await agentRequest('PATCH', `/api/iframes/${paneData.id}`, { url: newUrl }, paneData.agentId);
      paneData.url = newUrl;
      iframe.src = newUrl;
      const title = paneEl.querySelector('.pane-title');
      if (title) title.textContent = `🌐 ${truncateUrl(newUrl)}`;
    } catch (err) {
      console.error('Failed to update iframe URL:', err);
    }
  });

  // Click on overlay = user wants to interact with iframe — hide overlay
  paneEl.querySelector('.pane-content').addEventListener('mousedown', (e) => {
    if (e.target === overlay) {
      overlay.style.display = 'none';
    }
  });
}

// Show/hide iframe overlays during drag/resize/pan operations
export function showIframeOverlays() {
  document.querySelectorAll('.iframe-overlay').forEach(o => o.style.display = 'block');
}
export function hideIframeOverlays() {
  document.querySelectorAll('.iframe-overlay').forEach(o => o.style.display = 'none');
}

// ==================== Beads Issues Pane ====================

export async function createFolderPane(folderPath, placementPos, targetAgentId, device) {
  const resolvedAgentId = targetAgentId || _ctx.getActiveAgentId();
  const position = calcPlacementPos(placementPos, 200, 250);

  try {
    const reqBody = { folderPath, position, size: PANE_DEFAULTS['folder'] };
    if (device) reqBody.device = device;
    const fpPane = await agentRequest('POST', '/api/folder-panes', reqBody, resolvedAgentId);

    const pane = {
      id: fpPane.id,
      type: 'folder',
      x: fpPane.position.x,
      y: fpPane.position.y,
      width: fpPane.size.width,
      height: fpPane.size.height,
      zIndex: _ctx.state.nextZIndex++,
      folderPath: fpPane.folderPath,
      device: device || fpPane.device || null,
      agentId: resolvedAgentId
    };

    _ctx.state.panes.push(pane); _ctx.telemetry.trackPaneOpen(pane);
    renderFolderPane(pane);
    _ctx.cloudSaveLayout(pane);
    _ctx.saveRecentContext('folder', pane.folderPath, pane.folderPath.split('/').filter(Boolean).pop() || pane.folderPath, resolvedAgentId);
  } catch (e) {
    console.error('[App] Failed to create folder pane:', e);
    alert('Failed to create folder pane: ' + e.message);
  }
}

export async function createBeadsPane(projectPath, placementPos, targetAgentId, device) {
  const resolvedAgentId = targetAgentId || _ctx.getActiveAgentId();
  const position = calcPlacementPos(placementPos, 260, 250);

  try {
    const reqBody = { projectPath, position, size: PANE_DEFAULTS['beads'] };
    if (device) reqBody.device = device;
    const bpData = await agentRequest('POST', '/api/beads-panes', reqBody, resolvedAgentId);

    const pane = {
      id: bpData.id,
      type: 'beads',
      x: bpData.position.x,
      y: bpData.position.y,
      width: bpData.size.width,
      height: bpData.size.height,
      zIndex: _ctx.state.nextZIndex++,
      projectPath: bpData.projectPath,
      device: device || bpData.device || null,
      agentId: resolvedAgentId
    };

    _ctx.state.panes.push(pane); _ctx.telemetry.trackPaneOpen(pane);
    renderBeadsPane(pane);
    _ctx.cloudSaveLayout(pane);
    _ctx.saveRecentContext('beads', pane.projectPath, pane.projectPath.split('/').filter(Boolean).pop() || pane.projectPath, resolvedAgentId);
  } catch (e) {
    console.error('[App] Failed to create beads pane:', e);
    alert('Failed to create beads pane: ' + e.message);
  }
}

export function renderBeadsPane(paneData) {
  // See renderGitGraphPane: re-render must stop the previous poll first.
  clearPaneRefresh(_ctx.beadsPanes, paneData.id);

  const existingPane = document.getElementById(`pane-${paneData.id}`);
  if (existingPane) existingPane.remove();

  const pane = document.createElement('div');
  pane.className = 'pane beads-pane';
  pane.id = `pane-${paneData.id}`;
  pane.style.left = `${paneData.x}px`;
  pane.style.top = `${paneData.y}px`;
  pane.style.width = `${paneData.width}px`;
  pane.style.height = `${paneData.height}px`;
  pane.style.zIndex = paneData.zIndex;
  pane.dataset.paneId = paneData.id;

  if (!paneData.shortcutNumber) paneData.shortcutNumber = _ctx.getNextShortcutNumber();
  const deviceTag = paneData.device ? _ctx.deviceLabelHtml(paneData.device) : '';
  pane.innerHTML = `
    <div class="pane-header">
      <span class="pane-title beads-title">
        ${deviceTag}<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align: middle; margin-right: 4px;">${ICON_BEADS}</svg>
        Beads Issues
      </span>
      ${_ctx.paneNameHtml(paneData)}
      <div class="pane-header-right">
        ${_ctx.shortcutBadgeHtml(paneData)}
        <div class="pane-zoom-controls">
          <button class="pane-zoom-btn zoom-out" aria-label="Zoom out" data-tooltip="Zoom out"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.5" y1="15.5" x2="20.5" y2="20.5"/><line x1="7.5" y1="10.5" x2="13.5" y2="10.5"/></svg></button>
          <button class="pane-zoom-btn zoom-in" aria-label="Zoom in" data-tooltip="Zoom in"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.5" y1="15.5" x2="20.5" y2="20.5"/><line x1="7.5" y1="10.5" x2="13.5" y2="10.5"/><line x1="10.5" y1="7.5" x2="10.5" y2="13.5"/></svg></button>
        </div>
        <button class="pane-expand" aria-label="Expand pane" data-tooltip="Expand"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 9 4 4 9 4"/><polyline points="15 4 20 4 20 9"/><polyline points="20 15 20 20 15 20"/><polyline points="9 20 4 20 4 15"/></svg></button>
        <button class="pane-close" aria-label="Close pane"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    </div>
    <div class="pane-content">
      <div class="beads-container">
        <div class="beads-header">
          <div class="beads-counts">
            <span class="beads-filter-btn beads-badge beads-badge-open active" data-filter="open" data-tooltip="Toggle open issues">\u25CB 0</span>
            <span class="beads-filter-btn beads-badge beads-badge-progress active" data-filter="in_progress" data-tooltip="Toggle in-progress issues">\u25D0 0</span>
            <span class="beads-filter-btn beads-badge beads-badge-blocked active" data-filter="blocked" data-tooltip="Toggle blocked issues">\uD83D\uDD12 0</span>
          </div>
          <div class="beads-search-wrap">
            <input type="text" class="beads-search" placeholder="Search issues..." />
          </div>
          <button class="beads-add-btn" data-tooltip="Create issue">+</button>
        </div>
        <div class="beads-create-form" style="display:none">
          <input type="text" class="beads-create-title" placeholder="Issue title..." />
          <span class="beads-create-type-slot"></span>
          <span class="beads-create-priority-slot"></span>
          <button class="beads-create-submit">\u2714</button>
        </div>
        <div class="beads-table-wrap">
          <table class="beads-table">
            <colgroup>
              <col style="width:24px">
              <col style="width:52px">
              <col style="width:42px">
              <col style="width:58px">
              <col>
            </colgroup>
            <thead>
              <tr>
                <th class="beads-col-status"><div class="beads-col-resize"></div></th>
                <th class="beads-col-id">ID<div class="beads-col-resize"></div></th>
                <th class="beads-col-priority">P<div class="beads-col-resize"></div></th>
                <th class="beads-col-type">Type<div class="beads-col-resize"></div></th>
                <th class="beads-col-title">Title</th>
              </tr>
            </thead>
            <tbody class="beads-table-body">
              <tr><td colspan="5" class="beads-loading">Loading issues...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="pane-resize-handle"></div>
    <div class="pane-resize-handle-left"></div>
  `;

  setupPaneListeners(pane, paneData);
  setupBeadsListeners(pane, paneData);
  _ctx.getCanvas().appendChild(pane);

  // Initial data fetch
  fetchBeadsData(pane, paneData);
}

export function renderFolderPane(paneData) {
  // See renderGitGraphPane: re-render must stop the previous poll first.
  clearPaneRefresh(_ctx.folderPanes, paneData.id);

  const existingPane = document.getElementById(`pane-${paneData.id}`);
  if (existingPane) existingPane.remove();

  const pane = document.createElement('div');
  pane.className = 'pane folder-pane';
  pane.id = `pane-${paneData.id}`;
  pane.style.left = `${paneData.x}px`;
  pane.style.top = `${paneData.y}px`;
  pane.style.width = `${paneData.width}px`;
  pane.style.height = `${paneData.height}px`;
  pane.style.zIndex = paneData.zIndex;
  pane.dataset.paneId = paneData.id;

  if (!paneData.shortcutNumber) paneData.shortcutNumber = _ctx.getNextShortcutNumber();
  const shortPath = paneData.folderPath.replace(/^\/home\/[^/]+/, '~');
  const deviceTag = paneData.device ? _ctx.deviceLabelHtml(paneData.device) : '';

  pane.innerHTML = `
    <div class="pane-header">
      <span class="pane-title folder-title">
        ${deviceTag}<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align: middle; margin-right: 4px;">${ICON_FOLDER}</svg>
        <span class="folder-path-label">${escapeHtml(shortPath)}</span>
      </span>
      ${_ctx.paneNameHtml(paneData)}
      <div class="pane-header-right">
        ${_ctx.shortcutBadgeHtml(paneData)}
        <button class="folder-toolbar-btn folder-new-file-btn" data-tooltip="New File">
          <svg viewBox="0 0 24 24" width="14" height="14"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" fill="none" stroke="currentColor" stroke-width="2"/><line x1="12" y1="11" x2="12" y2="17" stroke="currentColor" stroke-width="2"/><line x1="9" y1="14" x2="15" y2="14" stroke="currentColor" stroke-width="2"/></svg>
        </button>
        <button class="folder-toolbar-btn folder-new-dir-btn" data-tooltip="New Folder">
          <svg viewBox="0 0 24 24" width="14" height="14"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" fill="none" stroke="currentColor" stroke-width="2"/><line x1="12" y1="11" x2="12" y2="17" stroke="currentColor" stroke-width="2"/><line x1="9" y1="14" x2="15" y2="14" stroke="currentColor" stroke-width="2"/></svg>
        </button>
        <button class="folder-toolbar-btn folder-toggle-hidden-btn" data-tooltip="Toggle hidden files">
          <svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" fill="none" stroke="currentColor" stroke-width="2"/></svg>
        </button>
        <button class="folder-toolbar-btn folder-refresh-btn" data-tooltip="Refresh">
          <svg viewBox="0 0 24 24" width="14" height="14"><path d="M23 4v6h-6M1 20v-6h6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" fill="none" stroke="currentColor" stroke-width="2"/></svg>
        </button>
        <div class="pane-zoom-controls">
          <button class="pane-zoom-btn zoom-out" aria-label="Zoom out" data-tooltip="Zoom out"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.5" y1="15.5" x2="20.5" y2="20.5"/><line x1="7.5" y1="10.5" x2="13.5" y2="10.5"/></svg></button>
          <button class="pane-zoom-btn zoom-in" aria-label="Zoom in" data-tooltip="Zoom in"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.5" y1="15.5" x2="20.5" y2="20.5"/><line x1="7.5" y1="10.5" x2="13.5" y2="10.5"/><line x1="10.5" y1="7.5" x2="10.5" y2="13.5"/></svg></button>
        </div>
        <button class="pane-expand" aria-label="Expand pane" data-tooltip="Expand"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 9 4 4 9 4"/><polyline points="15 4 20 4 20 9"/><polyline points="20 15 20 20 15 20"/><polyline points="9 20 4 20 4 15"/></svg></button>
        <button class="pane-close" aria-label="Close pane"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    </div>
    <div class="folder-git-bar" style="display:none;">
      <svg viewBox="0 0 24 24" width="12" height="12" class="folder-git-icon">
        <circle cx="7" cy="6" r="2" fill="currentColor"/><circle cx="17" cy="6" r="2" fill="currentColor"/><circle cx="7" cy="18" r="2" fill="currentColor"/>
        <line x1="7" y1="8" x2="7" y2="16" stroke="currentColor" stroke-width="1.5"/>
        <path d="M17 8c0 3.5-10 3.5-10 6" stroke="currentColor" stroke-width="1.5" fill="none"/>
      </svg>
      <span class="folder-git-branch"></span>
      <span class="folder-git-status"></span>
      <span class="folder-git-counts"></span>
    </div>
    <div class="pane-content">
      <div class="folder-tree-container">
        <div class="folder-tree-loading">Loading...</div>
      </div>
    </div>
    <div class="pane-resize-handle"></div>
    <div class="pane-resize-handle-left"></div>
  `;

  _ctx.getCanvas().appendChild(pane);
  setupPaneListeners(pane, paneData);

  // Runtime state
  const treeCache = {};
  const expandedPaths = new Set();
  let showHidden = false;
  let gitFileStatus = {}; // absolute path -> 'modified'|'added'|'deleted'|'untracked'|'renamed'
  const treeContainer = pane.querySelector('.folder-tree-container');
  const gitBar = pane.querySelector('.folder-git-bar');

  function getDirGitStatus(dirPath) {
    // A directory inherits the "worst" status of any child file
    const priority = { deleted: 4, added: 3, modified: 2, renamed: 2, untracked: 1 };
    let worst = null, worstP = 0;
    for (const [fp, st] of Object.entries(gitFileStatus)) {
      if (fp.startsWith(dirPath + '/')) {
        const p = priority[st] || 0;
        if (p > worstP) { worstP = p; worst = st; }
      }
    }
    return worst;
  }

  async function fetchGitStatus() {
    try {
      const gs = await agentRequest('GET', `/api/git-status?path=${encodeURIComponent(paneData.folderPath)}`, null, paneData.agentId);
      if (gs.isGit) {
        gitBar.style.display = '';
        gitBar.querySelector('.folder-git-branch').textContent = gs.branch;
        const statusEl = gitBar.querySelector('.folder-git-status');
        if (gs.clean) {
          statusEl.textContent = '\u2713';
          statusEl.className = 'folder-git-status folder-git-clean';
        } else {
          statusEl.textContent = '\u25CF';
          statusEl.className = 'folder-git-status folder-git-dirty';
        }
        const u = gs.uncommitted;
        const parts = [];
        if (u.staged > 0) parts.push(`+${u.staged}`);
        if (u.unstaged > 0) parts.push(`~${u.unstaged}`);
        if (u.untracked > 0) parts.push(`?${u.untracked}`);
        gitBar.querySelector('.folder-git-counts').textContent = parts.join(' ');
        gitFileStatus = gs.files || {};
        renderTree();
      } else {
        gitBar.style.display = 'none';
        gitFileStatus = {};
      }
    } catch {
      gitBar.style.display = 'none';
      gitFileStatus = {};
    }
  }

  async function fetchDir(dirPath) {
    const qs = showHidden ? `?path=${encodeURIComponent(dirPath)}&showHidden=1` : `?path=${encodeURIComponent(dirPath)}`;
    const result = await agentRequest('GET', `/api/files/browse${qs}`, null, paneData.agentId);
    treeCache[dirPath] = result.entries;
    return result.entries;
  }

  function renderTree() {
    treeContainer.innerHTML = '';
    const rootEntries = treeCache[paneData.folderPath];
    if (!rootEntries) {
      treeContainer.innerHTML = '<div class="folder-tree-loading">Loading...</div>';
      return;
    }
    renderEntries(rootEntries, paneData.folderPath, 0, treeContainer);
  }

  function renderEntries(entries, parentPath, depth, container) {
    for (const entry of entries) {
      const fullPath = parentPath + '/' + entry.name;
      const row = document.createElement('div');
      const gitSt = entry.type === 'dir' ? getDirGitStatus(fullPath) : (gitFileStatus[fullPath] || null);
      row.className = 'folder-tree-item' + (entry.type === 'dir' ? ' folder-tree-dir' : ' folder-tree-file') + (gitSt ? ` git-${gitSt}` : '');
      row.style.paddingLeft = `${8 + depth * 16}px`;
      row.dataset.path = fullPath;
      row.dataset.entryType = entry.type;

      const isExpanded = expandedPaths.has(fullPath);

      if (entry.type === 'dir') {
        row.innerHTML = `
          <span class="folder-tree-chevron">${isExpanded ? '&#9660;' : '&#9654;'}</span>
          <svg viewBox="0 0 24 24" width="14" height="14" class="folder-tree-icon"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" fill="none" stroke="currentColor" stroke-width="2"/></svg>
          <span class="folder-tree-name">${escapeHtml(entry.name)}</span>
          <span class="folder-tree-actions">
            <button class="folder-tree-action-btn folder-rename-btn" data-tooltip="Rename">&#9998;</button>
            <button class="folder-tree-action-btn folder-delete-btn" data-tooltip="Delete">&#128465;</button>
          </span>
        `;
      } else {
        const sizeStr = entry.size != null ? formatFileSize(entry.size) : '';
        row.innerHTML = `
          <span class="folder-tree-chevron" style="visibility:hidden">&#9654;</span>
          <svg viewBox="0 0 24 24" width="14" height="14" class="folder-tree-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" fill="none" stroke="currentColor" stroke-width="2"/><polyline points="14 2 14 8 20 8" fill="none" stroke="currentColor" stroke-width="2"/></svg>
          <span class="folder-tree-name">${escapeHtml(entry.name)}</span>
          <span class="folder-tree-size">${sizeStr}</span>
          <span class="folder-tree-actions">
            <button class="folder-tree-action-btn folder-rename-btn" data-tooltip="Rename">&#9998;</button>
            <button class="folder-tree-action-btn folder-delete-btn" data-tooltip="Delete">&#128465;</button>
          </span>
        `;
      }

      container.appendChild(row);

      row.addEventListener('click', async (e) => {
        if (e.target.closest('.folder-tree-action-btn')) return;
        if (entry.type === 'dir') {
          if (isExpanded) {
            expandedPaths.delete(fullPath);
          } else {
            expandedPaths.add(fullPath);
            if (!treeCache[fullPath]) {
              try { await fetchDir(fullPath); } catch(err) { console.error('[Folder] Failed to load', fullPath, err); }
            }
          }
          renderTree();
        } else {
          openFileFromFolder(fullPath, paneData.agentId);
        }
      });

      row.querySelector('.folder-rename-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        startInlineRename(row, entry, parentPath);
      });

      row.querySelector('.folder-delete-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${entry.name}"?`)) return;
        try {
          await agentRequest('DELETE', '/api/files/delete', { path: fullPath }, paneData.agentId);
          if (treeCache[parentPath]) {
            treeCache[parentPath] = treeCache[parentPath].filter(e2 => e2.name !== entry.name);
          }
          if (entry.type === 'dir') {
            delete treeCache[fullPath];
            expandedPaths.delete(fullPath);
          }
          renderTree();
        } catch (err) {
          alert('Delete failed: ' + err.message);
        }
      });

      if (entry.type === 'dir' && isExpanded && treeCache[fullPath]) {
        renderEntries(treeCache[fullPath], fullPath, depth + 1, container);
      }
    }
  }

  function startInlineRename(row, entry, parentPath) {
    const nameSpan = row.querySelector('.folder-tree-name');
    const oldName = entry.name;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = oldName;
    input.className = 'folder-rename-input';
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    const finish = async (commit) => {
      if (commit && input.value && input.value !== oldName) {
        const oldPath = parentPath + '/' + oldName;
        const newPath = parentPath + '/' + input.value;
        try {
          await agentRequest('POST', '/api/files/rename', { oldPath, newPath }, paneData.agentId);
          entry.name = input.value;
          if (entry.type === 'dir' && treeCache[oldPath]) {
            treeCache[newPath] = treeCache[oldPath];
            delete treeCache[oldPath];
            for (const p of [...expandedPaths]) {
              if (p === oldPath || p.startsWith(oldPath + '/')) {
                expandedPaths.delete(p);
                expandedPaths.add(p.replace(oldPath, newPath));
              }
            }
          }
        } catch (err) {
          alert('Rename failed: ' + err.message);
        }
      }
      renderTree();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' K';
    return (bytes / (1024 * 1024)).toFixed(1) + ' M';
  }

  async function openFileFromFolder(filePath, agentId) {
    try {
      const reqBody = { filePath, position: { x: paneData.x + paneData.width + 20, y: paneData.y }, size: PANE_DEFAULTS['file'] };
      const fp = await agentRequest('POST', '/api/file-panes', reqBody, agentId);
      const newPane = {
        id: fp.id,
        type: 'file',
        x: fp.position.x,
        y: fp.position.y,
        width: fp.size.width,
        height: fp.size.height,
        zIndex: _ctx.state.nextZIndex++,
        fileName: fp.fileName,
        filePath: fp.filePath,
        content: fp.content,
        device: fp.device || null,
        agentId: agentId
      };
      _ctx.state.panes.push(newPane); _ctx.telemetry.trackPaneOpen(newPane);
      _ctx.renderFilePane(newPane);
      _ctx.cloudSaveLayout(newPane);
    } catch (e) {
      alert('Failed to open file: ' + e.message);
    }
  }

  // Toolbar: New File
  pane.querySelector('.folder-new-file-btn').addEventListener('click', async () => {
    const name = prompt('New file name:');
    if (!name) return;
    try {
      await agentRequest('POST', '/api/files/create', { path: paneData.folderPath + '/' + name }, paneData.agentId);
      await refreshTree();
    } catch (e) { alert('Create file failed: ' + e.message); }
  });

  // Toolbar: New Folder
  pane.querySelector('.folder-new-dir-btn').addEventListener('click', async () => {
    const name = prompt('New folder name:');
    if (!name) return;
    try {
      await agentRequest('POST', '/api/files/mkdir', { path: paneData.folderPath + '/' + name }, paneData.agentId);
      await refreshTree();
    } catch (e) { alert('Create folder failed: ' + e.message); }
  });

  // Toolbar: Toggle hidden
  pane.querySelector('.folder-toggle-hidden-btn').addEventListener('click', async () => {
    showHidden = !showHidden;
    pane.querySelector('.folder-toggle-hidden-btn').classList.toggle('active', showHidden);
    Object.keys(treeCache).forEach(k => delete treeCache[k]);
    await refreshTree();
  });

  // Toolbar: Refresh
  pane.querySelector('.folder-refresh-btn').addEventListener('click', () => refreshTree());

  async function refreshTree() {
    const pathsToRefresh = [paneData.folderPath, ...expandedPaths];
    await Promise.all(
      pathsToRefresh.map(p => fetchDir(p).catch(() => null))
    );
    renderTree();
  }

  const refreshInterval = setInterval(() => {
    refreshTree().catch(() => {});
    fetchGitStatus();
  }, 5000);

  _ctx.folderPanes.set(paneData.id, { refreshInterval });

  fetchDir(paneData.folderPath).then(() => renderTree()).catch(err => {
    treeContainer.innerHTML = `<div style="padding:20px; text-align:center; color:#f44747; font-size:12px;">Error: ${escapeHtml(err.message)}</div>`;
  });
  fetchGitStatus();
}

export function setupBeadsListeners(paneEl, paneData) {
  // Track issues being closed so refreshes don't bring them back
  if (!paneEl._closedIssues) paneEl._closedIssues = new Set();

  const tableWrap = paneEl.querySelector('.beads-table-wrap');
  const searchInput = paneEl.querySelector('.beads-search');
  // Filter toggle buttons
  paneEl.querySelectorAll('.beads-filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      btn.classList.toggle('active');
      applyBeadsFilters(paneEl);
    });
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
  });

  // Prevent drag/pan when interacting with scrollable table
  tableWrap.addEventListener('mousedown', (e) => e.stopPropagation());
  tableWrap.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
  tableWrap.addEventListener('wheel', (e) => { if (!_ctx.getTabHeld()) e.stopPropagation(); }, { passive: true });

  // Search input shouldn't trigger drag
  searchInput.addEventListener('mousedown', (e) => e.stopPropagation());
  searchInput.addEventListener('keydown', (e) => e.stopPropagation());

  // Create issue form
  const addBtn = paneEl.querySelector('.beads-add-btn');
  const createForm = paneEl.querySelector('.beads-create-form');
  const createTitle = paneEl.querySelector('.beads-create-title');
  const typeSlot = paneEl.querySelector('.beads-create-type-slot');
  const createType = _ctx.createCustomSelect(
    [{ value: 'task', label: 'task' }, { value: 'feature', label: 'feature' }, { value: 'bug', label: 'bug' }],
    'task'
  );
  typeSlot.appendChild(createType.el);

  const prioritySlot = paneEl.querySelector('.beads-create-priority-slot');
  const createPriority = _ctx.createCustomSelect(
    [{ value: '0', label: 'P0' }, { value: '1', label: 'P1' }, { value: '2', label: 'P2' }, { value: '3', label: 'P3' }, { value: '4', label: 'P4' }],
    '2'
  );
  prioritySlot.appendChild(createPriority.el);
  const createSubmit = paneEl.querySelector('.beads-create-submit');

  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const visible = createForm.style.display !== 'none';
    createForm.style.display = visible ? 'none' : 'flex';
    if (!visible) createTitle.focus();
  });
  addBtn.addEventListener('mousedown', (e) => e.stopPropagation());

  createForm.addEventListener('mousedown', (e) => e.stopPropagation());
  createTitle.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') createSubmit.click();
    if (e.key === 'Escape') { createForm.style.display = 'none'; }
  });

  createSubmit.addEventListener('click', async (e) => {
    e.stopPropagation();
    const title = createTitle.value.trim();
    if (!title) return;
    createSubmit.disabled = true;
    try {
      await agentRequest('POST', `/api/beads-panes/${paneData.id}/issues`, { title, type: createType.value, priority: Number(createPriority.value) }, paneData.agentId);
      createTitle.value = '';
      createForm.style.display = 'none';
      fetchBeadsData(paneEl, paneData);
    } catch (err) {
      console.error('[Beads] Failed to create issue:', err);
    }
    createSubmit.disabled = false;
  });

  // Search filter — reuses shared filter logic
  searchInput.addEventListener('input', () => applyBeadsFilters(paneEl));

  // Row click → expand/collapse detail
  paneEl.addEventListener('click', async (e) => {
    // Done button in detail row
    const doneBtn = e.target.closest('.beads-done-btn');
    if (doneBtn) {
      e.stopPropagation();
      const issueId = doneBtn.dataset.issueId;
      // Remove the row and its detail row immediately
      const detailRow = doneBtn.closest('tr.beads-detail-row');
      const beadsRow = detailRow?.previousElementSibling;
      if (detailRow) detailRow.remove();
      if (beadsRow && beadsRow.classList.contains('beads-row')) beadsRow.remove();
      // Track as closed so refreshes won't bring it back
      paneEl._closedIssues.add(issueId);
      // Close the issue in the background
      agentRequest('POST', `/api/beads-panes/${paneData.id}/issues/${encodeURIComponent(issueId)}/close`, {}, paneData.agentId)
        .catch(err => console.error('[Beads] Failed to close issue:', err));
      return;
    }
    // Beads mention button (@ on row)
    const mentionBtn = e.target.closest('.beads-mention-btn');
    if (mentionBtn) {
      e.stopPropagation();
      const issueId = mentionBtn.dataset.issueId;
      const row = mentionBtn.closest('tr.beads-row');
      const issueTitle = row?.querySelector('.beads-title-text')?.textContent?.trim() || '';
      const issueStatus = row?.dataset.status || 'open';
      const issueBlocked = row?.dataset.blocked === 'true';
      _ctx.enterMentionMode({
        type: 'beads',
        text: `work on this beads issue: ${issueId}, abide claude.md rules!!!`,
        sourceAgentId: paneData.agentId,
        issueId,
        issueTitle,
        issueStatus,
        issueBlocked
      });
      return;
    }
    const row = e.target.closest('tr.beads-row');
    if (!row) return;
    // In mention mode stage 1, clicking a beads row selects that issue
    if (_ctx.getMentionStage() === 1) {
      e.stopPropagation();
      const issueId = row.dataset.issueId;
      if (issueId) {
        const issueTitle = row.querySelector('.beads-title-text')?.textContent?.trim() || '';
        const issueStatus = row.dataset.status || 'open';
        const issueBlocked = row.dataset.blocked === 'true';
        _ctx.enterMentionMode({
          type: 'beads',
          text: `work on this beads issue: ${issueId}, abide claude.md rules!!!`,
          sourceAgentId: paneData.agentId,
          issueId,
          issueTitle,
          issueStatus,
          issueBlocked
        });
      }
      return;
    }
    const detailRow = row.nextElementSibling;
    if (detailRow && detailRow.classList.contains('beads-detail-row')) {
      detailRow.classList.toggle('expanded');
    }
  });

  // Column resize drag handles
  const cols = paneEl.querySelectorAll('.beads-table colgroup col');
  paneEl.querySelectorAll('.beads-col-resize').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const th = handle.parentElement;
      const colIndex = Array.from(th.parentElement.children).indexOf(th);
      const col = cols[colIndex];
      if (!col) return;
      const startX = e.clientX;
      const startWidth = th.offsetWidth;

      const onMove = (ev) => {
        const delta = ev.clientX - startX;
        const newWidth = Math.max(16, startWidth + delta);
        col.style.width = newWidth + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });

  // Auto-refresh every 10 seconds
  const refreshInterval = setInterval(() => {
    fetchBeadsData(paneEl, paneData);
  }, 10000);

  _ctx.beadsPanes.set(paneData.id, { refreshInterval });
}

export async function fetchBeadsData(paneEl, paneData) {
  try {
    const data = await agentRequest('GET', `/api/beads-panes/${paneData.id}/data`, null, paneData.agentId);

    const tbody = paneEl.querySelector('.beads-table-body');

    if (data.error) {
      tbody.innerHTML = `<tr><td colspan="5" class="beads-error">${escapeHtml(data.error)}</td></tr>`;
      return;
    }

    // Filter out issues closed via the done button
    const closedIssues = paneEl._closedIssues || new Set();
    if (closedIssues.size > 0) {
      data.issues = (data.issues || []).filter(i => !closedIssues.has(i.id));
    }

    // Count by status and blocked state (blocked is mutually exclusive with open/in_progress)
    let openCount = 0, progressCount = 0, closedCount = 0, blockedCount = 0;
    for (const issue of (data.issues || [])) {
      const isBlocked = issue.dependency_count > 0 && issue.status !== 'closed';
      if (isBlocked) {
        blockedCount++;
      } else if (issue.status === 'open') {
        openCount++;
      } else if (issue.status === 'in_progress') {
        progressCount++;
      } else if (issue.status === 'closed') {
        closedCount++;
      }
    }

    // Update filter badge counts (preserve active state)
    const openBtn = paneEl.querySelector('.beads-filter-btn[data-filter="open"]');
    const progressBtn = paneEl.querySelector('.beads-filter-btn[data-filter="in_progress"]');
    const blockedBtn = paneEl.querySelector('.beads-filter-btn[data-filter="blocked"]');
    if (openBtn) openBtn.textContent = '\u25CB ' + openCount;
    if (progressBtn) progressBtn.textContent = '\u25D0 ' + progressCount;
    if (blockedBtn) blockedBtn.textContent = '\uD83D\uDD12 ' + blockedCount;

    if (!data.issues || data.issues.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="beads-empty">No issues found</td></tr>';
      return;
    }

    // Sort: non-blocked in_progress first, then non-blocked open, then blocked, then closed; by priority within each group
    const sorted = [...data.issues].sort((a, b) => {
      const aBlocked = a.dependency_count > 0 && a.status !== 'closed';
      const bBlocked = b.dependency_count > 0 && b.status !== 'closed';
      const orderA = aBlocked ? 2 : a.status === 'in_progress' ? 0 : a.status === 'closed' ? 3 : 1;
      const orderB = bBlocked ? 2 : b.status === 'in_progress' ? 0 : b.status === 'closed' ? 3 : 1;
      if (orderA !== orderB) return orderA - orderB;
      const priDiff = (a.priority ?? 2) - (b.priority ?? 2);
      if (priDiff !== 0) return priDiff;
      const typeOrder = { bug: 0, task: 1, feature: 2 };
      return (typeOrder[a.issue_type] ?? 1) - (typeOrder[b.issue_type] ?? 1);
    });

    const searchInput = paneEl.querySelector('.beads-search');
    const currentQuery = (searchInput?.value || '').toLowerCase().trim();

    // Get active filters
    const activeFilters = new Set();
    paneEl.querySelectorAll('.beads-filter-btn.active').forEach(btn => activeFilters.add(btn.dataset.filter));

    let html = '';
    for (const issue of sorted) {
      const isBlocked = issue.dependency_count > 0 && issue.status !== 'closed';
      const statusIcon = isBlocked
        ? '<span class="beads-status-icon beads-status-blocked" data-tooltip="Blocked">\uD83D\uDD12</span>'
        : issue.status === 'in_progress'
        ? '<span class="beads-status-icon beads-status-progress" data-tooltip="In Progress">\u25D0</span>'
        : issue.status === 'closed'
        ? '<span class="beads-status-icon beads-status-closed" data-tooltip="Closed">\u25CF</span>'
        : '<span class="beads-status-icon beads-status-open" data-tooltip="Open">\u25CB</span>';
      const priorityClass = `beads-p${issue.priority ?? 2}`;
      const shortId = issue.id.replace(/^.*-/, '');
      const typeLabel = issue.issue_type || 'task';
      const typeClass = `beads-type-${typeLabel}`;
      const title = escapeHtml(issue.title || '');
      const desc = escapeHtml(issue.description || '');
      const searchText = `${issue.id} ${issue.title || ''} ${issue.description || ''} ${typeLabel}`.toLowerCase();

      // Determine visibility: must pass both search and status filter
      // Blocked issues are a separate category — only shown by the "blocked" filter
      const passesSearch = !currentQuery || searchText.includes(currentQuery);
      let passesFilter;
      if (isBlocked) {
        passesFilter = activeFilters.has('blocked');
      } else if (issue.status === 'closed') {
        passesFilter = false;
      } else {
        passesFilter = activeFilters.has(issue.status);
      }
      const hidden = (!passesSearch || !passesFilter) ? ' style="display:none"' : '';

      const deps = issue.dependency_count ? `<span class="beads-deps" data-tooltip="Dependencies">\u2191${issue.dependency_count}</span>` : '';
      const depnts = issue.dependent_count ? `<span class="beads-depnts" data-tooltip="Dependents">\u2193${issue.dependent_count}</span>` : '';

      html += `<tr class="beads-row" data-issue-id="${escapeHtml(issue.id)}" data-status="${issue.status}" data-blocked="${isBlocked}" data-search-text="${escapeHtml(searchText)}"${hidden}>
        <td class="beads-col-status">${statusIcon}</td>
        <td class="beads-col-id"><span class="beads-id">${escapeHtml(shortId)}</span></td>
        <td class="beads-col-priority"><span class="beads-priority ${priorityClass}">P${issue.priority ?? 2}</span></td>
        <td class="beads-col-type"><span class="beads-type ${typeClass}">${typeLabel}</span></td>
        <td class="beads-col-title"><span class="beads-title-text">${title} ${deps}${depnts}</span><button class="beads-mention-btn" data-issue-id="${escapeHtml(issue.id)}" data-tooltip="Mention in Claude Code">@</button></td>
      </tr>
      <tr class="beads-detail-row" data-status="${issue.status}" data-blocked="${isBlocked}">
        <td colspan="5">
          <div class="beads-detail-content">
            <div class="beads-detail-left">
              <div class="beads-detail-id">${escapeHtml(issue.id)}</div>
              ${desc ? `<div class="beads-detail-desc">${desc}</div>` : '<div class="beads-detail-desc beads-no-desc">No description</div>'}
            </div>
            ${issue.status !== 'closed' ? `<button class="beads-done-btn" data-issue-id="${escapeHtml(issue.id)}" data-tooltip="Close issue">\u2714</button>` : ''}
          </div>
        </td>
      </tr>`;
    }

    // Preserve expanded state across refresh
    const expandedIds = new Set();
    tbody.querySelectorAll('.beads-detail-row.expanded').forEach(row => {
      const beadsRow = row.previousElementSibling;
      if (beadsRow) expandedIds.add(beadsRow.dataset.issueId);
    });

    tbody.innerHTML = html;

    // Restore expanded state
    if (expandedIds.size > 0) {
      tbody.querySelectorAll('.beads-row').forEach(row => {
        if (expandedIds.has(row.dataset.issueId)) {
          const detailRow = row.nextElementSibling;
          if (detailRow && detailRow.classList.contains('beads-detail-row')) {
            detailRow.classList.add('expanded');
          }
        }
      });
    }
  } catch (e) {
    console.error('[App] Failed to fetch beads data:', e);
  }
}

export function applyBeadsFilters(paneEl) {
  const searchInput = paneEl.querySelector('.beads-search');
  const query = (searchInput?.value || '').toLowerCase().trim();
  const activeFilters = new Set();
  paneEl.querySelectorAll('.beads-filter-btn.active').forEach(btn => activeFilters.add(btn.dataset.filter));

  const rows = paneEl.querySelectorAll('.beads-table-body tr.beads-row');
  rows.forEach(row => {
    const status = row.dataset.status;
    const isBlocked = row.dataset.blocked === 'true';
    const searchText = (row.dataset.searchText || '').toLowerCase();

    const passesSearch = !query || searchText.includes(query);
    let passesFilter;
    if (isBlocked) {
      passesFilter = activeFilters.has('blocked');
    } else if (status === 'closed') {
      passesFilter = false;
    } else {
      passesFilter = activeFilters.has(status);
    }

    const visible = passesSearch && passesFilter;
    row.style.display = visible ? '' : 'none';
    // Also hide/show the detail row that follows
    const detailRow = row.nextElementSibling;
    if (detailRow && detailRow.classList.contains('beads-detail-row')) {
      if (!visible) {
        detailRow.style.display = 'none';
        detailRow.classList.remove('expanded');
      } else {
        detailRow.style.display = '';
      }
    }
  });
}

