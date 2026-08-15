// ─── HUD System ───────────────────────────────────────────────────────────
// The overlay HUDs: the fleet panel listing devices and their panes, the
// agents panel with usage figures, and the chat/feedback panel — plus
// device highlighting and terminal theme application.
//
// The HUD's own state lives here rather than in app.js. Several pieces of
// it are read and written from outside (the preferences load restores the
// expanded/hidden flags, and the usage poll timers are started elsewhere),
// so those are reached through the exported accessors below instead of
// app.js holding the variables and handing down a getter/setter pair for
// each one.

import { escapeHtml, formatBytes, metricColorClass, formatLocationPath, truncateUrl, isAgentVersionOutdated } from './utils.js';
import { RESET_ICON_SVG, DEVICE_COLORS, osIcon, CLAUDE_STATE_SVGS, CLAUDE_LOGO_SVG } from './constants.js';
import { agentRequest } from './ws-transport.js';
import { showAddMachineDialog } from './agent-ui.js';
import { savePrefsToCloud } from './settings.js';
import { clearTerminalNotificationState } from './notifications.js';

// Loaded by themes.js onto window before this module runs.
const TERMINAL_THEMES = window.TERMINAL_THEMES || {};

let _ctx = null;

export function initHudDeps(ctx) { _ctx = ctx; }

// HUD overlay state
let hudData = { devices: [] };
let hudPollingTimer = null;
let hudRenderTimer = null;
let hudIsHovered = false;
let hudExpanded = false;
let deviceColorOverrides = {}; // { deviceName: colorIndex } — persisted in hudState.device_colors
let deviceSwatchOpenFor = null; // device name whose color swatches are currently shown
let hoveredDeviceName = null;
const HUD_POLL_SLOW = 30000;
const HUD_POLL_FAST = 1000;

// Agents HUD state
let agentsHudExpanded = false;
let feedbackHudExpanded = false;
let feedbackPaneHidden = false;
let hudHidden = false;
let fleetPaneHidden = false;
let agentsPaneHidden = false;
let agentsUsageData = null;
let agentsUsageLastUpdated = null;
let agentsUsageIntervalId = null;
let agentsUsageFetchError = null;
let agentsUsageAgoIntervalId = null;

export function createHudContainer() {
  const container = document.createElement('div');
  container.id = 'hud-container';
  document.body.appendChild(container);

  // Restore dot — shown when HUD is fully hidden
  const dot = document.createElement('div');
  dot.id = 'hud-restore-dot';
  dot.addEventListener('click', () => toggleHudHidden());
  document.body.appendChild(dot);

  return container;
}

export function toggleHudHidden() {
  hudHidden = !hudHidden;
  const container = document.getElementById('hud-container');
  const dot = document.getElementById('hud-restore-dot');
  if (hudHidden) {
    if (container) container.style.display = 'none';
    if (dot) dot.style.display = 'block';
    applyNoHudMode(true);
  } else {
    // Tab+H restores all panes to visible
    fleetPaneHidden = false;
    agentsPaneHidden = false;
    feedbackPaneHidden = false;
    if (container) container.style.display = '';
    if (dot) dot.style.display = 'none';
    applyPaneVisibility();
    applyNoHudMode(false);
  }
  savePrefsToCloud({ hudState: { fleet_expanded: hudExpanded, agents_expanded: agentsHudExpanded, feedback_expanded: feedbackHudExpanded, hud_hidden: hudHidden } });
}

export function applyPaneVisibility() {
  const fleet = document.getElementById('hud-overlay');
  const agents = document.getElementById('agents-hud');
  const feedback = document.getElementById('feedback-hud');
  if (fleet) fleet.style.display = fleetPaneHidden ? 'none' : '';
  if (agents) agents.style.display = agentsPaneHidden ? 'none' : '';
  if (feedback) feedback.style.display = feedbackPaneHidden ? 'none' : '';
}

export function checkAutoHideHud() {
  // If all panes are individually hidden, auto-collapse to dot
  if (fleetPaneHidden && agentsPaneHidden && feedbackPaneHidden) {
    hudHidden = true;
    const container = document.getElementById('hud-container');
    const dot = document.getElementById('hud-restore-dot');
    if (container) container.style.display = 'none';
    if (dot) dot.style.display = 'block';
    applyNoHudMode(true);
    savePrefsToCloud({ hudState: { fleet_expanded: hudExpanded, agents_expanded: agentsHudExpanded, feedback_expanded: feedbackHudExpanded, hud_hidden: hudHidden } });
  }
}

export function applyNoHudMode(enabled) {
  const addBtn = document.getElementById('add-pane-btn');
  const settingsBtn = document.getElementById('settings-btn');
  const tutorialBtn = document.getElementById('tutorial-btn');
  const controls = document.getElementById('controls');
  const dot = document.getElementById('hud-restore-dot');
  if (enabled) {
    if (addBtn) addBtn.classList.add('no-hud-mode');
    if (settingsBtn) settingsBtn.classList.add('no-hud-mode');
    if (tutorialBtn) tutorialBtn.classList.add('no-hud-mode');
    if (controls) controls.classList.add('no-hud-mode');
    // Set dot color based on connection status
    updateHudDotColor();
  } else {
    if (addBtn) addBtn.classList.remove('no-hud-mode');
    if (settingsBtn) settingsBtn.classList.remove('no-hud-mode');
    if (tutorialBtn) tutorialBtn.classList.remove('no-hud-mode');
    if (controls) controls.classList.remove('no-hud-mode');
    if (dot) { dot.classList.remove('connected', 'disconnected'); }
  }
}

export function updateHudDotColor() {
  const dot = document.getElementById('hud-restore-dot');
  if (!dot) return;
  const hasOnline = hudData.devices.some(d => d.online);
  dot.classList.toggle('connected', hasOnline);
  dot.classList.toggle('disconnected', !hasOnline);
}

export function createHud(container) {
  const hud = document.createElement('div');
  hud.id = 'hud-overlay';
  if (!hudExpanded) hud.classList.add('collapsed');
  hud.innerHTML = `
    <div class="hud-header">
      <span class="hud-title">Machines</span>
      <span class="hud-collapse-dots"></span>
    </div>
    <div class="hud-content"></div>
  `;
  container.appendChild(hud);

  hud.addEventListener('click', (e) => {
    if (e.target.closest('input, button, a, select, textarea')) return;
    // Don't allow collapsing when fleet is empty — keep "Add Machine" visible
    if (hudData.devices.length === 0 && hudExpanded) return;
    hudExpanded = !hudExpanded;
    hud.classList.toggle('collapsed', !hudExpanded);
    savePrefsToCloud({
      hudState: {
        fleet_expanded: hudExpanded,
        agents_expanded: agentsHudExpanded,
      }
    });
    restartHudPolling();
    renderHud();
  });

  hud.addEventListener('mouseenter', () => {
    hudIsHovered = true;
    restartHudPolling();
  });
  hud.addEventListener('mouseleave', () => {
    hudIsHovered = false;
    restartHudPolling();
  });

  // Device hover highlight via event delegation (attached once, not per render)
  // Uses mouseover/mouseout + relatedTarget to avoid false clears when
  // moving between child elements inside the same .hud-device card.
  const hudContent = hud.querySelector('.hud-content');
  hudContent.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.hud-device');
    if (!card) return;
    if (hoveredDeviceName === card.dataset.device) return; // already hovering this device
    hoveredDeviceName = card.dataset.device;
    applyDeviceHighlight();
  });
  hudContent.addEventListener('mouseout', (e) => {
    const card = e.target.closest('.hud-device');
    if (!card) return;
    // Only clear if mouse is actually leaving the card, not moving to a child within it
    const relatedCard = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.hud-device') : null;
    if (relatedCard === card) return;
    hoveredDeviceName = null;
    clearDeviceHighlight();
    renderHud(); // Catch up on any skipped renders during hover
  });
}

export async function pollHud() {
  try {
    const onlineAgents = _ctx.agents.filter(a => a.online);
    if (onlineAgents.length === 0) return;
    // Fetch metrics from all online agents in parallel
    const results = await Promise.all(
      onlineAgents.map(a => agentRequest('GET', '/api/metrics', null, a.agentId).catch(() => []))
    );
    // Merge all agents' device lists
    hudData.devices = results.flat();
    if (hudHidden) updateHudDotColor();
    // Skip DOM rebuild while hovering a device to prevent flickering;
    // data is still updated above — next render after hover ends picks it up.
    if (!hoveredDeviceName) renderHud();
  } catch (e) {
    // Silent — relay/agent may not be connected yet
  }
}

export function restartHudPolling() {
  if (hudPollingTimer) clearInterval(hudPollingTimer);
  const rate = (hudExpanded && hudIsHovered) ? HUD_POLL_FAST : HUD_POLL_SLOW;
  hudPollingTimer = setInterval(pollHud, rate);
}

function getDevicePaneCounts(deviceName) {
  let terms = 0, claudes = 0, files = 0;
  for (const p of _ctx.state.panes) {
    const pDevice = p.device || hudData.devices.find(d => d.isLocal)?.name;
    if (pDevice !== deviceName) continue;
    if (p.type === 'terminal') {
      if (_ctx.claudeTerminalIds.has(p.id)) claudes++;
      else terms++;
    } else if (p.type === 'file') {
      files++;
    }
  }
  return { terms, claudes, files };
}

export function renderHud() {
  const content = document.querySelector('#hud-overlay .hud-content');
  const collapseDots = document.querySelector('#hud-overlay .hud-collapse-dots');
  const hudEl = document.getElementById('hud-overlay');
  if (!content) return;

  // When fleet is empty, force expanded so "Add Machine" is always visible
  const fleetEmpty = hudData.devices.length === 0;
  if (fleetEmpty && !hudExpanded) {
    hudExpanded = true;
    if (hudEl) hudEl.classList.remove('collapsed');
  }

  // Build dots HTML for collapsed header
  let dotsHtml = '';
  if (!hudExpanded) {
    for (const device of hudData.devices) {
      const cls = device.online ? 'online' : 'offline';
      dotsHtml += `<span class="hud-dot ${cls}" data-tooltip="${escapeHtml(device.name)}"></span>`;
    }
  }
  if (collapseDots) collapseDots.innerHTML = dotsHtml;

  // Collapsed: nothing in content area
  if (!hudExpanded) {
    content.innerHTML = '';
    return;
  }

  // Expanded — split into active (has panes) and inactive (no panes + phones)
  const PHONE_OS = new Set(['iOS', 'android']);
  const active = [];
  const inactive = [];
  for (const device of hudData.devices) {
    const { terms, claudes, files } = getDevicePaneCounts(device.name);
    if (PHONE_OS.has(device.os) || (terms === 0 && claudes === 0 && files === 0)) {
      inactive.push(device);
    } else {
      active.push(device);
    }
  }

  // Pane count SVG icons (defined once)
  const termSvg = '<svg class="hud-count-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v12h16V6H4zm2 2l4 4-4 4 1.5 1.5L9 12l-5.5-5.5L2 8zm6 8h6v2h-6v-2z"/></svg>';
  const claudeSvg = CLAUDE_LOGO_SVG.replace('class="claude-logo"', 'class="hud-count-icon hud-claude-icon"');
  const fileSvg = '<svg class="hud-count-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>';

  function renderDeviceCard(device, showMetrics) {
    const online = device.online;
    const dotClass = online ? 'online' : 'offline';
    let icon = osIcon(device.os);
    const deviceColor = _ctx.getDeviceColor(device.name);
    if (deviceColor) {
      icon = icon.replace('class="hud-os-icon"', `class="hud-os-icon" style="color:${deviceColor.text}"`);
    }
    const { terms, claudes, files } = getDevicePaneCounts(device.name);

    let countsHtml = '';
    const counts = [];
    if (claudes > 0) counts.push(`<span class="hud-count" data-tooltip="Claude Code">${claudeSvg}${claudes}</span>`);
    if (terms > 0) counts.push(`<span class="hud-count" data-tooltip="Terminals">${termSvg}${terms}</span>`);
    if (files > 0) counts.push(`<span class="hud-count" data-tooltip="Files">${fileSvg}${files}</span>`);
    if (counts.length) countsHtml = `<span class="hud-counts">${counts.join('')}</span>`;

    // Agent version dot (green = up to date, yellow = outdated)
    let versionDotHtml = '';
    const agentEntry = _ctx.agents.find(a => a.hostname === device.name || a.agentId === device.ip);
    if (agentEntry?.version && online) {
      const isOutdated = _ctx.agentUpdates.has(agentEntry.agentId);
      const dotClass2 = isOutdated ? 'hud-version-dot outdated' : 'hud-version-dot current';
      const tooltipText = isOutdated
        ? `v${agentEntry.version} — update available. Re-download: click Add Machine, copy the command, re-run on this machine. Kill the old agent process first.`
        : `v${agentEntry.version} — up to date`;
      versionDotHtml = `<span class="${dotClass2}" data-tooltip="${escapeHtml(tooltipText)}"></span>`;
    }

    let metricsHtml = '';
    if (showMetrics && device.metrics) {
      const m = device.metrics;
      const ramPct = Math.round((m.ram.used / m.ram.total) * 100);
      const ramMax = formatBytes(m.ram.total);
      const ramClass = metricColorClass(ramPct);

      const cpuVal = m.cpu != null ? m.cpu : null;
      const cpuClass = cpuVal != null ? metricColorClass(cpuVal) : '';

      let parts = [];
      parts.push(`<span class="hud-metric ${ramClass}">RAM ${ramPct}% <span class="hud-metric-dim">${ramMax}</span></span>`);
      parts.push(`<span class="hud-metric ${cpuClass}">CPU ${cpuVal != null ? cpuVal + '%' : '...'}</span>`);

      if (m.gpu) {
        const gpuClass = metricColorClass(m.gpu.utilization);
        parts.push(`<span class="hud-metric ${gpuClass}">GPU ${m.gpu.utilization}%</span>`);
      }

      metricsHtml = `<div class="hud-metrics">${parts.join('<span class="hud-metric-sep">·</span>')}</div>`;
    } else if (showMetrics && online) {
      metricsHtml = '<div class="hud-metrics"><span class="hud-metric hud-metric-dim">loading...</span></div>';
    }

    return `
      <div class="hud-device" data-device="${escapeHtml(device.name)}" data-agent-id="${escapeHtml(device.ip)}">
        <div class="hud-device-row">
          <span class="hud-status-dot ${dotClass}"></span>
          ${icon}
          <span class="hud-device-name">${escapeHtml(device.name)}</span>
          ${versionDotHtml}
          ${countsHtml}
          <button class="hud-device-delete" data-agent-id="${escapeHtml(device.ip)}" data-tooltip="Remove machine">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12"/><path d="M5.5 4V2.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V4"/><path d="M12.5 4v9a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 13V4"/></svg>
          </button>
        </div>
        ${metricsHtml}
      </div>
    `;
  }

  let html = '';

  if (fleetEmpty) {
    // Empty fleet — show prominent "Add Machine" as the default view
    html += `<div style="text-align:center;padding:12px 8px 4px;">
      <div style="color:rgba(255,255,255,0.4);font-size:11px;margin-bottom:10px;">No machines connected</div>
      <button class="add-machine-fleet-btn" style="width:100%;padding:8px 12px;background:#4ec9b0;border:none;color:#0a0a1a;border-radius:4px;cursor:pointer;font-family:monospace;font-size:12px;font-weight:600;transition:opacity 0.15s;">+ Add Machine</button>
    </div>`;
  } else {
    for (const device of active) {
      html += renderDeviceCard(device, !PHONE_OS.has(device.os));
    }

    if (inactive.length > 0) {
      html += '<div class="hud-section-sep"></div>';
      for (const device of inactive) {
        html += renderDeviceCard(device, !PHONE_OS.has(device.os));
      }
    }

    // Add "Add Machine" button at the bottom of the Machines HUD
    html += `<button class="add-machine-fleet-btn" style="width:100%;margin-top:8px;padding:6px;background:transparent;border:1px solid #4ec9b0;color:#4ec9b0;border-radius:4px;cursor:pointer;font-family:monospace;font-size:11px;transition:background 0.15s,color 0.15s;">+ Add Machine</button>`;
  }

  content.innerHTML = html;

  const addBtn = content.querySelector('.add-machine-fleet-btn');
  if (addBtn) {
    addBtn.addEventListener('click', showAddMachineDialog);
    // Apply pulse animation if no agents are online
    if (window.__pulseAddMachine) addBtn.classList.add('pulsing');
    if (fleetEmpty) {
      // Filled button style for empty fleet
      addBtn.addEventListener('mouseenter', () => { addBtn.style.opacity = '0.8'; });
      addBtn.addEventListener('mouseleave', () => { addBtn.style.opacity = '1'; });
    } else {
      // Outline button style when devices exist
      addBtn.addEventListener('mouseenter', () => { addBtn.style.background = '#4ec9b0'; addBtn.style.color = '#0a0a1a'; });
      addBtn.addEventListener('mouseleave', () => { addBtn.style.background = 'transparent'; addBtn.style.color = '#4ec9b0'; });
    }
  }

  // Device color picker — click a device card to show swatches
  function showSwatchesForCard(card) {
    const deviceName = card.dataset.device;
    const row = document.createElement('div');
    row.className = 'device-color-swatches';
    row.style.cssText = 'display:flex; gap:4px; padding:4px 0 2px 20px; flex-wrap:wrap;';
    DEVICE_COLORS.forEach((c, idx) => {
      const swatch = document.createElement('span');
      swatch.style.cssText = `width:16px; height:16px; border-radius:4px; cursor:pointer; background:${c.bg}; border:2px solid ${c.border}; transition:transform 0.1s;`;
      // Highlight current selection
      const currentIdx = deviceColorOverrides[deviceName];
      if (currentIdx === idx) swatch.style.outline = '2px solid rgba(255,255,255,0.6)';
      swatch.addEventListener('mouseenter', () => { swatch.style.transform = 'scale(1.3)'; });
      swatch.addEventListener('mouseleave', () => { swatch.style.transform = 'scale(1)'; });
      swatch.addEventListener('click', (ev) => {
        ev.stopPropagation();
        deviceColorOverrides[deviceName] = idx;
        savePrefsToCloud({
          hudState: {
            fleet_expanded: hudExpanded,
            agents_expanded: agentsHudExpanded,
            device_colors: deviceColorOverrides,
          }
        });
        renderHud();
        // Re-render pane headers with new device color
        for (const p of _ctx.state.panes) {
          if (p.device === deviceName) {
            const paneEl = document.getElementById(`pane-${p.id}`);
            if (paneEl) _ctx.applyDeviceHeaderColor(paneEl, deviceName);
          }
        }
      });
      row.appendChild(swatch);
    });
    card.appendChild(row);
  }

  // Delete machine buttons
  content.querySelectorAll('.hud-device-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const agentId = btn.dataset.agentId;
      const agentEntry = _ctx.agents.find(a => a.agentId === agentId);
      if (!agentEntry) return;
      const deviceName = agentEntry.displayName || agentEntry.hostname || agentId;

      if (!confirm(`Remove "${deviceName}" and all its panes? This cannot be undone.`)) return;

      try {
        await _ctx.cloudFetch('DELETE', `/api/agents/${agentEntry.agentId}`);

        // Remove all panes belonging to this agent
        const agentPanes = _ctx.state.panes.filter(p => p.agentId === agentEntry.agentId || p.device === deviceName);
        for (const pane of agentPanes) {
          const paneEl = document.getElementById(`pane-${pane.id}`);
          if (paneEl) paneEl.remove();
          // Clean up terminal instances
          const termInfo = _ctx.terminals.get(pane.id);
          if (termInfo) {
            termInfo.xterm.dispose();
            _ctx.terminals.delete(pane.id);
            _ctx.termDeferredBuffers.delete(pane.id);
          }
          // See deletePane: these outlive the terminal otherwise.
          _ctx.claudeTerminalIds.delete(pane.id);
          clearTerminalNotificationState(pane.id);
          // Clean up editor instances
          const editorInfo = _ctx.fileEditors.get(pane.id);
          if (editorInfo) {
            if (editorInfo.monacoEditor) editorInfo.monacoEditor.dispose();
            if (editorInfo.resizeObserver) editorInfo.resizeObserver.disconnect();
            if (editorInfo.refreshInterval) clearInterval(editorInfo.refreshInterval);
            if (editorInfo.labelInterval) clearInterval(editorInfo.labelInterval);
            _ctx.fileEditors.delete(pane.id);
          }
          const noteInfo = _ctx.noteEditors.get(pane.id);
          if (noteInfo) {
            if (noteInfo.monacoEditor) noteInfo.monacoEditor.dispose();
            if (noteInfo.resizeObserver) noteInfo.resizeObserver.disconnect();
            _ctx.noteEditors.delete(pane.id);
          }
          const ggInfo = _ctx.gitGraphPanes.get(pane.id);
          if (ggInfo?.refreshInterval) clearInterval(ggInfo.refreshInterval);
          _ctx.gitGraphPanes.delete(pane.id);
          const bInfo = _ctx.beadsPanes.get(pane.id);
          if (bInfo?.refreshInterval) clearInterval(bInfo.refreshInterval);
          _ctx.beadsPanes.delete(pane.id);
          const fpInfo = _ctx.folderPanes.get(pane.id);
          if (fpInfo?.refreshInterval) clearInterval(fpInfo.refreshInterval);
          _ctx.folderPanes.delete(pane.id);
        }
        _ctx.state.panes = _ctx.state.panes.filter(p => p.agentId !== agentEntry.agentId);

        // Remove agent from local state
        agents = _ctx.agents.filter(a => a.agentId !== agentEntry.agentId);
        hudData.devices = hudData.devices.filter(d => d.ip !== agentId);
        renderHud();
      } catch (err) {
        console.error('[App] Failed to delete machine:', err);
        alert('Failed to remove machine. Please try again.');
      }
    });
  });

  // Double-click device name to rename
  content.querySelectorAll('.hud-device-name').forEach(nameEl => {
    nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const card = nameEl.closest('.hud-device');
      if (!card) return;
      const agentId = card.dataset.agentId;
      const agentEntry = _ctx.agents.find(a => a.agentId === agentId);
      if (!agentEntry) return;

      // Prevent multiple inputs
      if (card.querySelector('.hud-device-name-input')) return;

      const input = document.createElement('input');
      input.className = 'hud-device-name-input';
      input.type = 'text';
      input.value = agentEntry.displayName || agentEntry.hostname || '';
      input.placeholder = agentEntry.hostname || 'Name';
      input.maxLength = 50;
      input.style.cssText = 'background:rgba(255,255,255,0.1);border:1px solid rgba(255,235,150,0.5);color:#fff;font-size:11px;font-family:monospace;padding:1px 4px;border-radius:3px;width:100px;outline:none;';

      nameEl.style.display = 'none';
      nameEl.parentNode.insertBefore(input, nameEl.nextSibling);
      input.focus();
      input.select();

      const commit = async () => {
        const val = input.value.trim();
        input.remove();
        nameEl.style.display = '';

        // If cleared or same as hostname, set to null (revert to hostname)
        const newDisplayName = (val && val !== agentEntry.hostname) ? val : null;
        if (newDisplayName === (agentEntry.displayName || null)) return; // No change

        try {
          await _ctx.cloudFetch('PATCH', `/api/agents/${agentId}`, { displayName: newDisplayName || '' });
          agentEntry.displayName = newDisplayName;
          nameEl.textContent = newDisplayName || agentEntry.hostname || agentId;
          card.dataset.device = nameEl.textContent;
          // Update hudData too
          const hudDevice = hudData.devices.find(d => d.ip === agentId);
          if (hudDevice) hudDevice.name = nameEl.textContent;
        } catch (err) {
          console.error('[App] Failed to rename machine:', err);
        }
      };

      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
        if (ke.key === 'Escape') {
          input.value = agentEntry.displayName || agentEntry.hostname || '';
          input.blur();
        }
        ke.stopPropagation();
      });
      input.addEventListener('mousedown', (me) => me.stopPropagation());
    });
  });

  content.querySelectorAll('.hud-device').forEach(card => {
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      const deviceName = card.dataset.device;
      // Toggle: if swatches already shown, close them
      if (card.querySelector('.device-color-swatches')) {
        deviceSwatchOpenFor = null;
        card.querySelector('.device-color-swatches').remove();
        return;
      }
      // Remove any other open swatches
      content.querySelectorAll('.device-color-swatches').forEach(el => el.remove());
      deviceSwatchOpenFor = deviceName;
      showSwatchesForCard(card);
    });
    // Restore swatches if this card was open before re-render
    if (deviceSwatchOpenFor && card.dataset.device === deviceSwatchOpenFor) {
      showSwatchesForCard(card);
    }
  });

  // Re-apply highlight if mouse is still over a device after re-render
  if (hoveredDeviceName) {
    applyDeviceHighlight();
  }
}

function applyDeviceHighlight() {
  if (!hoveredDeviceName) return;
  if (_ctx.getQuickViewActive()) return; // QV already has its own overlays
  const localDevice = hudData.devices.find(d => d.isLocal)?.name;
  const deviceColor = _ctx.getDeviceColor(hoveredDeviceName);
  const rgb = deviceColor ? deviceColor.rgb : '96,165,250';

  _ctx.setDeviceHoverActive(true);

  document.querySelectorAll('.pane').forEach(paneEl => {
    const paneData = _ctx.state.panes.find(p => p.id === paneEl.dataset.paneId);
    if (!paneData) return;

    // Add QV-style overlay with device/path/icon info
    _ctx.addQuickViewOverlay(paneEl, paneData);

    // Highlight panes matching the hovered device with device color
    if (paneData.type !== 'note') {
      const paneDevice = paneData.device || localDevice;
      if (paneDevice === hoveredDeviceName) {
        paneEl.classList.add('device-highlighted');
        paneEl.style.boxShadow = `0 0 20px rgba(${rgb},0.4), 0 0 50px rgba(${rgb},0.15), inset 0 0 20px rgba(${rgb},0.08)`;
        paneEl.style.borderColor = `rgba(${rgb},0.5)`;
      }
    }
  });

  // Remove focused state like QV does
  document.querySelectorAll('.pane.focused').forEach(p => p.classList.remove('focused'));
}

export function clearDeviceHighlight() {
  _ctx.setDeviceHoverActive(false);
  // Only remove overlays if QV isn't also active (they share the same overlay class)
  if (!_ctx.getQuickViewActive()) {
    document.querySelectorAll('.quick-view-overlay').forEach(o => o.remove());
    document.querySelectorAll('.pane.qv-hover').forEach(p => p.classList.remove('qv-hover'));
  }
  document.querySelectorAll('.pane').forEach(paneEl => {
    paneEl.classList.remove('device-highlighted', 'device-dimmed');
    paneEl.style.boxShadow = '';
    paneEl.style.borderColor = '';
  });
}

// === Agents HUD ===
export function createAgentsHud(container) {
  const hud = document.createElement('div');
  hud.id = 'agents-hud';
  if (!agentsHudExpanded) hud.classList.add('collapsed');
  hud.innerHTML = `
    <div class="hud-header agents-hud-header">
      <span class="hud-title">Usage</span>
      <span class="agents-hud-pct" id="agents-hud-pct"></span>
      <button id="agents-usage-refresh" title="Refresh usage" style="background:none;border:none;color:#6a6a8a;cursor:pointer;padding:0 2px;line-height:1;font-size:13px;margin-left:4px;opacity:0.7;transition:opacity 0.15s;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.7">&#x21bb;</button>
    </div>
    <div class="agents-hud-content"></div>
  `;
  container.appendChild(hud);

  hud.addEventListener('click', (e) => {
    if (e.target.closest('input, button, a, select, textarea')) return;
    agentsHudExpanded = !agentsHudExpanded;
    hud.classList.toggle('collapsed', !agentsHudExpanded);
    savePrefsToCloud({
      hudState: {
        fleet_expanded: hudExpanded,
        agents_expanded: agentsHudExpanded,
      }
    });
    renderAgentsHud();
  });

  hud.querySelector('#agents-usage-refresh').addEventListener('click', (e) => {
    e.stopPropagation();
    fetchAgentsUsage(true);
  });

  // Polling starts when first agent comes online (see updateAgentsHud)
}

// === Chat HUD ===
export function createChatHud(container) {
  const CHAT_MAX_LENGTH = 3000;
  const CHAT_WARN_THRESHOLD = 2500;
  let chatLastSentAt = 0;
  let chatUnreadCount = 0;
  let chatMessagesLoaded = false;

  const hud = document.createElement('div');
  hud.id = 'feedback-hud';
  if (!feedbackHudExpanded) hud.classList.add('collapsed');
  hud.innerHTML = `
    <div class="hud-header chat-hud-header">
      <span class="hud-title">Feedback</span>
      <span class="chat-unread-badge" style="display:none;"></span>
    </div>
    <div class="chat-hud-content">
      <div class="chat-messages"></div>
      <div class="chat-input-area">
        <textarea class="chat-textarea" rows="2" maxlength="3000" placeholder="shift + enter to send"></textarea>
        <div class="chat-input-footer">
          <span class="chat-char-count"></span>
          <span class="chat-status"></span>
          <button class="chat-send-btn">Send</button>
        </div>
      </div>
    </div>
  `;
  container.appendChild(hud);

  const msgList = hud.querySelector('.chat-messages');
  const textarea = hud.querySelector('.chat-textarea');
  const sendBtn = hud.querySelector('.chat-send-btn');
  const statusEl = hud.querySelector('.chat-status');
  const charCountEl = hud.querySelector('.chat-char-count');
  const unreadBadge = hud.querySelector('.chat-unread-badge');

  // Restore draft
  const savedDraft = localStorage.getItem('tc_feedback_draft');
  if (savedDraft) textarea.value = savedDraft.substring(0, CHAT_MAX_LENGTH);

  function updateCharCount() {
    const len = textarea.value.length;
    if (len >= CHAT_WARN_THRESHOLD) {
      charCountEl.textContent = `${len} / ${CHAT_MAX_LENGTH}`;
      charCountEl.style.display = '';
    } else {
      charCountEl.textContent = '';
      charCountEl.style.display = 'none';
    }
  }

  function updateBadge() {
    if (chatUnreadCount > 0) {
      unreadBadge.textContent = chatUnreadCount > 99 ? '99+' : chatUnreadCount;
      unreadBadge.style.display = '';
    } else {
      unreadBadge.style.display = 'none';
    }
  }

  function formatTime(dateStr) {
    const d = new Date(dateStr + 'Z');
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function appendMessage(msg) {
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble ' + (msg.sender === 'admin' ? 'admin' : 'user');
    bubble.innerHTML = `
      <div class="chat-bubble-body">${escapeHtml(msg.body)}</div>
      <div class="chat-bubble-time">${formatTime(msg.created_at)}</div>
    `;
    msgList.appendChild(bubble);
  }

  async function loadMessages() {
    try {
      const data = await _ctx.cloudFetch('GET', '/api/messages');
      msgList.innerHTML = '';
      if (data.messages && data.messages.length > 0) {
        data.messages.forEach(m => appendMessage(m));
        msgList.scrollTop = msgList.scrollHeight;
      } else {
        msgList.innerHTML = '<div class="chat-empty">No messages yet. Say hello!</div>';
      }
      chatUnreadCount = data.unread || 0;
      updateBadge();
      chatMessagesLoaded = true;
      if (chatUnreadCount > 0) {
        _ctx.cloudFetch('POST', '/api/messages/mark-read').then(() => {
          chatUnreadCount = 0;
          updateBadge();
        }).catch(() => {});
      }
    } catch (e) {
      // Feedback routes not available (self-hosted without extensions)
      console.warn('[chat] Messages not available:', e.message);
    }
  }

  async function sendMessage() {
    const message = textarea.value.trim();
    if (!message) return;
    const now = Date.now();
    if (now - chatLastSentAt < 10000) {
      statusEl.textContent = 'Wait 10s';
      statusEl.className = 'chat-status error';
      return;
    }
    sendBtn.disabled = true;
    statusEl.textContent = '';
    statusEl.className = 'chat-status';
    try {
      const resp = await _ctx.cloudFetch('POST', '/api/messages', { message });
      chatLastSentAt = Date.now();
      textarea.value = '';
      localStorage.removeItem('tc_feedback_draft');
      updateCharCount();
      if (resp.message) {
        const empty = msgList.querySelector('.chat-empty');
        if (empty) empty.remove();
        appendMessage(resp.message);
        msgList.scrollTop = msgList.scrollHeight;
      }
    } catch (e) {
      statusEl.textContent = 'Failed';
      statusEl.className = 'chat-status error';
      setTimeout(() => { statusEl.textContent = ''; }, 2000);
    } finally {
      sendBtn.disabled = false;
    }
  }

  textarea.addEventListener('input', () => {
    if (textarea.value.length > CHAT_MAX_LENGTH) {
      textarea.value = textarea.value.substring(0, CHAT_MAX_LENGTH);
    }
    localStorage.setItem('tc_feedback_draft', textarea.value);
    updateCharCount();
  });

  hud.addEventListener('click', (e) => {
    if (e.target.closest('textarea, button, a, select')) return;
    feedbackHudExpanded = !feedbackHudExpanded;
    hud.classList.toggle('collapsed', !feedbackHudExpanded);
    if (feedbackHudExpanded) {
      textarea.focus();
      loadMessages();
    }
    savePrefsToCloud({
      hudState: {
        fleet_expanded: hudExpanded,
        agents_expanded: agentsHudExpanded,
        feedback_expanded: feedbackHudExpanded,
      }
    });
  });

  sendBtn.addEventListener('click', sendMessage);

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  updateCharCount();

  if (feedbackHudExpanded) {
    loadMessages();
  } else {
    _ctx.cloudFetch('GET', '/api/messages/unread-count').then(data => {
      chatUnreadCount = data.count || 0;
      updateBadge();
    }).catch(() => {});
  }

  window._chatHud = {
    appendMessage,
    loadMessages,
    get isExpanded() { return feedbackHudExpanded; },
    get unreadCount() { return chatUnreadCount; },
    set unreadCount(v) { chatUnreadCount = v; updateBadge(); },
    markRead() {
      _ctx.cloudFetch('POST', '/api/messages/mark-read').then(() => {
        chatUnreadCount = 0;
        updateBadge();
      }).catch(() => {});
    },
    scrollToBottom() { msgList.scrollTop = msgList.scrollHeight; },
  };
}

export async function fetchAgentsUsage(force = false) {
  // Query agents sequentially — stop at first success.
  // (usage data is per-account, so any agent returns the same data; parallel
  // requests against the same OAuth token trigger Anthropic rate limits)
  const onlineAgents = _ctx.agents.filter(a => a.online);
  if (onlineAgents.length === 0) return;
  const path = force ? '/api/usage?force=true' : '/api/usage';
  let lastError = null;
  for (const agent of onlineAgents) {
    try {
      const data = await agentRequest('GET', path, null, agent.agentId);
      if (data) {
        agentsUsageData = data;
        if (!data.stale) agentsUsageLastUpdated = Date.now();
        agentsUsageFetchError = null;
        renderAgentsHud();
        return;
      }
    } catch (e) {
      lastError = e.message || 'Failed to fetch usage';
      console.warn(`[usage] Agent ${agent.agentId.slice(0,8)} failed:`, e.message);
    }
  }
  agentsUsageFetchError = lastError || 'No response from agents';
  console.warn('[usage] All agents failed to return usage data');
  renderAgentsHud();
}

function agentsUsageColorClass(pct) {
  if (pct >= 75) return 'high';
  if (pct >= 40) return 'medium';
  return 'low';
}

function agentsTimeUntil(isoDate) {
  const diff = new Date(isoDate) - Date.now();
  if (diff <= 0) return 'now';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function renderAgentsHud() {
  const hud = document.getElementById('agents-hud');
  if (!hud) return;

  const pctEl = hud.querySelector('#agents-hud-pct');
  const content = hud.querySelector('.agents-hud-content');

  // Header: show shortest-term usage percentage
  if (agentsUsageData && agentsUsageData.five_hour) {
    const pct = agentsUsageData.five_hour.utilization;
    const cls = agentsUsageColorClass(pct);
    if (pctEl) {
      pctEl.textContent = pct + '%';
      pctEl.className = 'agents-hud-pct ' + cls;
    }
  } else if (pctEl) {
    pctEl.textContent = '';
  }

  // Collapsed: no content
  if (!agentsHudExpanded) {
    if (content) content.innerHTML = '';
    return;
  }

  // Expanded: usage bars
  if (!agentsUsageData) {
    content.innerHTML = '<div class="agents-empty">Loading...</div>';
    return;
  }

  let blocks = '';
  function addBlock(periodLabel, data) {
    if (!data) return;
    const pct = data.utilization;
    const cls = agentsUsageColorClass(pct);
    const reset = agentsTimeUntil(data.resets_at);
    blocks += `
      <div class="usage-block">
        <div class="usage-top-row">
          ${RESET_ICON_SVG}
          <span class="usage-reset-time">${reset}</span>
          <span class="usage-pct ${cls}">${pct}%</span>
        </div>
        <div class="usage-bar-track">
          <div class="usage-bar-fill ${cls}" style="width: ${Math.min(pct, 100)}%"></div>
        </div>
        <div class="usage-period">${periodLabel}</div>
      </div>
    `;
  }

  addBlock('5-hour window', agentsUsageData.five_hour);
  addBlock('7-day window', agentsUsageData.seven_day);
  addBlock('7-day sonnet', agentsUsageData.seven_day_sonnet);
  if (agentsUsageData.seven_day_opus) addBlock('7-day opus', agentsUsageData.seven_day_opus);

  // "Last updated" indicator + error state
  if (agentsUsageLastUpdated) {
    const ago = Math.floor((Date.now() - agentsUsageLastUpdated) / 60000);
    const agoText = ago < 1 ? 'just now' : `${ago}m ago`;
    const isStale = ago >= 10;
    const color = isStale ? '#e85' : '#666';
    let updatedLine = `<div class="agents-last-updated" style="text-align:right;font-size:10px;color:${color};margin-top:4px;">Updated ${agoText}`;
    if (agentsUsageData?.stale) {
      updatedLine += ` <span style="color:#e85;" title="Anthropic rate limited — showing cached data">\u00b7 data may be outdated</span>`;
    } else if (agentsUsageFetchError && isStale) {
      updatedLine += ` <span style="color:#e55;">\u00b7 update failed</span>`;
    }
    updatedLine += `</div>`;
    blocks += updatedLine;
  } else if (agentsUsageFetchError) {
    blocks += `<div class="agents-last-updated" style="text-align:right;font-size:10px;color:#e55;margin-top:4px;">Failed to load usage</div>`;
  }

  content.innerHTML = blocks || '<div class="agents-empty">No usage data</div>';
}

// === Terminals HUD ===
export function applyTerminalTheme(themeKey) {
  const theme = TERMINAL_THEMES[themeKey];
  if (!theme) return;
  _ctx.setCurrentTerminalTheme(themeKey);
  // Apply to all existing terminals
  _ctx.terminals.forEach(({ xterm }) => {
    xterm.options.theme = { ...theme };
  });
}


// ============================================================================

// ─── Accessors for state this module owns but others read or write ────────
export function getHudExpanded() { return hudExpanded; }
export function setHudExpanded(v) { hudExpanded = v; }
export function getAgentsHudExpanded() { return agentsHudExpanded; }
export function setAgentsHudExpanded(v) { agentsHudExpanded = v; }
export function getFeedbackHudExpanded() { return feedbackHudExpanded; }
export function setFeedbackHudExpanded(v) { feedbackHudExpanded = v; }
export function getHudHidden() { return hudHidden; }
export function setHudHidden(v) { hudHidden = v; }
export function getFleetPaneHidden() { return fleetPaneHidden; }
export function setFleetPaneHidden(v) { fleetPaneHidden = v; }
export function getAgentsPaneHidden() { return agentsPaneHidden; }
export function setAgentsPaneHidden(v) { agentsPaneHidden = v; }
export function getDeviceColorOverrides() { return deviceColorOverrides; }
export function setDeviceColorOverrides(v) { deviceColorOverrides = v; }
export function getHudData() { return hudData; }
export function setHoveredDeviceName(v) { hoveredDeviceName = v; }

// The 5s HUD re-render and the usage poll are started by app.js during
// init; their timers live here so stopping them stays in one place.
export function startHudRenderTimer() {
  if (hudRenderTimer) clearInterval(hudRenderTimer);
  hudRenderTimer = setInterval(renderHud, 5000);
}
// Idempotent: repeated calls while polling is already running leave the
// existing timers alone rather than resetting their intervals. Returns true
// only when this call actually started polling, so the caller can do its
// one-off initial fetch on that transition.
export function startAgentsUsagePolling() {
  const started = !agentsUsageIntervalId;
  if (started) {
    agentsUsageIntervalId = setInterval(fetchAgentsUsage, 300000);
  }
  if (!agentsUsageAgoIntervalId) {
    agentsUsageAgoIntervalId = setInterval(renderAgentsHud, 60000);
  }
  return started;
}
export function stopAgentsUsagePolling() {
  if (agentsUsageIntervalId) { clearInterval(agentsUsageIntervalId); agentsUsageIntervalId = null; }
  if (agentsUsageAgoIntervalId) { clearInterval(agentsUsageAgoIntervalId); agentsUsageAgoIntervalId = null; }
}
