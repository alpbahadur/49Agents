// ─── Cloud Persistence ────────────────────────────────────────────────────
// The REST calls that persist canvas state: pane layouts, note bodies, the
// view transform, and the "recent contexts" the pickers offer as shortcuts.
//
// cloudFetch is the shared entry point. It routes through the relay when an
// agent is connected and falls back to a direct fetch otherwise, so every
// caller here works in both local and relayed setups. The per-pane and
// per-note debounce timers live with the functions that own them.

import { escapeHtml } from './utils.js';
import { createBrowserOverlay, attachPickerKeyboardNav } from './pane-creation.js';

let _ctx = null;

export function initCloudDeps(ctx) { _ctx = ctx; }

export function cloudFetch(method, path, body) {
  const opts = {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
  };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  return fetch(path, opts).then(r => r.ok ? r.json() : Promise.reject(new Error(`Cloud ${method} ${path}: ${r.status}`)));
}

// Cloud layout persistence (debounced per-pane, 500ms)
const cloudLayoutTimers = new Map();
export function cloudSaveLayout(pane) {
  if (cloudLayoutTimers.has(pane.id)) clearTimeout(cloudLayoutTimers.get(pane.id));
  cloudLayoutTimers.set(pane.id, setTimeout(() => {
    cloudLayoutTimers.delete(pane.id);
    const metadata = {};
    if (pane.zoomLevel && pane.zoomLevel !== 100) metadata.zoomLevel = pane.zoomLevel;
    if (pane.textOnly) metadata.textOnly = true;
    if (pane.type === 'folder' && pane.folderPath) metadata.folderPath = pane.folderPath;
    if (pane.beadsTag) metadata.beadsTag = pane.beadsTag;
    if (pane.device) metadata.device = pane.device;
    if (pane.filePath) metadata.filePath = pane.filePath;
    if (pane.fileName) metadata.fileName = pane.fileName;
    if (pane.url) metadata.url = pane.url;
    if (pane.repoPath) metadata.repoPath = pane.repoPath;
    if (pane.repoName) metadata.repoName = pane.repoName;
    if (pane.graphMode && pane.graphMode !== 'svg') metadata.graphMode = pane.graphMode;
    if (pane.projectPath) metadata.projectPath = pane.projectPath;
    if (pane.dirPath) metadata.dirPath = pane.dirPath;
    if (pane.claudeSessionId) metadata.claudeSessionId = pane.claudeSessionId;
    if (pane.claudeSessionName) metadata.claudeSessionName = pane.claudeSessionName;
    if (pane.workingDir) metadata.workingDir = pane.workingDir;
    if (pane.shortcutNumber) metadata.shortcutNumber = pane.shortcutNumber;
    if (pane.paneName) metadata.paneName = pane.paneName;
    if (pane.checkpointName) metadata.checkpointName = pane.checkpointName;
    if (pane.tabGroupId) metadata.tabGroupId = pane.tabGroupId;
    if (pane.tabGroupActive) metadata.tabGroupActive = true;
    cloudFetch('PUT', `/api/layouts/${pane.id}`, {
      paneType: pane.type,
      positionX: pane.x,
      positionY: pane.y,
      width: pane.width,
      height: pane.height,
      zIndex: pane.zIndex || 0,
      agentId: pane.agentId || _ctx.getActiveAgentId(),
      metadata: Object.keys(metadata).length > 0 ? metadata : null
    }).catch(e => console.error('[Cloud] Layout save failed:', e.message));
  }, 500));
}

// Save a recent pane context to cloud (fire-and-forget)
export function saveRecentContext(paneType, context, label, agentId) {
  const resolvedAgentId = agentId || _ctx.getActiveAgentId();
  if (!resolvedAgentId || !context) return;
  cloudFetch('POST', '/api/recent-contexts', { paneType, agentId: resolvedAgentId, context, label: label || null })
    .catch(e => console.error('[Cloud] Recent context save failed:', e.message));
}

// Fetch recent pane contexts from cloud
export async function fetchRecentContexts(paneType, agentId) {
  const resolvedAgentId = agentId || _ctx.getActiveAgentId();
  if (!resolvedAgentId) return [];
  try {
    const data = await cloudFetch('GET', `/api/recent-contexts?paneType=${encodeURIComponent(paneType)}&agentId=${encodeURIComponent(resolvedAgentId)}`);
    return data.recents || [];
  } catch (e) {
    console.error('[Cloud] Recent context fetch failed:', e.message);
    return [];
  }
}

// Show a recents popup for a pane type. If recents exist, shows them + Browse option.
// If no recents, calls browseFn() directly.
// onRecent(context, label) is called when user picks a recent item.
// browseFn() is called when user picks "Browse..." or no recents exist.
export async function showRecentsOrBrowse(paneType, agentId, onRecent, browseFn) {
  const recents = await fetchRecentContexts(paneType, agentId);
  if (!recents || recents.length === 0) {
    browseFn();
    return;
  }

  const existing = document.getElementById('recents-picker');
  if (existing) existing.remove();

  const picker = document.createElement('div');
  picker.id = 'recents-picker';
  picker.className = 'pane-menu';
  picker.style.cssText = 'min-width:220px; max-width:360px;';

  // Header
  const header = document.createElement('div');
  header.style.cssText = 'padding:8px 14px 4px; font-size:11px; color:var(--ink-35); font-weight:500; text-transform:uppercase; letter-spacing:0.5px;';
  header.textContent = 'Recent';
  picker.appendChild(header);

  // Recent items
  for (const r of recents) {
    const btn = document.createElement('button');
    btn.className = 'menu-item';
    btn.setAttribute('data-nav-item', '');
    const displayLabel = escapeHtml(r.label || r.context);
    const displayPath = r.label && r.label !== r.context ? `<span style="opacity:0.4; font-size:11px; margin-left:6px;">${escapeHtml(r.context)}</span>` : '';
    btn.innerHTML = `<span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${displayLabel}${displayPath}</span>`;
    btn.addEventListener('click', () => {
      nav.cleanup();
      document.removeEventListener('click', closeHandler);
      picker.remove();
      onRecent(r.context, r.label);
    });
    btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--ink-10)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
    picker.appendChild(btn);
  }

  // Divider
  const divider = document.createElement('div');
  divider.style.cssText = 'height:1px; background:var(--ink-08); margin:4px 8px;';
  picker.appendChild(divider);

  // Browse button
  const browseBtn = document.createElement('button');
  browseBtn.className = 'menu-item';
  browseBtn.setAttribute('data-nav-item', '');
  browseBtn.innerHTML = '<span style="opacity:0.6;">Browse...</span>';
  browseBtn.addEventListener('click', () => {
    nav.cleanup();
    document.removeEventListener('click', closeHandler);
    picker.remove();
    browseFn();
  });
  browseBtn.addEventListener('mouseenter', () => { browseBtn.style.background = 'var(--ink-10)'; });
  browseBtn.addEventListener('mouseleave', () => { browseBtn.style.background = 'none'; });
  picker.appendChild(browseBtn);

  // Position near the add button
  const addBtn = document.getElementById('add-pane-btn');
  if (addBtn) {
    const rect = addBtn.getBoundingClientRect();
    picker.style.top = (rect.bottom + 8) + 'px';
    picker.style.right = '16px';
  }

  document.body.appendChild(picker);

  const nav = attachPickerKeyboardNav(picker, {
    onEscape: () => {
      document.removeEventListener('click', closeHandler);
      picker.remove();
    }
  });

  const closeHandler = (e) => {
    if (!picker.contains(e.target)) {
      nav.cleanup();
      picker.remove();
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

export function cloudDeleteLayout(paneId) {
  if (cloudLayoutTimers.has(paneId)) {
    clearTimeout(cloudLayoutTimers.get(paneId));
    cloudLayoutTimers.delete(paneId);
  }
  cloudFetch('DELETE', `/api/layouts/${paneId}`)
    .catch(e => console.error('[Cloud] Layout delete failed:', e.message));
}

// Cloud view state (debounced 1s)
let cloudViewStateTimer = null;
export function cloudSaveViewState() {
  if (cloudViewStateTimer) clearTimeout(cloudViewStateTimer);
  cloudViewStateTimer = setTimeout(() => {
    cloudFetch('PUT', '/api/view-state', {
      zoom: _ctx.state.zoom,
      panX: _ctx.state.panX,
      panY: _ctx.state.panY
    }).catch(e => console.error('[Cloud] View state save failed:', e.message));
  }, 1000);
}

// Cloud note sync (debounced per-note, 500ms)
const cloudNoteTimers = new Map();
export function cloudSaveNote(noteId, content, fontSize, images) {
  if (cloudNoteTimers.has(noteId)) clearTimeout(cloudNoteTimers.get(noteId));
  cloudNoteTimers.set(noteId, setTimeout(() => {
    cloudNoteTimers.delete(noteId);
    const payload = { content, fontSize };
    if (images !== undefined) payload.images = images;
    cloudFetch('PUT', `/api/cloud-notes/${noteId}`, payload)
      .catch(e => console.error('[Cloud] Note sync failed:', e.message));
  }, 500));
}

