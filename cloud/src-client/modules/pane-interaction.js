// ─── Pane Interaction & Layout ────────────────────────────────────────────
// Pointer behaviour for panes: click and focus, header actions, dragging
// with edge snapping, the hold-to-resize gesture, context menus, renaming,
// and broadcast selection.
//
// setupPaneListeners is the bulk of it. The renderers in app.js call into
// this module to wire a freshly built pane; the handlers here call back out
// through the context (expandPane, collapsePane, the iframe overlays), which
// keeps the dependency one-directional and avoids a circular import.
//
// The drag/resize flags travel as one dragState object rather than six
// separate bindings, so this module mutates them in place.

import { escapeHtml, isExternalInputFocused } from './utils.js';
import { CLAUDE_LOGO_SVG, ICON_BEADS } from './constants.js';
import { sendWs } from './ws-transport.js';

// Snapping and gesture tuning. Only this module uses them.
const RESIZE_HOLD_DURATION = 150;
const SNAP_THRESHOLD = 38; // px in canvas space
const SNAP_GAP = 10; // px gap between snapped panes

let _ctx = null;

export function initPaneInteractionDeps(ctx) { _ctx = ctx; }


export function applyPaneZoom(paneData, paneEl) {
  const scale = (paneData.zoomLevel || 100) / 100;
  if (paneData.type === 'terminal') {
    // Use CSS zoom instead of xterm fontSize — changing fontSize corrupts
    // xterm v6's selection rendering (stale cell dimension cache). CSS zoom
    // scales at browser layout level so xterm internals stay consistent.
    const container = paneEl.querySelector('.terminal-container');
    const termInfo = _ctx.terminals.get(paneData.id);
    if (container && termInfo) {
      container.style.zoom = scale === 1 ? '' : scale;
      if (termInfo.safeFitAndSync) termInfo.safeFitAndSync();
      else termInfo.fitAddon.fit();
    }
  } else if (paneData.type === 'file') {
    const edInfo = _ctx.fileEditors.get(paneData.id);
    if (edInfo?.monacoEditor) edInfo.monacoEditor.updateOptions({ fontSize: Math.round(13 * scale) });
  } else if (paneData.type === 'note') {
    const noteInfo = _ctx.noteEditors.get(paneData.id);
    if (noteInfo?.monacoEditor) {
      noteInfo.monacoEditor.updateOptions({ fontSize: Math.round((paneData.fontSize || 14) * scale) });
    }
    const preview = paneEl.querySelector('.note-markdown-preview');
    if (preview) preview.style.fontSize = `${Math.round((paneData.fontSize || 14) * scale)}px`;
  } else if (paneData.type === 'git-graph') {
    const graphContent = paneEl.querySelector('.git-graph-output');
    if (graphContent) graphContent.style.fontSize = `${Math.round(12 * scale)}px`;
  } else if (paneData.type === 'beads') {
    const beadsContainer = paneEl.querySelector('.beads-container');
    if (beadsContainer) beadsContainer.style.zoom = scale === 1 ? '' : scale;
  } else if (paneData.type === 'folder') {
    const treeContainer = paneEl.querySelector('.folder-tree-container');
    if (treeContainer) treeContainer.style.fontSize = `${Math.round(13 * scale)}px`;
  }
}

export function setupPaneListeners(paneEl, paneData) {
  const header = paneEl.querySelector('.pane-header');
  const closeBtn = paneEl.querySelector('.pane-close');
  const expandBtn = paneEl.querySelector('.pane-expand');
  const resizeHandle = paneEl.querySelector('.pane-resize-handle');
  const zoomInBtn = paneEl.querySelector('.zoom-in');
  const zoomOutBtn = paneEl.querySelector('.zoom-out');

  // New tab button
  const newTabBtn = paneEl.querySelector('.pane-new-tab');
  if (newTabBtn) {
    newTabBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _ctx.createTabInGroup(paneData.id);
    });
    newTabBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  // Apply device color to header
  _ctx.applyDeviceHeaderColor(paneEl, paneData.device);

  // Initialize zoom level for this pane
  if (!paneData.zoomLevel) paneData.zoomLevel = 100;
  if (paneData.zoomLevel !== 100) {
    applyPaneZoom(paneData, paneEl);
  }

  const applyZoom = () => applyPaneZoom(paneData, paneEl);

  // Pane name: double-click to edit
  const paneNameEl = paneEl.querySelector('.pane-name');
  if (paneNameEl) {
    paneNameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (paneEl.querySelector('.pane-name-input')) return;

      const input = document.createElement('input');
      input.className = 'pane-name-input';
      input.type = 'text';
      input.value = paneData.paneName || '';
      input.placeholder = 'Name';
      input.maxLength = 50;

      paneNameEl.style.display = 'none';
      header.appendChild(input);
      input.focus();
      input.select();

      const commit = () => {
        const val = input.value.trim();
        paneData.paneName = val || '';
        input.remove();
        paneNameEl.style.display = '';
        if (val) {
          paneNameEl.textContent = val;
          paneNameEl.classList.remove('empty');
        } else {
          paneNameEl.textContent = 'Name';
          paneNameEl.classList.add('empty');
        }
        _ctx.cloudSaveLayout(paneData);
        if (paneData.tabGroupId) _ctx.refreshTabBars(paneData.tabGroupId);
      };

      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
        if (ke.key === 'Escape') {
          input.removeEventListener('blur', commit);
          input.remove();
          paneNameEl.style.display = '';
        }
        ke.stopPropagation();
      });
      // Prevent header drag while typing
      input.addEventListener('mousedown', (me) => me.stopPropagation());
    });
    // Single click should not start drag
    paneNameEl.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  // Shortcut badge click: open assign popup (delegated so it works after badge replacement)
  paneEl.addEventListener('click', (e) => {
    const badge = e.target.closest('.pane-shortcut-badge');
    if (!badge) return;
    e.stopPropagation();
    _ctx.showShortcutAssignPopup(paneData);
  });
  paneEl.addEventListener('mousedown', (e) => {
    if (e.target.closest('.pane-shortcut-badge')) {
      e.stopPropagation();
    }
  });

  if (zoomInBtn) {
    zoomInBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      paneData.zoomLevel = Math.min(500, paneData.zoomLevel + 10);
      applyZoom();
      _ctx.cloudSaveLayout(paneData);
    });
  }

  if (zoomOutBtn) {
    zoomOutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      paneData.zoomLevel = Math.max(20, paneData.zoomLevel - 10);
      applyZoom();
      _ctx.cloudSaveLayout(paneData);
    });
  }

  // Refresh history button (terminal panes only) — re-runs the full
  // attach cycle: clears xterm, resets flags, sends terminal:attach.
  // The agent re-captures tmux history, sends it, then force-redraws.
  // This is equivalent to what happens on a page reload.
  const refreshHistoryBtn = paneEl.querySelector('.term-refresh-history');
  if (refreshHistoryBtn) {
    refreshHistoryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _ctx.reattachTerminal(paneData);
    });
  }

  // Beads tag removal via X button
  paneEl.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.beads-tag-remove');
    if (!removeBtn) return;
    e.stopPropagation();
    const badge = removeBtn.closest('.beads-tag-badge');
    if (badge) {
      paneData.beadsTag = undefined;
      badge.remove();
      _ctx.cloudSaveLayout(paneData);
    }
  });

  // Pane header hover — show overlay with beads + Claude session info
  if (header) {
    header.addEventListener('mouseenter', () => {
      if (paneEl.querySelector('.pane-hover-overlay')) return;
      const hasBeads = !!paneData.beadsTag;
      const hasSession = !!paneData.claudeSessionId;
      if (!hasBeads && !hasSession) return;

      const overlay = document.createElement('div');
      overlay.className = 'pane-hover-overlay';
      let html = '';

      // Claude session card (above beads)
      if (hasSession) {
        const nameText = paneData.claudeSessionName ? escapeHtml(paneData.claudeSessionName.slice(0, 50)) : '';
        html += `<div class="claude-session-card">
          <div class="claude-session-card-id">${CLAUDE_LOGO_SVG.replace('class="claude-logo"', 'class="claude-session-card-logo"')}${escapeHtml(paneData.claudeSessionId)}</div>
          ${nameText ? `<div class="claude-session-card-name">${nameText}</div>` : ''}
        </div>`;
      }

      // Beads card
      if (hasBeads) {
        html += `<div class="beads-hover-card">
          <div class="beads-hover-id"><svg viewBox="0 0 24 24" width="14" height="14">${ICON_BEADS}</svg>${escapeHtml(paneData.beadsTag.id)}</div>
          <div class="beads-hover-title">${escapeHtml((paneData.beadsTag.title || '').slice(0, 100))}</div>
        </div>`;
      }

      overlay.innerHTML = html;
      paneEl.appendChild(overlay);
    });

    header.addEventListener('mouseleave', () => {
      const overlay = paneEl.querySelector('.pane-hover-overlay');
      if (overlay) overlay.remove();
    });
  }

  // Beads tag icon button — add or edit beads issue tag (with autocomplete)
  const beadsBtn = paneEl.querySelector('.beads-tag-btn');
  if (beadsBtn) {
    beadsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (paneEl.querySelector('.beads-tag-input')) return;

      const input = document.createElement('input');
      input.className = 'beads-tag-input';
      input.type = 'text';
      input.value = paneData.beadsTag?.id || '';
      input.placeholder = 'search issues...';
      input.maxLength = 80;

      const titleEl = paneEl.querySelector('.pane-title');
      const terminalSpan = titleEl.querySelector('span[style*="opacity"]') || titleEl.querySelector('.claude-header');
      if (terminalSpan) {
        titleEl.insertBefore(input, terminalSpan);
      } else {
        titleEl.appendChild(input);
      }

      // Autocomplete dropdown
      const dropdown = document.createElement('div');
      dropdown.className = 'beads-autocomplete';
      paneEl.appendChild(dropdown);

      let allIssues = [];
      let highlightIdx = -1;
      let selectedIssue = null;

      // Fetch issues for autocomplete
      _ctx.cloudFetch('GET', '/api/beads/issues').then(issues => {
        allIssues = issues || [];
        renderDropdown();
      }).catch(() => {});

      function renderDropdown() {
        const query = input.value.trim().toLowerCase();
        const filtered = query
          ? allIssues.filter(i => i.id.toLowerCase().includes(query) || (i.title || '').toLowerCase().includes(query))
          : allIssues;
        if (filtered.length === 0) {
          dropdown.innerHTML = '<div class="beads-autocomplete-empty">No matching issues</div>';
          highlightIdx = -1;
          return;
        }
        highlightIdx = Math.min(highlightIdx, filtered.length - 1);
        dropdown.innerHTML = filtered.map((issue, idx) => {
          const shortId = issue.id.replace(/^.*-/, '');
          const blocked = issue.dependency_count > 0;
          const statusIcon = blocked ? '\uD83D\uDD12' : issue.status === 'in_progress' ? '\u25D0' : '\u25CB';
          const statusClass = blocked ? 'beads-status-blocked' : issue.status === 'in_progress' ? 'beads-status-progress' : 'beads-status-open';
          const active = idx === highlightIdx ? ' beads-autocomplete-active' : '';
          return `<div class="beads-autocomplete-row${active}" data-idx="${idx}" data-issue-id="${escapeHtml(issue.id)}"><span class="beads-tag-status ${statusClass}">${statusIcon}</span><span class="beads-ac-id">${escapeHtml(shortId)}</span><span class="beads-ac-title">${escapeHtml((issue.title || '').slice(0, 50))}</span></div>`;
        }).join('');
        // Scroll active into view
        const activeEl = dropdown.querySelector('.beads-autocomplete-active');
        if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
      }

      function selectIssue(issue) {
        selectedIssue = issue;
        input.value = issue.id;
        commitBeadsTag();
      }

      dropdown.addEventListener('mousedown', (ev) => {
        ev.preventDefault(); // Prevent blur
        const row = ev.target.closest('.beads-autocomplete-row');
        if (row) {
          const issueId = row.dataset.issueId;
          const issue = allIssues.find(i => i.id === issueId);
          if (issue) selectIssue(issue);
        }
      });

      input.addEventListener('input', () => {
        highlightIdx = -1;
        selectedIssue = null;
        renderDropdown();
      });

      input.focus();
      input.select();

      function commitBeadsTag() {
        const val = input.value.trim();
        input.remove();
        dropdown.remove();
        const oldId = paneData.beadsTag?.id || '';
        if (val !== oldId) {
          if (val) {
            if (selectedIssue) {
              const blocked = selectedIssue.dependency_count > 0 && selectedIssue.status !== 'closed';
              paneData.beadsTag = { id: selectedIssue.id, title: selectedIssue.title || '', status: selectedIssue.status, blocked };
            } else {
              paneData.beadsTag = { id: val, title: '' };
            }
          } else {
            paneData.beadsTag = undefined;
          }
          const existing = titleEl.querySelector('.beads-tag-badge');
          if (existing) existing.remove();
          if (val) {
            const temp = document.createElement('span');
            temp.innerHTML = _ctx.beadsTagHtml(paneData.beadsTag);
            const badge = temp.firstChild;
            const insertBefore = titleEl.querySelector('span[style*="opacity"]') || titleEl.querySelector('.claude-header');
            if (insertBefore) titleEl.insertBefore(badge, insertBefore);
            else titleEl.appendChild(badge);
            if (!selectedIssue) _ctx.refreshBeadsTagStatus(paneData);
          }
          _ctx.cloudSaveLayout(paneData);
        }
      }

      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        const rows = dropdown.querySelectorAll('.beads-autocomplete-row');
        if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          highlightIdx = Math.min(highlightIdx + 1, rows.length - 1);
          renderDropdown();
        } else if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          highlightIdx = Math.max(highlightIdx - 1, 0);
          renderDropdown();
        } else if (ev.key === 'Enter') {
          if (highlightIdx >= 0 && rows[highlightIdx]) {
            const issueId = rows[highlightIdx].dataset.issueId;
            const issue = allIssues.find(i => i.id === issueId);
            if (issue) { selectIssue(issue); return; }
          }
          commitBeadsTag();
        } else if (ev.key === 'Escape') {
          input.remove();
          dropdown.remove();
        }
      });

      input.addEventListener('blur', () => {
        setTimeout(() => {
          if (input.parentElement) commitBeadsTag();
        }, 150);
      });
    });
  }

  // Use capture phase to intercept events before xterm.js handles them
  // This ensures focus works even when clicking inside the terminal
  paneEl.addEventListener('mousedown', (e) => {

    // In Quick View or device hover, the overlay handles all interactions — don't intercept
    if (_ctx.getQuickViewActive() || _ctx.getDeviceHoverActive()) return;
    // Don't steal focus from HUD inputs or other external interactive elements
    if (isExternalInputFocused()) return;
    if (_ctx.getMoveModeActive()) return;
    // Ctrl+Shift+Click: toggle fullscreen
    if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (_ctx.getExpandedPaneId() === paneData.id) {
        _ctx.collapsePane();
      } else {
        _ctx.expandPane(paneData.id);
      }
      return;
    }
    // Shift+Click: toggle broadcast selection (any pane type)
    if (e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      _ctx.togglePaneSelection(paneData.id);
      _ctx.updateBroadcastIndicator();
      if (_ctx.selectedPaneIds.has(paneData.id)) {
        _ctx.focusPane(paneData);
        _ctx.focusTerminalInput(paneData.id);
      }
      return;
    }
    // Normal click on a broadcast-selected pane: keep selection, just focus
    if (_ctx.selectedPaneIds.has(paneData.id)) {
      _ctx.focusPane(paneData);
      _ctx.focusTerminalInput(paneData.id);
      return;
    }
    // Normal click outside broadcast group: clear selection
    if (_ctx.selectedPaneIds.size > 0) {
      _ctx.clearMultiSelect();
    }
    _ctx.focusPane(paneData);
    _ctx.focusTerminalInput(paneData.id);
  }, true); // capture phase

  // Track touch start position for tap-vs-drag detection
  let _touchStartX = 0;
  let _touchStartY = 0;
  let _touchStartTime = 0;

  paneEl.addEventListener('touchstart', (e) => {
    if (e.touches && e.touches.length === 1) {
      _touchStartX = e.touches[0].clientX;
      _touchStartY = e.touches[0].clientY;
      _touchStartTime = Date.now();
    }
    _ctx.focusPane(paneData);
    _ctx.focusTerminalInput(paneData.id);
  }, { passive: true, capture: true });

  // Auto-fullscreen panes on phone tap (all pane types)
  paneEl.addEventListener('touchend', (e) => {
    if (window.innerWidth > 768) return;
    if (_ctx.getExpandedPaneId()) return;
    if (_ctx.getQuickViewActive() || _ctx.getDeviceHoverActive()) return;
    const touch = e.changedTouches && e.changedTouches[0];
    if (!touch) return;
    const dx = Math.abs(touch.clientX - _touchStartX);
    const dy = Math.abs(touch.clientY - _touchStartY);
    const elapsed = Date.now() - _touchStartTime;
    if (dx < 15 && dy < 15 && elapsed < 400) {
      _ctx.expandPane(paneData.id);
    }
  }, { passive: true });

  // Focus pane and terminal input on hover
  paneEl.addEventListener('mouseenter', () => {
    // In Quick View or device hover: no focus, no overlay removal — just a hover hint
    if (_ctx.getQuickViewActive() || _ctx.getDeviceHoverActive()) {
      paneEl.classList.add('qv-hover');
      return;
    }
    if (_ctx.getIsPanning()) return; // middle-mouse panning — skip focus changes
    if (_ctx.getMoveModeActive()) return;
    // Don't steal focus from interactive elements outside panes (e.g. HUD search inputs)
    if (isExternalInputFocused()) return;
    if (_ctx.getFocusMode() !== 'hover') return; // click-to-focus mode: hover doesn't focus
    paneEl.classList.add('focused');
    _ctx.focusPane(paneData);
    _ctx.focusTerminalInput(paneData.id);

    // A note's editor is not focused here. This used to reach for a
    // .note-editor textarea, which no longer exists — notes render Monaco into
    // .note-editor-mount — so the branch never ran. Focusing Monaco instead is
    // a behaviour change in its own right, since it would start capturing
    // keystrokes on every pane focus; tracked separately.
  });

  paneEl.addEventListener('mouseleave', (e) => {
    // In Quick View or device hover: just remove hover hint
    if (_ctx.getQuickViewActive() || _ctx.getDeviceHoverActive()) {
      paneEl.classList.remove('qv-hover');
      return;
    }
    if (_ctx.getMoveModeActive()) return;
    if (_ctx.getFocusMode() !== 'hover') return; // click-to-focus: don't blur on leave
    if (!_ctx.dragState.isDragging && !_ctx.dragState.isResizing && !_ctx.getIsPanning()) {
      const termInfo = _ctx.terminals.get(paneData.id);
      const hasSelection = termInfo && termInfo.xterm && termInfo.xterm.hasSelection();
      const isSelectDrag = (e.buttons & 1) !== 0; // primary button still held

      // Don't blur terminal if the user has selected text or is mid-drag —
      // xterm.blur() clears the canvas selection highlight, which breaks
      // right-click copy. Focus transfers naturally on the next mousedown.
      if (!hasSelection && !isSelectDrag) {
        if (termInfo && termInfo.xterm) termInfo.xterm.blur();

        // Blur any other focused element inside the pane
        if (document.activeElement && paneEl.contains(document.activeElement)) {
          document.activeElement.blur();
        }
      }

      paneEl.classList.remove('focused');
    }
  });

  // Header drag - immediate, no hold needed
  header.addEventListener('mousedown', (e) => {
    if (e.target === closeBtn || e.target.classList.contains('connection-status')) return;
    // Ctrl+Shift+Click on header also triggers fullscreen (handled by capture listener above)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey) return;
    e.stopPropagation();
    startDrag(e, paneEl, paneData);
  });
  header.addEventListener('touchstart', (e) => {
    if (e.target === closeBtn || e.target.classList.contains('connection-status')) return;
    e.stopPropagation();
    startDrag(e, paneEl, paneData);
  }, { passive: false });

  // Close button
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (paneData.tabGroupId) _ctx.closeTabInGroup(paneData.id);
    else _ctx.deletePane(paneData.id);
  });
  closeBtn.addEventListener('touchend', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (paneData.tabGroupId) _ctx.closeTabInGroup(paneData.id);
    else _ctx.deletePane(paneData.id);
  });

  // Expand/Collapse button (only for terminal and file panes, not notes)
  if (expandBtn) {
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_ctx.getExpandedPaneId() === paneData.id) {
        _ctx.collapsePane();
      } else {
        _ctx.expandPane(paneData.id);
      }
    });
    expandBtn.addEventListener('touchend', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (_ctx.getExpandedPaneId() === paneData.id) {
        _ctx.collapsePane();
      } else {
        _ctx.expandPane(paneData.id);
      }
    });
  }

  // Resize handle - short hold then drag
  resizeHandle.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    startResizeHold(e, paneEl, paneData, 'right');
  });
  resizeHandle.addEventListener('touchstart', (e) => {
    e.stopPropagation();
    startResizeHold(e, paneEl, paneData, 'right');
  }, { passive: false });

  // Mirrored bottom-left handle — same gesture, drags the left edge instead
  const resizeHandleLeft = paneEl.querySelector('.pane-resize-handle-left');
  if (resizeHandleLeft) {
    resizeHandleLeft.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      startResizeHold(e, paneEl, paneData, 'left');
    });
    resizeHandleLeft.addEventListener('touchstart', (e) => {
      e.stopPropagation();
      startResizeHold(e, paneEl, paneData, 'left');
    }, { passive: false });
  }
}

// Find closest snap targets for a pane being dragged (independent X and Y)
export function findSnapTargets(draggedPane, draggedX, draggedY, excludeIds) {
  const dRight = draggedX + draggedPane.width;
  const dBottom = draggedY + draggedPane.height;

  let bestX = null;
  let bestDistX = SNAP_THRESHOLD + 1;
  let bestY = null;
  let bestDistY = SNAP_THRESHOLD + 1;

  for (const other of _ctx.state.panes) {
    if (other.id === draggedPane.id) continue;
    if (excludeIds && excludeIds.has(other.id)) continue;
    const el = document.getElementById(`pane-${other.id}`);
    if (!el || el.style.display === 'none') continue;

    const oLeft = other.x;
    const oRight = other.x + other.width;
    const oTop = other.y;
    const oBottom = other.y + other.height;

    // Check vertical overlap (needed for left/right snapping)
    const vOverlap = draggedY < oBottom && dBottom > oTop;
    // Check horizontal overlap (needed for top/bottom snapping)
    const hOverlap = draggedX < oRight && dRight > oLeft;

    // Right edge of dragged -> Left edge of other
    if (vOverlap) {
      const dist = Math.abs(dRight + SNAP_GAP - oLeft);
      if (dist < bestDistX) {
        bestDistX = dist;
        bestX = { adjustX: oLeft - draggedPane.width - SNAP_GAP, edge: oLeft - SNAP_GAP / 2, orientation: 'vertical',
          top: Math.max(draggedY, oTop), bottom: Math.min(dBottom, oBottom), otherId: other.id };
      }
    }

    // Left edge of dragged -> Right edge of other
    if (vOverlap) {
      const dist = Math.abs(draggedX - SNAP_GAP - oRight);
      if (dist < bestDistX) {
        bestDistX = dist;
        bestX = { adjustX: oRight + SNAP_GAP, edge: oRight + SNAP_GAP / 2, orientation: 'vertical',
          top: Math.max(draggedY, oTop), bottom: Math.min(dBottom, oBottom), otherId: other.id };
      }
    }

    // Bottom edge of dragged -> Top edge of other
    if (hOverlap) {
      const dist = Math.abs(dBottom + SNAP_GAP - oTop);
      if (dist < bestDistY) {
        bestDistY = dist;
        bestY = { adjustY: oTop - draggedPane.height - SNAP_GAP, edge: oTop - SNAP_GAP / 2, orientation: 'horizontal',
          left: Math.max(draggedX, oLeft), right: Math.min(dRight, oRight), otherId: other.id };
      }
    }

    // Top edge of dragged -> Bottom edge of other
    if (hOverlap) {
      const dist = Math.abs(draggedY - SNAP_GAP - oBottom);
      if (dist < bestDistY) {
        bestDistY = dist;
        bestY = { adjustY: oBottom + SNAP_GAP, edge: oBottom + SNAP_GAP / 2, orientation: 'horizontal',
          left: Math.max(draggedX, oLeft), right: Math.min(dRight, oRight), otherId: other.id };
      }
    }
  }

  const snapX = bestDistX <= SNAP_THRESHOLD ? bestX : null;
  let snapY = bestDistY <= SNAP_THRESHOLD ? bestY : null;

  // Same-edge alignment: when snapped side-by-side (X), align top/bottom edges
  if (snapX && !snapY) {
    const other = _ctx.state.panes.find(p => p.id === snapX.otherId);
    if (other) {
      const topDist = Math.abs(draggedY - other.y);
      const bottomDist = Math.abs(dBottom - (other.y + other.height));
      if (topDist < SNAP_THRESHOLD && topDist <= bottomDist) {
        snapY = { adjustY: other.y, edge: other.y, orientation: 'horizontal',
          left: Math.min(draggedX, other.x), right: Math.max(dRight, other.x + other.width), otherId: other.id };
      } else if (bottomDist < SNAP_THRESHOLD) {
        snapY = { adjustY: other.y + other.height - draggedPane.height, edge: other.y + other.height, orientation: 'horizontal',
          left: Math.min(draggedX, other.x), right: Math.max(dRight, other.x + other.width), otherId: other.id };
      }
    }
  }

  // Same-edge alignment: when snapped stacked (Y), align left/right edges
  if (snapY && !snapX) {
    const other = _ctx.state.panes.find(p => p.id === snapY.otherId);
    if (other) {
      const leftDist = Math.abs(draggedX - other.x);
      const rightDist = Math.abs(dRight - (other.x + other.width));
      if (leftDist < SNAP_THRESHOLD && leftDist <= rightDist) {
        bestX = { adjustX: other.x, edge: other.x, orientation: 'vertical',
          top: Math.min(draggedY, other.y), bottom: Math.max(dBottom, other.y + other.height), otherId: other.id };
        return { x: bestX, y: snapY };
      } else if (rightDist < SNAP_THRESHOLD) {
        bestX = { adjustX: other.x + other.width - draggedPane.width, edge: other.x + other.width, orientation: 'vertical',
          top: Math.min(draggedY, other.y), bottom: Math.max(dBottom, other.y + other.height), otherId: other.id };
        return { x: bestX, y: snapY };
      }
    }
  }

  return (snapX || snapY) ? { x: snapX, y: snapY } : null;
}

// Find resize snap targets for the resizing pane.
// horizontalEdge picks which side the resize handle moves: 'right' (default,
// pane.x stays put) or 'left' (the pane's right edge stays put and x moves).
// The bottom edge is the one that moves vertically in both cases.
export function findResizeSnapTargets(paneData, newWidth, newHeight, horizontalEdge = 'right', anchoredRight = null) {
  const movingLeft = horizontalEdge === 'left';
  // The edge that stays anchored while the opposite one is dragged. Callers
  // resizing leftward pass it in, since paneData.x/width mutate mid-drag.
  const fixedRight = anchoredRight != null ? anchoredRight : paneData.x + paneData.width;
  const leftEdge = movingLeft ? fixedRight - newWidth : paneData.x;
  const rightEdge = movingLeft ? fixedRight : paneData.x + newWidth;
  const bottomEdge = paneData.y + newHeight;

  let bestW = null, bestDistW = SNAP_THRESHOLD + 1;
  let bestH = null, bestDistH = SNAP_THRESHOLD + 1;

  for (const other of _ctx.state.panes) {
    if (other.id === paneData.id) continue;
    const el = document.getElementById(`pane-${other.id}`);
    if (!el || el.style.display === 'none') continue;

    const oLeft = other.x;
    const oRight = other.x + other.width;
    const oTop = other.y;
    const oBottom = other.y + other.height;

    // Overlap checks with tolerance for adjacent/nearby panes
    const margin = SNAP_GAP + SNAP_THRESHOLD;
    const vOverlap = paneData.y < oBottom + margin && bottomEdge > oTop - margin;
    const hOverlap = leftEdge < oRight + margin && rightEdge > oLeft - margin;

    if (vOverlap && movingLeft) {
      // Left edge -> other's right edge (with gap)
      const distR = Math.abs(leftEdge - SNAP_GAP - oRight);
      if (distR < bestDistW) {
        bestDistW = distR;
        bestW = { snapWidth: fixedRight - oRight - SNAP_GAP, edge: oRight + SNAP_GAP / 2, orientation: 'vertical',
          top: Math.min(paneData.y, oTop), bottom: Math.max(bottomEdge, oBottom) };
      }
      // Left edge -> other's left edge (align)
      const distL = Math.abs(leftEdge - oLeft);
      if (distL < bestDistW) {
        bestDistW = distL;
        bestW = { snapWidth: fixedRight - oLeft, edge: oLeft, orientation: 'vertical',
          top: Math.min(paneData.y, oTop), bottom: Math.max(bottomEdge, oBottom) };
      }
    } else if (vOverlap) {
      // Right edge -> other's left edge (with gap)
      const distL = Math.abs(rightEdge + SNAP_GAP - oLeft);
      if (distL < bestDistW) {
        bestDistW = distL;
        bestW = { snapWidth: oLeft - paneData.x - SNAP_GAP, edge: oLeft - SNAP_GAP / 2, orientation: 'vertical',
          top: Math.min(paneData.y, oTop), bottom: Math.max(bottomEdge, oBottom) };
      }
      // Right edge -> other's right edge (align)
      const distR = Math.abs(rightEdge - oRight);
      if (distR < bestDistW) {
        bestDistW = distR;
        bestW = { snapWidth: oRight - paneData.x, edge: oRight, orientation: 'vertical',
          top: Math.min(paneData.y, oTop), bottom: Math.max(bottomEdge, oBottom) };
      }
    }

    if (hOverlap) {
      // Bottom edge -> other's top edge (with gap)
      const distT = Math.abs(bottomEdge + SNAP_GAP - oTop);
      if (distT < bestDistH) {
        bestDistH = distT;
        bestH = { snapHeight: oTop - paneData.y - SNAP_GAP, edge: oTop - SNAP_GAP / 2, orientation: 'horizontal',
          left: Math.min(leftEdge, oLeft), right: Math.max(rightEdge, oRight) };
      }
      // Bottom edge -> other's bottom edge (align)
      const distB = Math.abs(bottomEdge - oBottom);
      if (distB < bestDistH) {
        bestDistH = distB;
        bestH = { snapHeight: oBottom - paneData.y, edge: oBottom, orientation: 'horizontal',
          left: Math.min(leftEdge, oLeft), right: Math.max(rightEdge, oRight) };
      }
    }
  }

  const snapW = bestDistW <= SNAP_THRESHOLD ? bestW : null;
  const snapH = bestDistH <= SNAP_THRESHOLD ? bestH : null;
  return (snapW || snapH) ? { w: snapW, h: snapH } : null;
}

let snapGuideX = null;
let snapGuideY = null;

export function updateSnapGuide(guide, snap) {
  if (!guide) {
    guide = document.createElement('div');
    guide.style.pointerEvents = 'none';
    _ctx.getCanvas().appendChild(guide);
  }
  guide.className = `snap-guide ${snap.orientation}`;
  if (snap.orientation === 'vertical') {
    guide.style.left = `${snap.edge}px`;
    guide.style.top = `${snap.top}px`;
    guide.style.height = `${snap.bottom - snap.top}px`;
    guide.style.width = '';
  } else {
    guide.style.left = `${snap.left}px`;
    guide.style.top = `${snap.edge}px`;
    guide.style.width = `${snap.right - snap.left}px`;
    guide.style.height = '';
  }
  return guide;
}

export function showSnapGuides(snaps) {
  if (snaps.x) { snapGuideX = updateSnapGuide(snapGuideX, snaps.x); }
  else if (snapGuideX) { snapGuideX.remove(); snapGuideX = null; }
  if (snaps.y) { snapGuideY = updateSnapGuide(snapGuideY, snaps.y); }
  else if (snapGuideY) { snapGuideY.remove(); snapGuideY = null; }
}

export function removeSnapGuides() {
  if (snapGuideX) { snapGuideX.remove(); snapGuideX = null; }
  if (snapGuideY) { snapGuideY.remove(); snapGuideY = null; }
}

// Start dragging immediately (for header)
export function startDrag(e, paneEl, paneData) {
  e.preventDefault();
  _ctx.dragState.isDragging = true;
  _ctx.dragState.activePane = paneEl;
  paneEl.classList.add('dragging');
  document.body.classList.add('no-select');
  _ctx.showIframeOverlays();

  const point = e.touches ? e.touches[0] : e;
  const rect = paneEl.getBoundingClientRect();
  _ctx.dragState.offsetX = (point.clientX - rect.left) / _ctx.state.zoom;
  _ctx.dragState.offsetY = (point.clientY - rect.top) / _ctx.state.zoom;

  if (navigator.vibrate) {
    navigator.vibrate(30);
  }

  // Determine group drag: if this pane is in the selection, drag all selected
  const isGroupDrag = _ctx.selectedPaneIds.size > 1 && _ctx.selectedPaneIds.has(paneData.id);
  let groupPanes = null;

  if (isGroupDrag) {
    groupPanes = [];
    _ctx.selectedPaneIds.forEach(id => {
      const p = _ctx.state.panes.find(x => x.id === id);
      const el = document.getElementById(`pane-${id}`);
      if (p && el) {
        groupPanes.push({ paneData: p, paneEl: el, startX: p.x, startY: p.y });
        el.classList.add('dragging');
      }
    });
  }

  const startX = paneData.x;
  const startY = paneData.y;

  const moveHandler = (moveE) => {
    moveE.preventDefault();
    const movePoint = moveE.touches ? moveE.touches[0] : moveE;
    let newX = (movePoint.clientX - _ctx.state.panX) / _ctx.state.zoom - _ctx.dragState.offsetX;
    let newY = (movePoint.clientY - _ctx.state.panY) / _ctx.state.zoom - _ctx.dragState.offsetY;

    // Snap-to-edge (unless Shift held)
    if (!moveE.shiftKey) {
      const snaps = findSnapTargets(paneData, newX, newY, isGroupDrag ? _ctx.selectedPaneIds : null);
      if (snaps) {
        if (snaps.x) newX = snaps.x.adjustX;
        if (snaps.y) newY = snaps.y.adjustY;
        showSnapGuides(snaps);
      } else {
        removeSnapGuides();
      }
    } else {
      removeSnapGuides();
    }

    paneEl.style.left = `${newX}px`;
    paneEl.style.top = `${newY}px`;
    paneData.x = newX;
    paneData.y = newY;
    _ctx.syncTabGroupGeometry(paneData);

    // Move the rest of the group by the same delta
    if (isGroupDrag) {
      const dx = newX - startX;
      const dy = newY - startY;
      groupPanes.forEach(({ paneData: p, paneEl: el, startX: sx, startY: sy }) => {
        if (p.id === paneData.id) return;
        p.x = sx + dx;
        p.y = sy + dy;
        el.style.left = `${p.x}px`;
        el.style.top = `${p.y}px`;
      });
    }
  };

  const endHandler = () => {
    removeSnapGuides();
    _ctx.dragState.isDragging = false;
    paneEl.classList.remove('dragging');
    document.body.classList.remove('no-select');
    _ctx.dragState.activePane = null;
    _ctx.hideIframeOverlays();

    // Save position to server (use correct endpoint based on pane type)

    if (isGroupDrag) {
      // Remove dragging class and save all group positions (cloud-only)
      groupPanes.forEach(({ paneData: p, paneEl: el }) => {
        el.classList.remove('dragging');
        _ctx.cloudSaveLayout(p);
      });
    } else {
      _ctx.cloudSaveLayout(paneData);
    }

    document.removeEventListener('mousemove', moveHandler);
    document.removeEventListener('touchmove', moveHandler);
    document.removeEventListener('mouseup', endHandler);
    document.removeEventListener('touchend', endHandler);
  };

  document.addEventListener('mousemove', moveHandler);
  document.addEventListener('touchmove', moveHandler, { passive: false });
  document.addEventListener('mouseup', endHandler);
  document.addEventListener('touchend', endHandler);
}

// Start resize with short hold. horizontalEdge is 'right' (bottom-right handle)
// or 'left' (bottom-left handle, which moves pane.x as it resizes).
export function startResizeHold(e, paneEl, paneData, horizontalEdge = 'right') {
  e.preventDefault();
  const point = e.touches ? e.touches[0] : e;
  const handleSelector = horizontalEdge === 'left' ? '.pane-resize-handle-left' : '.pane-resize-handle';
  const resizeHandle = paneEl.querySelector(handleSelector);

  resizeHandle.classList.add('hold-active');

  _ctx.dragState.holdTimer = setTimeout(() => {
    activateResize(paneEl, paneData, point, horizontalEdge);
  }, RESIZE_HOLD_DURATION);

  const endHandler = () => {
    clearTimeout(_ctx.dragState.holdTimer);
    if (!_ctx.dragState.isResizing) {
      resizeHandle.classList.remove('hold-active');
    }
    document.removeEventListener('mouseup', endHandler);
    document.removeEventListener('touchend', endHandler);
  };

  document.addEventListener('mouseup', endHandler);
  document.addEventListener('touchend', endHandler);
}

// Activate resize mode. horizontalEdge is 'right' (bottom-right handle, x stays
// fixed) or 'left' (bottom-left handle, the right edge stays fixed and x moves).
export function activateResize(paneEl, paneData, startPoint, horizontalEdge = 'right') {
  _ctx.dragState.isResizing = true;
  paneEl.classList.add('resizing');
  document.body.classList.add('no-select');
  _ctx.showIframeOverlays();

  const movingLeft = horizontalEdge === 'left';
  const startWidth = paneData.width;
  const startHeight = paneData.height;
  const fixedRight = paneData.x + startWidth;
  const startX = startPoint.clientX;
  const startY = startPoint.clientY;

  if (navigator.vibrate) {
    navigator.vibrate(30);
  }

  // During drag resize we must NOT call fitAddon.fit() continuously —
  // each fit() clears xterm's render state and triggers a tmux resize,
  // but before tmux can finish repainting, the next fit() clears it again.
  // This leaves stale content in parts of the terminal that never get
  // repainted. Instead, we only fit once when the drag ends (endHandler).
  const debouncedFit = () => {
    // No-op during drag — fit happens in endHandler only
  };

  const moveHandler = (moveE) => {
    moveE.preventDefault();
    const movePoint = moveE.touches ? moveE.touches[0] : moveE;

    const deltaX = (movePoint.clientX - startX) / _ctx.state.zoom;
    const deltaY = (movePoint.clientY - startY) / _ctx.state.zoom;

    // Dragging the bottom-left handle grows the pane leftward, so the
    // horizontal delta is inverted and the right edge stays anchored.
    let newWidth = Math.max(10, startWidth + (movingLeft ? -deltaX : deltaX));
    let newHeight = Math.max(10, startHeight + deltaY);

    // Snap resize edges (unless Shift held)
    if (!moveE.shiftKey) {
      const snaps = findResizeSnapTargets(paneData, newWidth, newHeight, horizontalEdge, fixedRight);
      if (snaps) {
        if (snaps.w) newWidth = Math.max(10, snaps.w.snapWidth);
        if (snaps.h) newHeight = snaps.h.snapHeight;
        showSnapGuides({ x: snaps.w, y: snaps.h });
      } else {
        removeSnapGuides();
      }
    } else {
      removeSnapGuides();
    }

    paneEl.style.width = `${newWidth}px`;
    paneEl.style.height = `${newHeight}px`;
    paneData.width = newWidth;
    paneData.height = newHeight;
    if (movingLeft) {
      paneData.x = fixedRight - newWidth;
      paneEl.style.left = `${paneData.x}px`;
    }
    _ctx.syncTabGroupGeometry(paneData);

    // Debounced refit terminal
    debouncedFit();
  };

  const endHandler = () => {
    removeSnapGuides();
    _ctx.dragState.isResizing = false;
    paneEl.classList.remove('resizing');
    paneEl.querySelectorAll('.pane-resize-handle, .pane-resize-handle-left')
      .forEach(h => h.classList.remove('hold-active'));
    document.body.classList.remove('no-select');
    _ctx.hideIframeOverlays();

    // Final fit after resize ends (only for terminals).
    // This is the ONLY fit that should happen during a resize operation —
    // intermediate fits during drag are disabled to prevent render corruption.
    if (paneData.type === 'terminal') {
      const termInfo = _ctx.terminals.get(paneData.id);
      if (termInfo) {
        try {
          if (termInfo.safeFitAndSync) termInfo.safeFitAndSync();
          else termInfo.fitAddon.fit();
          // Send resize immediately (include pixel dimensions so agent persists them)
          sendWs('terminal:resize', {
            terminalId: paneData.id,
            cols: termInfo.xterm.cols,
            rows: termInfo.xterm.rows,
            pixelWidth: paneData.width,
            pixelHeight: paneData.height
          }, paneData.agentId);
        } catch (e) {
          // Ignore fit errors
        }
      }
    }

    // Save size to cloud (cloud-only, no agent write)
    _ctx.cloudSaveLayout(paneData);

    document.removeEventListener('mousemove', moveHandler);
    document.removeEventListener('touchmove', moveHandler);
    document.removeEventListener('mouseup', endHandler);
    document.removeEventListener('touchend', endHandler);
  };

  document.addEventListener('mousemove', moveHandler);
  document.addEventListener('touchmove', moveHandler, { passive: false });
  document.addEventListener('mouseup', endHandler);
  document.addEventListener('touchend', endHandler);
}

