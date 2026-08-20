// ─── Editors & Terminal Input ─────────────────────────────────────────────
// Event wiring for the three editable pane types — notes (with images and
// the text-only toggle), files, and terminals.
//
// initTerminal is the bulk of it: xterm construction, fit/resize, input
// forwarding, paste and clipboard handling, link detection, and the mouse
// reporting tmux needs.
//
// terminalMouseDown is the only app.js state written here; everything else
// is read through the context or mutated in place.

import { Terminal } from './lib/xterm.mjs';
import { FitAddon } from './lib/addon-fit.mjs';
import { WebLinksAddon } from './lib/addon-web-links.mjs';
import { getTerminalFontFamily } from './utils.js';
import { getCurrentTerminalFont } from './settings.js';
import { agentRequest, sendWs } from './ws-transport.js';
import { fitsInRelay, jsonByteLength, formatBytes, RELAY_BUDGET_BYTES } from './payload-budget.js';

const TERMINAL_THEMES = window.TERMINAL_THEMES || {};

let _ctx = null;

export function initEditorsDeps(ctx) { _ctx = ctx; }

// ============================================================================

// Setup click handlers for image buttons (copy + remove) in a note pane
export function setupImageButtonHandlers(paneEl, paneData) {
  // Copy buttons
  paneEl.querySelectorAll('.note-image-copy').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.imgIdx, 10);
      if (isNaN(idx) || !paneData.images || !paneData.images[idx]) return;
      const dataUrl = paneData.images[idx];
      // Convert data URL to blob and copy to clipboard
      fetch(dataUrl).then(r => r.blob()).then(blob => {
        const item = new ClipboardItem({ [blob.type]: blob });
        navigator.clipboard.write([item]).then(() => {
          btn.textContent = '✓';
          setTimeout(() => { btn.textContent = '⧉'; }, 1000);
        }).catch(() => {
          btn.textContent = '✗';
          setTimeout(() => { btn.textContent = '⧉'; }, 1000);
        });
      });
    });
  });

  // Download buttons
  paneEl.querySelectorAll('.note-image-download').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.imgIdx, 10);
      if (isNaN(idx) || !paneData.images || !paneData.images[idx]) return;
      const dataUrl = paneData.images[idx];
      const ext = dataUrl.match(/^data:image\/(\w+)/)?.[1] || 'png';
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `note-image-${idx + 1}.${ext}`;
      a.click();
    });
  });

  // Remove buttons
  paneEl.querySelectorAll('.note-image-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.imgIdx, 10);
      if (isNaN(idx) || !paneData.images) return;
      paneData.images.splice(idx, 1);
      // Re-render the images area
      const container = paneEl.querySelector('.note-container');
      const imagesDiv = container.querySelector('.note-images');
      if (imagesDiv) {
        if (paneData.images.length === 0) {
          imagesDiv.remove();
        } else {
          imagesDiv.innerHTML = paneData.images.map((src, i) =>
            `<div class="note-image-wrapper" data-img-idx="${i}">
              <img src="${src}" class="note-image" draggable="false" />
              <button class="note-image-copy" data-tooltip="Copy image" data-img-idx="${i}">⧉</button>
              <button class="note-image-download" data-tooltip="Download image" data-img-idx="${i}"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 1v5M3 4.5L5 7l2-2.5"/><path d="M1 8.5h8"/></svg></button>
              <button class="note-image-remove" data-tooltip="Remove image" data-img-idx="${i}">&times;</button>
            </div>`
          ).join('');
          setupImageButtonHandlers(paneEl, paneData);
        }
      }
      // Save
      agentRequest('PATCH', `/api/notes/${paneData.id}`, { images: paneData.images }, paneData.agentId)
        .catch(e => console.error('Failed to save note images:', e));
      _ctx.cloudSaveNote(paneData.id, paneData.content, paneData.fontSize, paneData.images);
    });
  });
}

// Setup text-only mode toggle for note panes (markdown preview)
export function setupTextOnlyToggle(paneEl, paneData) {
  const eyeBtn = paneEl.querySelector('.note-text-only-btn');
  const mountEl = paneEl.querySelector('.note-editor-mount');
  const previewEl = paneEl.querySelector('.note-markdown-preview');

  async function enterTextOnly() {
    paneEl.classList.add('text-only');
    paneData.textOnly = true;

    // Sync content from Monaco before switching
    const noteInfo = _ctx.noteEditors.get(paneData.id);
    if (noteInfo?.monacoEditor) {
      paneData.content = noteInfo.monacoEditor.getValue();
    }

    // Hide Monaco, show rendered preview
    mountEl.style.display = 'none';
    previewEl.style.display = 'block';
    previewEl.innerHTML = await _ctx.renderMarkdownPreview(paneData.content);
    const baseFontSize = paneData.fontSize || 14;
    const scale = (paneData.zoomLevel || 100) / 100;
    previewEl.style.fontSize = `${Math.round(baseFontSize * scale)}px`;

    _ctx.cloudSaveLayout(paneData);

    // Add floating exit button
    let exitBtn = paneEl.querySelector('.text-only-exit');
    if (!exitBtn) {
      exitBtn = document.createElement('button');
      exitBtn.className = 'text-only-exit';
      exitBtn.innerHTML = '\u{1F441}';
      exitBtn.setAttribute('data-tooltip', 'Back to edit mode');
      exitBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        exitTextOnly();
      });
      paneEl.appendChild(exitBtn);
    }
  }

  function exitTextOnly() {
    paneEl.classList.remove('text-only');
    paneData.textOnly = false;

    // Show Monaco, hide preview
    mountEl.style.display = '';
    previewEl.style.display = 'none';

    const noteInfo = _ctx.noteEditors.get(paneData.id);
    if (noteInfo?.monacoEditor) {
      noteInfo.monacoEditor.layout();
      noteInfo.monacoEditor.focus();
    }

    _ctx.cloudSaveLayout(paneData);

    const exitBtn = paneEl.querySelector('.text-only-exit');
    if (exitBtn) exitBtn.remove();
  }

  // Eye button → toggle text-only
  eyeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (paneEl.classList.contains('text-only')) {
      exitTextOnly();
    } else {
      enterTextOnly();
    }
  });

  // Restore text-only mode if previously persisted
  if (paneData.textOnly) {
    paneEl.classList.add('text-only');
    mountEl.style.display = 'none';
    previewEl.style.display = 'block';
    _ctx.renderMarkdownPreview(paneData.content).then(html => { previewEl.innerHTML = html; });
    const baseFontSize = paneData.fontSize || 14;
    const scale = (paneData.zoomLevel || 100) / 100;
    previewEl.style.fontSize = `${Math.round(baseFontSize * scale)}px`;

    let exitBtn = paneEl.querySelector('.text-only-exit');
    if (!exitBtn) {
      exitBtn = document.createElement('button');
      exitBtn.className = 'text-only-exit';
      exitBtn.innerHTML = '\u{1F441}';
      exitBtn.setAttribute('data-tooltip', 'Back to edit mode');
      exitBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        exitTextOnly();
      });
      paneEl.appendChild(exitBtn);
    }
  }
}

// Setup file editor event listeners
export function setupFileEditorListeners(paneEl, paneData) {
  const editorInfo = _ctx.fileEditors.get(paneData.id);
  const monacoEditor = editorInfo?.monacoEditor;
  if (!monacoEditor) return;

  const saveBtn = paneEl.querySelector('.save-btn');
  const discardBtn = paneEl.querySelector('.discard-btn');
  const reloadBtn = paneEl.querySelector('.reload-btn');
  const statusEl = paneEl.querySelector('.file-status');

  // Mention button
  const mentionBtn = paneEl.querySelector('.pane-mention-btn');
  if (mentionBtn) {
    mentionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _ctx.enterMentionMode({
        type: 'file',
        text: paneData.filePath || paneData.fileName || 'untitled',
        sourceAgentId: paneData.agentId
      });
    });
  }

  // Track changes via Monaco's content change event
  monacoEditor.onDidChangeModelContent(() => {
    if (editorInfo) {
      const hasChanges = monacoEditor.getValue() !== editorInfo.originalContent;
      editorInfo.hasChanges = hasChanges;
      saveBtn.classList.toggle('has-changes', hasChanges);
      discardBtn.classList.toggle('has-changes', hasChanges);
      statusEl.textContent = hasChanges ? 'Modified' : '';
    }
  });

  // Save with Ctrl+S / Cmd+S inside editor
  monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    saveBtn.click();
  });

  // Save button
  saveBtn.addEventListener('click', async () => {
    try {
      const content = monacoEditor.getValue();

      // Check if we have a native file handle for direct save
      const fileHandle = _ctx.fileHandles.get(paneData.id);
      if (fileHandle) {
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
      }

      // Also save to server for persistence
      await agentRequest('PATCH', `/api/file-panes/${paneData.id}`, { content }, paneData.agentId);

      // Update state
      paneData.content = content;
      if (editorInfo) {
        editorInfo.originalContent = content;
        editorInfo.hasChanges = false;
      }
      saveBtn.classList.remove('has-changes');
      discardBtn.classList.remove('has-changes');
      statusEl.textContent = 'Saved';
      setTimeout(() => {
        statusEl.textContent = '';
      }, 2000);
    } catch (e) {
      console.error('[App] Failed to save file:', e);
      statusEl.textContent = 'Save failed!';
    }
  });

  // Discard changes button
  discardBtn.addEventListener('click', () => {
    if (editorInfo) {
      monacoEditor.setValue(editorInfo.originalContent);
      editorInfo.hasChanges = false;
      saveBtn.classList.remove('has-changes');
      discardBtn.classList.remove('has-changes');
      statusEl.textContent = 'Discarded';
      setTimeout(() => {
        statusEl.textContent = '';
      }, 2000);
    }
  });

  // Reload button
  reloadBtn.addEventListener('click', async () => {
    try {
      const data = await agentRequest('GET', `/api/file-panes/${paneData.id}?refresh=true`, null, paneData.agentId);

      monacoEditor.setValue(data.content || '');
      paneData.content = data.content;
      if (editorInfo) {
        editorInfo.originalContent = data.content || '';
        editorInfo.hasChanges = false;
      }
      saveBtn.classList.remove('has-changes');
      discardBtn.classList.remove('has-changes');
      statusEl.textContent = 'Reloaded';
      setTimeout(() => {
        statusEl.textContent = '';
      }, 2000);
    } catch (e) {
      console.error('[App] Failed to reload file:', e);
      statusEl.textContent = 'Reload failed!';
    }
  });

  // Refresh file content from server
  const refreshedEl = paneEl.querySelector('.file-refreshed');
  let lastRefreshTime = Date.now();

  function updateRefreshedLabel() {
    const seconds = Math.floor((Date.now() - lastRefreshTime) / 1000);
    if (seconds < 60) {
      refreshedEl.textContent = `${seconds}s ago`;
    } else {
      refreshedEl.textContent = `${Math.floor(seconds / 60)}m ago`;
    }
  }

  async function doRefresh() {
    if (!editorInfo || editorInfo.hasChanges) return;

    try {
      const data = await agentRequest('GET', `/api/file-panes/${paneData.id}?refresh=true`, null, paneData.agentId);

      lastRefreshTime = Date.now();
      updateRefreshedLabel();

      // Only update if content changed and user hasn't modified
      if (data.content !== editorInfo.originalContent && !editorInfo.hasChanges) {
        monacoEditor.setValue(data.content || '');
        paneData.content = data.content;
        editorInfo.originalContent = data.content || '';
      }
    } catch (e) {
      // Silently ignore refresh errors
    }
  }

  // Refresh every 1s if pane is focused, every 30s otherwise
  let refreshInterval = setInterval(doRefresh, 30000);
  const labelInterval = setInterval(updateRefreshedLabel, 1000);

  function setRefreshRate(focused) {
    clearInterval(refreshInterval);
    refreshInterval = setInterval(doRefresh, focused ? 1000 : 30000);
    if (focused) doRefresh();
  }

  monacoEditor.onDidFocusEditorText(() => setRefreshRate(true));
  monacoEditor.onDidBlurEditorText(() => setRefreshRate(false));

  // Store intervals for cleanup
  if (editorInfo) {
    editorInfo.refreshInterval = refreshInterval;
    editorInfo.labelInterval = labelInterval;
    editorInfo._setRefreshRate = setRefreshRate;
  }
}

// The mouseup that ends a terminal drag-selection can land anywhere, so the
// listener has to be on window rather than the pane. It only clears a single
// global flag and captures nothing per-terminal, so one listener serves every
// terminal. Registering it inside initTerminal instead left one handler per
// terminal ever opened — never removed, since deletePane disposes the xterm
// but cannot reach an anonymous window listener — making every mouse release
// do work proportional to the number of terminals opened this session.
let terminalMouseUpListenerAttached = false;

function ensureTerminalMouseUpListener() {
  if (terminalMouseUpListenerAttached) return;
  terminalMouseUpListenerAttached = true;
  window.addEventListener('mouseup', () => {
    if (_ctx.getTerminalMouseDown()) console.log(`[DBG-MOUSE] mouseup → terminalMouseDown=false`);
    _ctx.setTerminalMouseDown(false);
  }, true);
}

// Initialize xterm.js for a pane
export function initTerminal(paneEl, paneData) {
  const container = paneEl.querySelector('.terminal-container');

  const xterm = new Terminal({
    allowTransparency: true,
    theme: { ...TERMINAL_THEMES[_ctx.getCurrentTerminalTheme()] },
    fontFamily: getTerminalFontFamily(getCurrentTerminalFont()),
    fontSize: 13,
    cursorBlink: true,
    cursorStyle: 'block',
    // xterm keeps every scrollback line resident as cell data and never shrinks
    // the buffer, so this is a per-terminal memory ceiling, not an average.
    // Measured against this xterm build at 200 cols: 50000 cost ~45 MB per
    // fully-scrolled terminal versus ~2 MB at the 1000-line default. tmux holds
    // the real history server-side, so a shorter in-browser buffer loses
    // nothing that capture-pane cannot recover.
    scrollback: 5000,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);

  const webLinksAddon = new WebLinksAddon();
  xterm.loadAddon(webLinksAddon);

  xterm.open(container);

  // xterm v6 sets inline background-color on its scrollable element via JS,
  // overriding our transparent theme. Force all direct children transparent.
  container.querySelectorAll('.xterm > div').forEach(el => {
    el.style.backgroundColor = 'transparent';
  });

  // Block middle-click paste on xterm's hidden textarea (Linux X11 primary selection)
  // Only preventDefault — no stopPropagation so middle-mouse panning still works
  const xtermTextarea = container.querySelector('.xterm-helper-textarea');
  if (xtermTextarea) {
    xtermTextarea.addEventListener('mouseup', (e) => {
      if (e.button === 1) e.preventDefault();
    }, true);
  }

  // --- Clipboard support for terminal panes ---
  // xterm.js renders to a <canvas>, so native browser copy doesn't work.
  // Copy: right-click with text selected.
  // Paste: xterm handles natively — its hidden textarea receives paste events,
  // which fire onData and send through WebSocket.

  // --- Drag-and-drop image support ---
  // xterm's paste path only ever forwards text/plain (bracketed-paste
  // wraps whatever getData('text/plain') returns), so image bytes can't
  // ride through a synthesized paste event — Chrome also won't let a
  // script-constructed ClipboardEvent carry real clipboardData anyway.
  // Instead we ship the raw bytes to the agent over the existing
  // websocket; the agent writes a temp file and types its path, which
  // Claude Code's own path auto-detection picks up as an image — the
  // same mechanism a real OS-level drag-drop onto a native terminal uses.
  if (xtermTextarea) {
    let dragDepth = 0;

    const isFileDrag = (e) =>
      e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

    container.addEventListener('dragenter', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth++;
      paneEl.classList.add('terminal-drop-target');
    });

    container.addEventListener('dragover', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    container.addEventListener('dragleave', (e) => {
      if (!isFileDrag(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) paneEl.classList.remove('terminal-drop-target');
    });

    container.addEventListener('drop', async (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth = 0;
      paneEl.classList.remove('terminal-drop-target');

      const imageFiles = Array.from(e.dataTransfer.files || [])
        .filter(f => f.type.startsWith('image/'));
      if (imageFiles.length === 0) return;

      for (const file of imageFiles) {
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1] || '');
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        }).catch(() => null);
        if (!base64) continue;

        // sendWs refuses an oversized message rather than letting it close the
        // relay, but a silent refusal looks like a dropped image. Check first
        // so there is something to say.
        const payload = { terminalId: paneData.id, imageData: base64, mimeType: file.type };
        if (!fitsInRelay(payload)) {
          alert(`"${file.name}" is ${formatBytes(jsonByteLength(payload))}, over the `
            + `${formatBytes(RELAY_BUDGET_BYTES)} limit for pasting into a terminal. `
            + 'Upload it to a folder pane instead.');
          continue;
        }

        sendWs('terminal:pasteImage', payload, paneData.agentId);

        // Space each drop apart so the agent's temp-file writes and the
        // typed paths land in the pty in a sane order for multi-image drops.
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    });
  }

  // Track last selection — right-click clears xterm selection before contextmenu fires
  let lastTerminalSelection = '';
  xterm.onSelectionChange(() => {
    const sel = xterm.getSelection();
    if (sel && sel.length > 0) lastTerminalSelection = sel;
  });

  // Pause terminal output writes while mouse is held down so that
  // xterm.js selection can start without being destroyed by incoming
  // tmux redraws (especially in scroll/copy-mode).
  container.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
      _ctx.setTerminalMouseDown(true);
      console.log(`[DBG-MOUSE] mousedown on ${paneData.id.slice(0,8)} → _ctx.setTerminalMouseDown(true)`);
    }
  }, true); // capture phase — must fire before zoom interceptor's stopImmediatePropagation
  ensureTerminalMouseUpListener();

  // Right-click on terminal: copy last selected text, always suppress context menu
  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (lastTerminalSelection && lastTerminalSelection.length > 0) {
      // execCommand fallback works on HTTP; clipboard API for HTTPS
      const textarea = document.createElement('textarea');
      textarea.value = lastTerminalSelection;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(lastTerminalSelection).catch(() => {});
      }
      lastTerminalSelection = '';
      xterm.clearSelection();
    }
  });

  // Fix mouse coordinate offset caused by CSS transforms/zoom.
  // Canvas transform: scale() does NOT affect offsetWidth, so xterm's cell
  // measurements are in unscaled CSS pixels while mouse coords are in scaled
  // viewport pixels. Pane CSS zoom has the same effect — getBoundingClientRect()
  // of xterm's children is scaled but their offsetWidth is not.
  // We correct by dividing by the combined scale (canvas zoom * pane zoom).
  const ZOOM_ADJUSTED = '__zoomAdjusted';
  ['mousemove', 'mousedown', 'mouseup', 'click', 'dblclick'].forEach(evType => {
    container.addEventListener(evType, (e) => {
      const paneZoom = parseFloat(container.style.zoom) || 1;
      const totalZoom = _ctx.state.zoom * paneZoom;
      if (e[ZOOM_ADJUSTED] || Math.abs(totalZoom - 1) < 0.001 || _ctx.getExpandedPaneId() || _ctx.getIsResizing() || _ctx.getIsDragging()) return;
      // Don't intercept right-click — let contextmenu event fire for copy
      if (e.button === 2) return;

      const rect = container.getBoundingClientRect();
      const adjustedX = rect.left + (e.clientX - rect.left) / totalZoom;
      const adjustedY = rect.top + (e.clientY - rect.top) / totalZoom;

      e.stopImmediatePropagation();
      e.preventDefault();

      const corrected = new MouseEvent(evType, {
        clientX: adjustedX,
        clientY: adjustedY,
        screenX: e.screenX + (adjustedX - e.clientX),
        screenY: e.screenY + (adjustedY - e.clientY),
        button: e.button,
        buttons: e.buttons,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        detail: e.detail,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(corrected, ZOOM_ADJUSTED, { value: true });
      e.target.dispatchEvent(corrected);
    }, true); // capture phase
  });

  // Ctrl+scroll = canvas zoom. Normal scroll = xterm buffer scroll.
  // When a TUI app (opencode, vim, htop, etc.) enables mouse reporting,
  // re-dispatch the wheel event on xterm's viewport so xterm.js sends
  // mouse escape sequences to the running application.
  // When a TUI app is in alternate screen (reported by tmux via claude:states),
  // send arrow keys so the app receives scroll as navigation.
  const XTERM_WHEEL = Symbol('xterm-wheel');
  container.addEventListener('wheel', (e) => {
    // Skip re-dispatched events from ourselves
    if (e[XTERM_WHEEL]) return;

    // Tab+Scroll: let it bubble to canvas for panning
    if (_ctx.getTabHeld()) return;

    e.preventDefault();
    e.stopPropagation();

    if (e.ctrlKey) {
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      _ctx.setZoom(_ctx.state.zoom * delta, e.clientX, e.clientY);
      return;
    }

    // TUI app has mouse reporting enabled (htop, opencode, vim with mouse=a)
    // — re-dispatch to xterm's element so it sends mouse sequences to the app
    if (xterm._core?.coreMouseService?.areMouseEventsActive) {
      const xtermEl = container.querySelector('.xterm-screen');
      if (xtermEl) {
        const clone = new WheelEvent('wheel', e);
        Object.defineProperty(clone, XTERM_WHEEL, { value: true });
        xtermEl.dispatchEvent(clone);
      }
      return;
    }

    const lines = e.deltaMode === 1
      ? Math.round(e.deltaY * 1.125)
      : Math.round(e.deltaY / 33) || (e.deltaY > 0 ? 1 : -1);

    // TUI app in alternate screen (tmux reports this via claude:states polling)
    // — send arrow keys so the app scrolls its content
    const termRef = _ctx.terminals.get(paneData.id);
    if (termRef?._alternateOn) {
      const count = Math.abs(lines);
      const arrow = e.deltaY > 0 ? '\x1b[B' : '\x1b[A';
      if (termRef._attached) {
        const seq = arrow.repeat(count);
        const encoded = btoa(unescape(encodeURIComponent(seq)));
        sendWs('terminal:input', { terminalId: paneData.id, data: encoded }, paneData.agentId);
      }
      return;
    }

    // Normal shell — scroll through xterm's buffer
    xterm.scrollLines(lines);
  }, { passive: false, capture: true });

  // Store terminal info first
  _ctx.terminals.set(paneData.id, { xterm, fitAddon });

  // Handle terminal input — send immediately for lowest latency.
  xterm.onData((data) => {
    // Don't forward ANY input until terminal:attached is received.
    // During the ttyd/tmux handshake the pty is still in cooked mode
    // (echo ON), so any xterm auto-responses (DA, CPR, etc.) would be
    // echoed back as visible garbage. The user can't type during this
    // window anyway (loading overlay is showing).
    const termRef = _ctx.terminals.get(paneData.id);
    if (!termRef || !termRef._attached) return;
    const encoded = btoa(unescape(encodeURIComponent(data)));
    // Broadcast mode: send to all selected terminal panes
    if (_ctx.selectedPaneIds.size > 1) {
      for (const selectedId of _ctx.selectedPaneIds) {
        const p = _ctx.state.panes.find(x => x.id === selectedId);
        if (p && p.type === 'terminal') {
          sendWs('terminal:input', { terminalId: selectedId, data: encoded }, _ctx.getPaneAgentId(selectedId));
        }
      }
    } else {
      sendWs('terminal:input', { terminalId: paneData.id, data: encoded }, paneData.agentId);
    }
  });

  // Handle terminal resize — send to server and track last-sent size
  // for desync detection. No debounce: we always want the server to
  // know xterm's actual dimensions immediately after a fit().
  let lastSentCols = 0, lastSentRows = 0;
  let resizeTimeout = null;
  xterm.onResize(({ cols, rows }) => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      lastSentCols = cols;
      lastSentRows = rows;
      sendWs('terminal:resize', { terminalId: paneData.id, cols, rows }, paneData.agentId);
    }, 100);
  });

  // Guard flag: prevent ResizeObserver from re-triggering fit() when
  // fit() itself changes the terminal element size.
  let fitting = false;

  function safeFit() {
    if (fitting) return;
    fitting = true;
    try {
      fitAddon.fit();
    } catch (e) {
      // Ignore fit errors
    } finally {
      // Release guard after a microtask so the ResizeObserver callback
      // (which fires asynchronously) still sees fitting=true.
      Promise.resolve().then(() => { fitting = false; });
    }
  }

  // After any fit, make sure the server knows the final size.
  // This catches cases where rapid fits cancel each other's debounced
  // onResize, leaving tmux with a stale row/col count.
  function safeFitAndSync() {
    safeFit();
    // Schedule a sync after the debounce window settles
    scheduleSizeSync();
  }

  let syncTimeout = null;
  function scheduleSizeSync() {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
      const cols = xterm.cols, rows = xterm.rows;
      if (cols !== lastSentCols || rows !== lastSentRows) {
        lastSentCols = cols;
        lastSentRows = rows;
        sendWs('terminal:resize', { terminalId: paneData.id, cols, rows }, paneData.agentId);
      }
    }, 250); // after the 100ms onResize debounce settles
  }

  // Expose safeFitAndSync on termInfo so external code (expand, zoom,
  // manual resize) can use the guarded fit instead of raw fitAddon.fit()
  _ctx.terminals.get(paneData.id).safeFitAndSync = safeFitAndSync;

  // Fit after container is ready, then attach
  setTimeout(() => {
    try {
      safeFit();
      // Now attach terminal after fit
      const pane = _ctx.state.panes.find(p => p.id === paneData.id);
      if (pane) {
        _ctx.attachTerminal(pane);
      }
    } catch (e) {
      console.error('[App] Fit error:', e);
    }
  }, 100);

  // Second fit after container layout fully settles — fixes race
  // where initial fit calculates wrong row count, leaving the
  // bottom 100-200px of the terminal unreachable.
  setTimeout(() => {
    safeFitAndSync();
  }, 2000);

  // Setup debounced resize observer — guarded against fit() feedback
  let observerTimeout = null;
  const resizeObserver = new ResizeObserver(() => {
    if (fitting) return; // skip: this was triggered by fit() itself
    if (observerTimeout) clearTimeout(observerTimeout);
    observerTimeout = setTimeout(() => {
      safeFitAndSync();
    }, 100);
  });
  resizeObserver.observe(container);

  // Periodic desync recovery: every 10s, if xterm's size doesn't match
  // what we last told the server, re-send the resize and force a full
  // terminal refresh so tmux repaints all rows.
  const desyncInterval = setInterval(() => {
    if (!_ctx.terminals.has(paneData.id)) { clearInterval(desyncInterval); return; }
    const cols = xterm.cols, rows = xterm.rows;
    if (cols !== lastSentCols || rows !== lastSentRows) {
      console.log(`[DESYNC] Terminal ${paneData.id.slice(0,8)}: xterm=${cols}x${rows} server=${lastSentCols}x${lastSentRows} — resyncing`);
      lastSentCols = cols;
      lastSentRows = rows;
      sendWs('terminal:resize', { terminalId: paneData.id, cols, rows }, paneData.agentId);
      // Force xterm to repaint all visible rows
      xterm.refresh(0, rows - 1);
    }
  }, 10000);
}
