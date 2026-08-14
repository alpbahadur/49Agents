// ─── Projects & Checkpoints ───────────────────────────────────────────────
// Project rectangles drawn on the canvas, the checkpoint panes that mark
// positions within them, and the projects sidebar listing both.
//
// projectsSidebarVisible is the only piece of app.js state this section
// writes, so it comes through a getter/setter pair. state is passed by
// reference: state.projects is reassigned here, but state itself never is.

import { escapeHtml } from './utils.js';

let _ctx = null;

export function initProjectsDeps(ctx) { _ctx = ctx; }

const PROJECT_COLORS = [
  { name: 'Blue',    value: '59, 130, 246' },
  { name: 'Green',   value: '34, 197, 94' },
  { name: 'Purple',  value: '168, 85, 247' },
  { name: 'Orange',  value: '249, 115, 22' },
  { name: 'Pink',    value: '236, 72, 153' },
  { name: 'Cyan',    value: '6, 182, 212' },
  { name: 'Yellow',  value: '234, 179, 8' },
  { name: 'Red',     value: '239, 68, 68' },
];

function generateProjectId() {
  return 'proj-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Get panes that fall within a project's bounding rectangle (excludes checkpoint panes)
function getPanesInProject(project) {
  return _ctx.state.panes.filter(p => {
    if (p.type === 'checkpoint') return false;
    const px = p.x + p.width / 2;
    const py = p.y + p.height / 2;
    return px >= project.x && px <= project.x + project.width &&
           py >= project.y && py <= project.y + project.height;
  });
}

// Count pane states for a project (detailed: claude agents, working, done, input-needed, idle)
function getProjectPaneCounts(project) {
  const panes = getPanesInProject(project);
  let claude = 0, working = 0, done = 0, inputNeeded = 0, idle = 0, other = 0;
  for (const p of panes) {
    const el = document.getElementById(`pane-${p.id}`);
    if (!el) { other++; continue; }
    const isClaude = el.classList.contains('claude-working') ||
      el.classList.contains('claude-idle') ||
      el.classList.contains('claude-done') ||
      el.classList.contains('claude-permission') ||
      el.classList.contains('claude-question') ||
      el.classList.contains('claude-input-needed');
    if (isClaude) claude++;
    if (el.classList.contains('claude-working')) working++;
    else if (el.classList.contains('claude-done')) done++;
    else if (el.classList.contains('claude-permission') || el.classList.contains('claude-question') || el.classList.contains('claude-input-needed')) inputNeeded++;
    else if (el.classList.contains('claude-idle')) idle++;
    else other++;
  }
  return { total: panes.length, claude, working, done, inputNeeded, idle, other };
}

// Navigate to a project with zoom-to-fit
export function navigateToProject(project) {
  // Calculate zoom to fit the project rectangle in viewport with padding
  const padding = 60; // px padding around project
  const viewW = window.innerWidth - padding * 2;
  const viewH = window.innerHeight - padding * 2;
  const zoomX = viewW / project.width;
  const zoomY = viewH / project.height;
  const targetZoom = Math.min(zoomX, zoomY, 2); // cap at 2x

  _ctx.state.zoom = targetZoom;
  const centerX = project.x + project.width / 2;
  const centerY = project.y + project.height / 2;
  _ctx.state.panX = window.innerWidth / 2 - centerX * _ctx.state.zoom;
  _ctx.state.panY = window.innerHeight / 2 - centerY * _ctx.state.zoom;

  if (_ctx.getTeleportAnimation()) {
    _ctx.getCanvas().style.transition = 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1)';
    _ctx.updateCanvasTransform();
    setTimeout(() => { _ctx.getCanvas().style.transition = ''; }, 320);
  } else {
    _ctx.updateCanvasTransform();
  }
  _ctx.saveViewState();
}

// Navigate to a checkpoint pane (center viewport on it)
export function navigateToCheckpointPane(paneData) {
  const centerX = paneData.x + paneData.width / 2;
  const centerY = paneData.y + paneData.height / 2;
  _ctx.state.panX = window.innerWidth / 2 - centerX * _ctx.state.zoom;
  _ctx.state.panY = window.innerHeight / 2 - centerY * _ctx.state.zoom;

  if (_ctx.getTeleportAnimation()) {
    _ctx.getCanvas().style.transition = 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1)';
    _ctx.updateCanvasTransform();
    setTimeout(() => { _ctx.getCanvas().style.transition = ''; }, 320);
  } else {
    _ctx.updateCanvasTransform();
  }
  _ctx.saveViewState();
}

// Render project rectangles on the canvas
export function renderProjectRectangles() {
  _ctx.getCanvas().querySelectorAll('.project-rect').forEach(el => el.remove());

  for (const project of _ctx.state.projects) {
    const rect = document.createElement('div');
    rect.className = 'project-rect';
    rect.dataset.projectId = project.id;
    rect.style.left = project.x + 'px';
    rect.style.top = project.y + 'px';
    rect.style.width = project.width + 'px';
    rect.style.height = project.height + 'px';
    rect.style.setProperty('--project-color', project.color);
    rect.style.background = `rgba(${project.color}, 0.06)`;
    rect.style.border = `2px solid rgba(${project.color}, 0.3)`;
    rect.style.borderRadius = '16px';
    rect.style.zIndex = '0';

    // Project label — clickable button for rename/shortcut
    const label = document.createElement('button');
    label.className = 'project-rect-label';
    label.style.color = `rgba(${project.color}, 0.8)`;
    const shortcutHint = ` [${project.shortcutNumber || '?'}]`;
    label.textContent = project.name + shortcutHint;
    rect.appendChild(label);

    // Resize handle
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'project-rect-resize';
    rect.appendChild(resizeHandle);

    // Setup interactions
    setupProjectDrag(rect, project, label);
    setupProjectResize(rect, project, resizeHandle);

    _ctx.getCanvas().insertBefore(rect, _ctx.getCanvas().firstChild);
  }
}

function setupProjectDrag(rectEl, project, labelEl) {
  let dragging = false;
  let startX, startY, origX, origY;
  let clickStartTime = 0;
  let moved = false;

  labelEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragging = true;
    moved = false;
    clickStartTime = Date.now();
    startX = e.clientX;
    startY = e.clientY;
    origX = project.x;
    origY = project.y;

    const moveHandler = (moveE) => {
      if (!dragging) return;
      const dx = (moveE.clientX - startX) / _ctx.state.zoom;
      const dy = (moveE.clientY - startY) / _ctx.state.zoom;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      project.x = origX + dx;
      project.y = origY + dy;
      rectEl.style.left = project.x + 'px';
      rectEl.style.top = project.y + 'px';
    };

    const upHandler = () => {
      dragging = false;
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', upHandler);
      if (moved) {
        saveProjectsToCloud();
        renderProjectsSidebar();
      }
    };

    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);
  });

  // Left-click (no drag) on label: show project popup (rename + shortcut assign)
  labelEl.addEventListener('click', (e) => {
    if (moved) return; // was a drag, not a click
    e.stopPropagation();
    showProjectEditPopup(project, labelEl);
  });

  // Right-click context menu
  rectEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showProjectContextMenu(e, project);
  });
}

// Popup for editing project name and shortcut number (shown on label click)
function showProjectEditPopup(project, anchorEl) {
  // Remove any existing popup
  document.querySelectorAll('.project-edit-popup').forEach(el => el.remove());

  const rect = anchorEl.getBoundingClientRect();
  const popup = document.createElement('div');
  popup.className = 'project-edit-popup';
  popup.style.left = rect.left + 'px';
  popup.style.top = (rect.bottom + 6) + 'px';

  popup.innerHTML = `
    <div class="project-edit-row">
      <label class="project-edit-label">Name</label>
      <input type="text" class="project-edit-input" value="${escapeHtml(project.name)}" />
    </div>
    <div class="project-edit-row">
      <label class="project-edit-label">Shortcut</label>
      <div class="project-edit-shortcut">
        ${[1,2,3,4,5,6,7,8,9].map(n => {
          const taken = _ctx.state.panes.find(p => p.shortcutNumber === n) || _ctx.state.projects.find(p => p.shortcutNumber === n && p.id !== project.id);
          const isCurrent = project.shortcutNumber === n;
          return `<button class="project-shortcut-num ${isCurrent ? 'active' : ''} ${taken && !isCurrent ? 'taken' : ''}" data-num="${n}">${n}</button>`;
        }).join('')}
        <button class="project-shortcut-num ${!project.shortcutNumber ? 'active' : ''}" data-num="0">-</button>
      </div>
    </div>
    <div class="project-edit-row">
      <label class="project-edit-label">Color</label>
      <div class="project-edit-colors">
        ${PROJECT_COLORS.map(c => `<button class="project-color-btn ${project.color === c.value ? 'active' : ''}" data-color="${c.value}" style="background: rgba(${c.value}, 0.8);"></button>`).join('')}
      </div>
    </div>
    <div class="project-edit-actions">
      <button class="project-edit-delete">Delete Project</button>
    </div>
  `;

  document.body.appendChild(popup);

  const nameInput = popup.querySelector('.project-edit-input');
  nameInput.focus();
  nameInput.select();

  // Name change
  const saveName = () => {
    const newName = nameInput.value.trim();
    if (newName && newName !== project.name) {
      project.name = newName;
      saveProjectsToCloud();
      renderProjectRectangles();
      renderProjectsSidebar();
    }
  };
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveName(); closePopup(); }
    if (e.key === 'Escape') closePopup();
    e.stopPropagation(); // prevent Tab chords from firing
  });
  nameInput.addEventListener('blur', saveName);

  // Shortcut number buttons
  popup.querySelectorAll('.project-shortcut-num').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const num = parseInt(btn.dataset.num, 10);
      if (num === 0) {
        project.shortcutNumber = null;
      } else {
        _ctx.reassignShortcutNumber(project, num);
      }
      saveProjectsToCloud();
      renderProjectRectangles();
      renderProjectsSidebar();
      closePopup();
    });
  });

  // Color buttons
  popup.querySelectorAll('.project-color-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      project.color = btn.dataset.color;
      saveProjectsToCloud();
      renderProjectRectangles();
      renderProjectsSidebar();
      closePopup();
    });
  });

  // Delete button
  popup.querySelector('.project-edit-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    deleteProject(project.id);
    closePopup();
  });

  function closePopup() {
    popup.remove();
    document.removeEventListener('mousedown', outsideClick);
  }

  const outsideClick = (e) => {
    if (!popup.contains(e.target) && !anchorEl.contains(e.target)) {
      saveName();
      closePopup();
    }
  };
  setTimeout(() => document.addEventListener('mousedown', outsideClick), 0);
}

function showProjectContextMenu(e, project) {
  document.querySelectorAll('.project-context-menu').forEach(el => el.remove());

  const menu = document.createElement('div');
  menu.className = 'project-context-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  const goToBtn = document.createElement('button');
  goToBtn.textContent = 'Go to Project';
  goToBtn.addEventListener('click', () => { navigateToProject(project); menu.remove(); });

  const renameBtn = document.createElement('button');
  renameBtn.textContent = 'Edit Project';
  renameBtn.addEventListener('click', () => {
    menu.remove();
    const labelEl = document.querySelector(`.project-rect[data-project-id="${project.id}"] .project-rect-label`);
    if (labelEl) showProjectEditPopup(project, labelEl);
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = 'Delete Project';
  deleteBtn.addEventListener('click', () => { deleteProject(project.id); menu.remove(); });

  menu.appendChild(goToBtn);
  menu.appendChild(renameBtn);
  menu.appendChild(deleteBtn);
  document.body.appendChild(menu);

  const closeMenu = (ev) => {
    if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', closeMenu); }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

function setupProjectResize(rectEl, project, handleEl) {
  let resizing = false;
  let startX, startY, origW, origH;

  handleEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    resizing = true;
    startX = e.clientX;
    startY = e.clientY;
    origW = project.width;
    origH = project.height;

    const moveHandler = (moveE) => {
      if (!resizing) return;
      const dx = (moveE.clientX - startX) / _ctx.state.zoom;
      const dy = (moveE.clientY - startY) / _ctx.state.zoom;
      project.width = Math.max(200, origW + dx);
      project.height = Math.max(150, origH + dy);
      rectEl.style.width = project.width + 'px';
      rectEl.style.height = project.height + 'px';
    };

    const upHandler = () => {
      resizing = false;
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', upHandler);
      saveProjectsToCloud();
      renderProjectsSidebar();
    };

    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);
  });
}

function deleteProject(projectId) {
  _ctx.state.projects = _ctx.state.projects.filter(p => p.id !== projectId);
  saveProjectsToCloud();
  renderProjectRectangles();
  renderProjectsSidebar();
}

// Render a checkpoint pane (circle with name + shortcut badge)
export function renderCheckpointPane(paneData) {
  const existingPane = document.getElementById(`pane-${paneData.id}`);
  if (existingPane) existingPane.remove();

  const pane = document.createElement('div');
  pane.className = 'pane checkpoint-pane';
  pane.id = `pane-${paneData.id}`;
  pane.style.left = `${paneData.x}px`;
  pane.style.top = `${paneData.y}px`;
  pane.style.width = `${paneData.width}px`;
  pane.style.height = `${paneData.height}px`;
  pane.style.zIndex = paneData.zIndex;
  pane.dataset.paneId = paneData.id;

  if (!paneData.shortcutNumber) paneData.shortcutNumber = _ctx.getNextShortcutNumber();

  pane.innerHTML = `
    <div class="checkpoint-pane-circle">
      <svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 010-5 2.5 2.5 0 010 5z" fill="currentColor"/></svg>
    </div>
    <div class="checkpoint-pane-name">${escapeHtml(paneData.paneName || paneData.checkpointName || 'Checkpoint')}</div>
    <div class="checkpoint-pane-badge">${paneData.shortcutNumber ? `Tab+${paneData.shortcutNumber}` : 'Tab+?'}</div>
    <button class="checkpoint-pane-close" aria-label="Close"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
  `;

  _ctx.getCanvas().appendChild(pane);

  // Draggable via circle
  const circleEl = pane.querySelector('.checkpoint-pane-circle');
  let ckDragging = false, ckMoved = false, ckStartX, ckStartY, ckOrigX, ckOrigY;
  circleEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    ckDragging = true;
    ckMoved = false;
    ckStartX = e.clientX;
    ckStartY = e.clientY;
    ckOrigX = paneData.x;
    ckOrigY = paneData.y;
    // Bring to front
    paneData.zIndex = _ctx.state.nextZIndex++;
    pane.style.zIndex = paneData.zIndex;

    const moveH = (me) => {
      if (!ckDragging) return;
      const dx = (me.clientX - ckStartX) / _ctx.state.zoom;
      const dy = (me.clientY - ckStartY) / _ctx.state.zoom;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) ckMoved = true;
      paneData.x = ckOrigX + dx;
      paneData.y = ckOrigY + dy;
      pane.style.left = paneData.x + 'px';
      pane.style.top = paneData.y + 'px';
    };
    const upH = () => {
      ckDragging = false;
      document.removeEventListener('mousemove', moveH);
      document.removeEventListener('mouseup', upH);
      if (ckMoved) _ctx.cloudSaveLayout(paneData);
    };
    document.addEventListener('mousemove', moveH);
    document.addEventListener('mouseup', upH);
  });

  // Click circle (no drag) to teleport
  circleEl.addEventListener('click', (e) => {
    if (ckMoved) return;
    e.stopPropagation();
    navigateToCheckpointPane(paneData);
  });

  // Close button
  pane.querySelector('.checkpoint-pane-close').addEventListener('click', (e) => {
    e.stopPropagation();
    _ctx.deletePane(paneData.id);
  });

  // Click on name to rename
  const nameEl = pane.querySelector('.checkpoint-pane-name');
  nameEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const input = document.createElement('input');
    input.type = 'text';
    input.value = paneData.paneName || paneData.checkpointName || 'Checkpoint';
    input.className = 'checkpoint-rename-input';
    nameEl.style.display = 'none';
    circleEl.insertAdjacentElement('afterend', input);
    input.focus();
    input.select();

    const finish = () => {
      const newName = input.value.trim() || 'Checkpoint';
      paneData.paneName = newName;
      paneData.checkpointName = newName;
      nameEl.textContent = newName;
      nameEl.style.display = '';
      input.remove();
      _ctx.cloudSaveLayout(paneData);
      renderProjectsSidebar();
    };

    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (ke) => {
      ke.stopPropagation();
      if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
      if (ke.key === 'Escape') { input.value = paneData.paneName || 'Checkpoint'; input.blur(); }
    });
  });

  // Click on badge to reassign shortcut
  const badgeEl = pane.querySelector('.checkpoint-pane-badge');
  if (badgeEl) {
    badgeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      _ctx.showShortcutAssignPopup(paneData);
    });
  }
}

// Create a new project via placement mode (draw rectangle)
export function startProjectCreation() {
  const colorIdx = _ctx.state.projects.length % PROJECT_COLORS.length;
  const color = PROJECT_COLORS[colorIdx].value;

  const overlay = document.createElement('div');
  overlay.className = 'project-creation-overlay';
  overlay.innerHTML = '<div class="project-creation-hint">Click and drag to draw a project area. Press Escape to cancel.</div>';
  document.body.appendChild(overlay);

  let drawing = false;
  let startCanvasX, startCanvasY;
  let previewRect = null;

  const mousedownHandler = (e) => {
    if (e.button !== 0) return;
    drawing = true;
    startCanvasX = (e.clientX - _ctx.state.panX) / _ctx.state.zoom;
    startCanvasY = (e.clientY - _ctx.state.panY) / _ctx.state.zoom;

    previewRect = document.createElement('div');
    previewRect.className = 'project-creation-preview';
    previewRect.style.background = `rgba(${color}, 0.1)`;
    previewRect.style.border = `2px dashed rgba(${color}, 0.5)`;
    previewRect.style.borderRadius = '16px';
    previewRect.style.left = startCanvasX + 'px';
    previewRect.style.top = startCanvasY + 'px';
    _ctx.getCanvas().appendChild(previewRect);
  };

  const mousemoveHandler = (e) => {
    if (!drawing || !previewRect) return;
    const curX = (e.clientX - _ctx.state.panX) / _ctx.state.zoom;
    const curY = (e.clientY - _ctx.state.panY) / _ctx.state.zoom;
    const x = Math.min(startCanvasX, curX);
    const y = Math.min(startCanvasY, curY);
    const w = Math.abs(curX - startCanvasX);
    const h = Math.abs(curY - startCanvasY);
    previewRect.style.left = x + 'px';
    previewRect.style.top = y + 'px';
    previewRect.style.width = w + 'px';
    previewRect.style.height = h + 'px';
  };

  const mouseupHandler = (e) => {
    if (!drawing) return;
    drawing = false;

    const endX = (e.clientX - _ctx.state.panX) / _ctx.state.zoom;
    const endY = (e.clientY - _ctx.state.panY) / _ctx.state.zoom;
    const x = Math.min(startCanvasX, endX);
    const y = Math.min(startCanvasY, endY);
    const w = Math.abs(endX - startCanvasX);
    const h = Math.abs(endY - startCanvasY);

    cleanup();

    if (w < 100 || h < 80) return; // Too small, cancel

    const project = {
      id: generateProjectId(),
      name: 'Project ' + (_ctx.state.projects.length + 1),
      color: color,
      x, y,
      width: w,
      height: h,
      shortcutNumber: _ctx.getNextShortcutNumber(),
    };
    _ctx.state.projects.push(project);
    saveProjectsToCloud();
    renderProjectRectangles();
    renderProjectsSidebar();
  };

  const keyHandler = (e) => {
    if (e.key === 'Escape') { drawing = false; cleanup(); }
  };

  function cleanup() {
    overlay.remove();
    if (previewRect) previewRect.remove();
    document.removeEventListener('mousedown', mousedownHandler);
    document.removeEventListener('mousemove', mousemoveHandler);
    document.removeEventListener('mouseup', mouseupHandler);
    document.removeEventListener('keydown', keyHandler, true);
  }

  document.addEventListener('mousedown', mousedownHandler);
  document.addEventListener('mousemove', mousemoveHandler);
  document.addEventListener('mouseup', mouseupHandler);
  document.addEventListener('keydown', keyHandler, true);
}

// Create standalone checkpoint pane at viewport center
export function createCheckpointPane() {
  const centerX = (window.innerWidth / 2 - _ctx.state.panX) / _ctx.state.zoom;
  const centerY = (window.innerHeight / 2 - _ctx.state.panY) / _ctx.state.zoom;
  const checkpointCount = _ctx.state.panes.filter(p => p.type === 'checkpoint').length;
  const paneData = {
    id: 'ckpt-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type: 'checkpoint',
    x: centerX - 30,
    y: centerY - 30,
    width: 60,
    height: 60,
    zIndex: _ctx.state.nextZIndex++,
    shortcutNumber: _ctx.getNextShortcutNumber(),
    checkpointName: 'Checkpoint ' + (checkpointCount + 1),
    paneName: 'Checkpoint ' + (checkpointCount + 1),
  };
  _ctx.state.panes.push(paneData);
  renderCheckpointPane(paneData);
  _ctx.cloudSaveLayout(paneData);
  renderProjectsSidebar();
}

// -- Projects Sidebar (center-top, expands downward) --
export function createProjectsSidebar() {
  const sidebar = document.createElement('div');
  sidebar.id = 'projects-sidebar';
  sidebar.className = 'tc-scrollbar';
  sidebar.innerHTML = `
    <div class="projects-sidebar-header">
      <span class="projects-sidebar-title">Projects</span>
      <div class="projects-sidebar-actions">
        <button class="projects-sidebar-btn" id="add-project-btn" title="New Project (draw rectangle)">+P</button>
        <button class="projects-sidebar-btn" id="add-checkpoint-btn" title="New Checkpoint pane">+C</button>
      </div>
    </div>
    <div class="projects-sidebar-content"></div>
  `;
  document.body.appendChild(sidebar);

  sidebar.querySelector('#add-project-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    startProjectCreation();
  });

  sidebar.querySelector('#add-checkpoint-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    createCheckpointPane();
  });

  applyProjectsSidebarPosition();
  return sidebar;
}

export function applyProjectsSidebarPosition() {
  const sidebar = document.getElementById('projects-sidebar');
  if (!sidebar) return;
  // Reset positioning
  sidebar.style.left = '';
  sidebar.style.right = '';
  sidebar.style.transform = '';

  if (_ctx.getProjectsSidebarPosition() === 'left') {
    sidebar.style.left = '16px';
    sidebar.style.right = 'auto';
  } else {
    // right (default)
    sidebar.style.right = '16px';
    sidebar.style.left = 'auto';
  }
}

export function toggleProjectsSidebar() {
  _ctx.setProjectsSidebarVisible(!_ctx.getProjectsSidebarVisible());
  let sidebar = document.getElementById('projects-sidebar');
  if (!sidebar) {
    sidebar = createProjectsSidebar();
  }
  sidebar.classList.toggle('visible', _ctx.getProjectsSidebarVisible());
  if (_ctx.getProjectsSidebarVisible()) {
    renderProjectsSidebar();
  }
}

export function renderProjectsSidebar() {
  const content = document.querySelector('#projects-sidebar .projects-sidebar-content');
  if (!content) return;

  let html = '';

  // Projects section
  if (_ctx.state.projects.length > 0) {
    html += '<div class="ps-section-label">Projects</div>';
    for (let i = 0; i < _ctx.state.projects.length; i++) {
      const project = _ctx.state.projects[i];
      const counts = getProjectPaneCounts(project);
      const numberBadge = `<span class="ps-number-badge">${project.shortcutNumber ? `Tab+${project.shortcutNumber}` : 'Tab+?'}</span>`;

      // Build detailed stats line
      const stats = [];
      stats.push(`<span class="ps-stat">${counts.total} panes</span>`);
      if (counts.claude > 0) stats.push(`<span class="ps-stat ps-claude">${counts.claude} claude</span>`);
      if (counts.working > 0) stats.push(`<span class="ps-stat ps-working">${counts.working} working</span>`);
      if (counts.done > 0) stats.push(`<span class="ps-stat ps-done">${counts.done} done</span>`);
      if (counts.inputNeeded > 0) stats.push(`<span class="ps-stat ps-input">${counts.inputNeeded} waiting</span>`);
      if (counts.idle > 0) stats.push(`<span class="ps-stat ps-idle">${counts.idle} idle</span>`);

      html += `<div class="ps-item ps-project" data-project-id="${project.id}">
        <div class="ps-color-dot" style="background: rgba(${project.color}, 0.8);"></div>
        <div class="ps-item-info">
          <div class="ps-item-name">${escapeHtml(project.name)}</div>
          <div class="ps-item-stats">${stats.join('')}</div>
        </div>
        ${numberBadge}
      </div>`;
    }
  }

  // Standalone checkpoint panes section
  const checkpointPanes = _ctx.state.panes.filter(p => p.type === 'checkpoint');
  if (checkpointPanes.length > 0) {
    html += '<div class="ps-section-label">Checkpoints</div>';
    for (const ckpt of checkpointPanes) {
      const ckptBadge = `<span class="ps-number-badge">${ckpt.shortcutNumber ? `Tab+${ckpt.shortcutNumber}` : 'Tab+?'}</span>`;
      html += `<div class="ps-item ps-checkpoint" data-pane-id="${ckpt.id}">
        <div class="ps-checkpoint-icon">
          <svg viewBox="0 0 24 24" width="12" height="12"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 010-5 2.5 2.5 0 010 5z" fill="currentColor"/></svg>
        </div>
        <div class="ps-item-info">
          <div class="ps-item-name">${escapeHtml(ckpt.paneName || ckpt.checkpointName || 'Checkpoint')}</div>
        </div>
        ${ckptBadge}
        <button class="ps-delete-btn" data-delete-pane-id="${ckpt.id}" title="Delete checkpoint"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>`;
    }
  }

  if (_ctx.state.projects.length === 0 && checkpointPanes.length === 0) {
    html = '<div class="ps-empty">No projects yet. Click +P to draw a project area on the canvas, or use the add menu.</div>';
  }

  content.innerHTML = html;

  // Wire up click handlers
  content.querySelectorAll('.ps-project').forEach(el => {
    el.addEventListener('click', () => {
      const projId = el.dataset.projectId;
      const project = _ctx.state.projects.find(p => p.id === projId);
      if (project) navigateToProject(project);
    });
  });

  content.querySelectorAll('.ps-checkpoint').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.ps-delete-btn')) return; // handled below
      const paneId = el.dataset.paneId;
      const paneData = _ctx.state.panes.find(p => p.id === paneId);
      if (paneData) navigateToCheckpointPane(paneData);
    });
  });

  // Delete buttons for checkpoints in sidebar
  content.querySelectorAll('.ps-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const paneId = btn.dataset.deletePaneId;
      if (paneId) {
        _ctx.deletePane(paneId);
        renderProjectsSidebar();
      }
    });
  });
}

// Persistence: save/load projects via cloud API
let projectsSaveTimer = null;
export function saveProjectsToCloud() {
  if (projectsSaveTimer) clearTimeout(projectsSaveTimer);
  projectsSaveTimer = setTimeout(() => {
    _ctx.cloudFetch('PUT', '/api/preferences', _ctx.getAllPrefs({
      projects: _ctx.state.projects,
    })).catch(e => console.error('[Projects] Save failed:', e.message));
  }, 500);
}

export function loadProjectsFromPrefs(prefs) {
  if (prefs.projects && Array.isArray(prefs.projects)) {
    _ctx.state.projects = prefs.projects;
  }
}

// Periodically refresh sidebar pane counts (every 5s when visible)
let projectsSidebarRefreshTimer = null;
export function startProjectsSidebarRefresh() {
  if (projectsSidebarRefreshTimer) clearInterval(projectsSidebarRefreshTimer);
  projectsSidebarRefreshTimer = setInterval(() => {
    if (_ctx.getProjectsSidebarVisible()) renderProjectsSidebar();
  }, 5000);
}
