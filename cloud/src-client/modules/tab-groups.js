// ─── Tab Groups ───────────────────────────────────────────────────────────
// Panes sharing a tabGroupId are drawn as one window with a tab bar; only
// the active tab's element is visible and its siblings are display:none.
// Handles switching, adding and closing tabs, and keeping every pane in a
// group at the same geometry.

import { escapeHtml } from './utils.js';
import { sendWs, agentRequest } from './ws-transport.js';
import { createPane, deletePane } from './pane-creation.js';

let _ctx = null;

export function initTabGroupsDeps(ctx) { _ctx = ctx; }


export function getTabGroupPanes(tabGroupId) {
  if (!tabGroupId) return [];
  return _ctx.state.panes.filter(p => p.tabGroupId === tabGroupId);
}

export function getActiveTabPane(tabGroupId) {
  return getTabGroupPanes(tabGroupId).find(p => p.tabGroupActive);
}

// Switch to a different tab within a group
export function switchTab(targetPaneId) {
  const targetPane = _ctx.state.panes.find(p => p.id === targetPaneId);
  if (!targetPane || !targetPane.tabGroupId) return;

  const groupPanes = getTabGroupPanes(targetPane.tabGroupId);
  const currentActive = groupPanes.find(p => p.tabGroupActive);

  if (currentActive && currentActive.id === targetPaneId) return; // already active

  // Sync geometry from current active to target before switching
  if (currentActive) {
    targetPane.x = currentActive.x;
    targetPane.y = currentActive.y;
    targetPane.width = currentActive.width;
    targetPane.height = currentActive.height;
    targetPane.zIndex = currentActive.zIndex;
    currentActive.tabGroupActive = false;

    const currentEl = document.getElementById(`pane-${currentActive.id}`);
    if (currentEl) currentEl.style.display = 'none';
  }

  targetPane.tabGroupActive = true;
  const targetEl = document.getElementById(`pane-${targetPaneId}`);
  if (targetEl) {
    targetEl.style.display = '';
    targetEl.style.left = `${targetPane.x}px`;
    targetEl.style.top = `${targetPane.y}px`;
    targetEl.style.width = `${targetPane.width}px`;
    targetEl.style.height = `${targetPane.height}px`;
    targetEl.style.zIndex = targetPane.zIndex;
  }

  // Refit terminal after showing (dimensions may have changed while hidden)
  const termInfo = _ctx.terminals.get(targetPaneId);
  if (termInfo) {
    setTimeout(() => {
      try {
        if (termInfo.safeFitAndSync) termInfo.safeFitAndSync();
        else termInfo.fitAddon.fit();
      } catch (e) { /* ignore */ }
    }, 50);
  }

  // Re-render tab bars for all panes in the group
  refreshTabBars(targetPane.tabGroupId);
  _ctx.focusPane(targetPane);
  _ctx.focusTerminalInput(targetPaneId);

  // Persist state
  groupPanes.forEach(p => _ctx.cloudSaveLayout(p));
}

// Sync position/size from the active tab to all hidden siblings
export function syncTabGroupGeometry(paneData) {
  if (!paneData.tabGroupId) return;
  const siblings = getTabGroupPanes(paneData.tabGroupId);
  for (const sib of siblings) {
    if (sib.id === paneData.id) continue;
    sib.x = paneData.x;
    sib.y = paneData.y;
    sib.width = paneData.width;
    sib.height = paneData.height;
    // Don't update DOM for hidden panes — it'll sync when switchTab shows them
  }
}

// Create a new terminal tab in the same group as an existing pane
export async function createTabInGroup(sourcePaneId) {
  const sourcePane = _ctx.state.panes.find(p => p.id === sourcePaneId);
  if (!sourcePane || sourcePane.type !== 'terminal') return;

  // If source pane has no group yet, assign one
  if (!sourcePane.tabGroupId) {
    const groupNum = _ctx.getNextTabGroupId();
    _ctx.setNextTabGroupId(groupNum + 1);
    sourcePane.tabGroupId = `tg-${groupNum}`;
    sourcePane.tabGroupActive = true;
    _ctx.cloudSaveLayout(sourcePane);
  }

  const groupId = sourcePane.tabGroupId;
  const agentId = sourcePane.agentId || _ctx.getActiveAgentId();

  try {
    const reqBody = {
      workingDir: sourcePane.workingDir || '~',
      position: { x: sourcePane.x, y: sourcePane.y },
      size: { width: sourcePane.width, height: sourcePane.height }
    };
    if (sourcePane.device) reqBody.device = sourcePane.device;
    const terminal = await agentRequest('POST', '/api/terminals', reqBody, agentId);

    const pane = {
      id: terminal.id,
      type: 'terminal',
      x: sourcePane.x,
      y: sourcePane.y,
      width: sourcePane.width,
      height: sourcePane.height,
      zIndex: sourcePane.zIndex,
      tmuxSession: terminal.tmuxSession,
      device: terminal.device || sourcePane.device || null,
      agentId: agentId,
      tabGroupId: groupId,
      tabGroupActive: false, // will become active after switchTab
    };

    _ctx.state.panes.push(pane);
    _ctx.telemetry.trackPaneOpen(pane);
    _ctx.renderPane(pane);
    _ctx.cloudSaveLayout(pane);

    // Hide immediately since it's not the active tab yet
    const newEl = document.getElementById(`pane-${pane.id}`);
    if (newEl) newEl.style.display = 'none';

    // Wait for terminal init, then switch to the new tab
    await new Promise(r => setTimeout(r, 200));
    switchTab(pane.id);

    // Refresh tab bars on the source pane too (it now has a tab bar)
    refreshTabBars(groupId);

  } catch (e) {
    console.error('[App] Failed to create tab:', e);
  }
}

// Re-render tab bars on all visible panes in a group
export function refreshTabBars(tabGroupId) {
  if (!tabGroupId) return;
  const groupPanes = getTabGroupPanes(tabGroupId);
  for (const p of groupPanes) {
    const paneEl = document.getElementById(`pane-${p.id}`);
    if (!paneEl) continue;
    renderTabBar(paneEl, p);
  }
}

// Render (or update) the tab bar inside a pane element
export function renderTabBar(paneEl, paneData) {
  // Remove existing tab bar if any
  const existing = paneEl.querySelector('.tab-bar');
  if (existing) existing.remove();

  if (!paneData.tabGroupId) return;

  const groupPanes = getTabGroupPanes(paneData.tabGroupId);
  if (groupPanes.length < 2) return; // no bar needed for single-tab groups

  const bar = document.createElement('div');
  bar.className = 'tab-bar';

  groupPanes.forEach((p, idx) => {
    const tab = document.createElement('div');
    tab.className = 'tab-bar-tab' + (p.tabGroupActive ? ' active' : '');
    tab.dataset.paneId = p.id;

    const label = document.createElement('span');
    label.className = 'tab-bar-label';
    label.textContent = p.paneName || `Terminal ${idx + 1}`;
    tab.appendChild(label);

    // Close button per tab
    const closeBtn = document.createElement('span');
    closeBtn.className = 'tab-bar-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
    });
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTabInGroup(p.id);
    });
    tab.appendChild(closeBtn);

    // Click to switch tab
    tab.addEventListener('mousedown', (e) => {
      e.stopPropagation(); // don't start drag
    });
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!p.tabGroupActive) switchTab(p.id);
    });

    bar.appendChild(tab);
  });

  // Add "+" button at end of tab bar
  const addBtn = document.createElement('div');
  addBtn.className = 'tab-bar-add';
  addBtn.textContent = '+';
  addBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    createTabInGroup(paneData.id);
  });
  bar.appendChild(addBtn);

  // Insert after .pane-header
  const header = paneEl.querySelector('.pane-header');
  if (header) {
    header.insertAdjacentElement('afterend', bar);
  }
}

// Close a tab within a group
export function closeTabInGroup(paneId) {
  const pane = _ctx.state.panes.find(p => p.id === paneId);
  if (!pane || !pane.tabGroupId) {
    deletePane(paneId);
    return;
  }

  const groupId = pane.tabGroupId;
  const groupPanes = getTabGroupPanes(groupId);

  if (groupPanes.length <= 1) {
    // Last tab in group — dissolve group and delete normally
    pane.tabGroupId = null;
    pane.tabGroupActive = false;
    deletePane(paneId);
    return;
  }

  const wasActive = pane.tabGroupActive;

  // If closing the active tab, switch to adjacent first
  if (wasActive) {
    const idx = groupPanes.findIndex(p => p.id === paneId);
    const nextIdx = idx < groupPanes.length - 1 ? idx + 1 : idx - 1;
    switchTab(groupPanes[nextIdx].id);
  }

  // Now delete the pane
  deletePane(paneId);

  // If only one tab remains, dissolve the group
  const remaining = getTabGroupPanes(groupId);
  if (remaining.length === 1) {
    remaining[0].tabGroupId = null;
    remaining[0].tabGroupActive = false;
    _ctx.cloudSaveLayout(remaining[0]);
    // Remove the tab bar from the remaining pane
    const el = document.getElementById(`pane-${remaining[0].id}`);
    if (el) {
      const bar = el.querySelector('.tab-bar');
      if (bar) bar.remove();
    }
  } else {
    refreshTabBars(groupId);
  }
}

