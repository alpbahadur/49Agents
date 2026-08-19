// ─── Claude State Tracking ────────────────────────────────────────────────
// Applies the agent's Claude state push to the canvas: the per-pane status
// class that drives the border colour, the session name badge, and the set
// of terminals currently known to be running Claude.

import { handleStateTransition, updateTabTitleBadge, dismissToast, getIsFirstClaudeStateUpdate, setIsFirstClaudeStateUpdate, previousClaudeStates, notifiedStates } from './notifications.js';
import { formatLocationPath } from './utils.js';
import { CLAUDE_LOGO_SVG, CLAUDE_STATE_SVGS } from './constants.js';
import { cloudSaveLayout } from './cloud.js';
import { deviceLabelHtml, beadsTagHtml, claudeSessionBadgeHtml } from './terminal-lifecycle.js';

let _ctx = null;

export function initClaudeStatesDeps(ctx) { _ctx = ctx; }

export function updateClaudeStates(states) {
  if (getIsFirstClaudeStateUpdate()) {
    // On first load, show notifications for existing permission/question states
    // Sort: questions/inputNeeded first, permissions last (prepend = last added lands on top)
    const entries = Object.entries(states).filter(([, i]) => i.isClaude &&
      (i.state === 'permission' || i.state === 'question' || i.state === 'inputNeeded'));
    entries.sort((a, b) => {
      const rank = s => s === 'permission' ? 1 : 0;
      return rank(a[1].state) - rank(b[1].state);
    });
    for (const [terminalId, info] of entries) {
      handleStateTransition(terminalId, 'working', info.state, info);
    }
  } else {
    // Detect state transitions and fire notifications
    for (const [terminalId, info] of Object.entries(states)) {
      if (!info.isClaude) continue;
      const prevState = previousClaudeStates.get(terminalId);
      const newState = info.state;

      if (prevState !== newState) {
        // Skip done notifications for terminals first appearing as already idle
        if (!prevState && newState === 'idle') continue;
        // Treat newly-seen terminals as transitioning from 'working'
        // so sounds fire when a terminal first appears in a notifiable state
        handleStateTransition(terminalId, prevState || 'working', newState, info);
      }

      // If state changed away from a notified state, clear dedup + auto-dismiss toast
      if (notifiedStates.has(terminalId) && notifiedStates.get(terminalId) !== newState) {
        notifiedStates.delete(terminalId);
        dismissToast(terminalId);
      }
    }
  }
  setIsFirstClaudeStateUpdate(false);

  // Track current states for next comparison
  for (const [terminalId, info] of Object.entries(states)) {
    if (info.isClaude) {
      previousClaudeStates.set(terminalId, info.state);
    }
  }

  // Update tab title badge
  updateTabTitleBadge(states);

  // Update DOM (original logic)
  for (const [terminalId, info] of Object.entries(states)) {
    // Track alternate screen state from tmux (authoritative source)
    const termInfo = _ctx.terminals.get(terminalId);
    if (termInfo && info) {
      termInfo._alternateOn = !!info.alternateOn;
      // Needed to route scrolls: an attached tmux client is on the alternate
      // screen like any TUI, but arrow keys reach its shell rather than
      // scrolling anything.
      termInfo._foregroundCommand = info.command || null;
    }
    // Track claude terminals for HUD counts
    if (info && info.isClaude) _ctx.claudeTerminalIds.add(terminalId);
    else _ctx.claudeTerminalIds.delete(terminalId);
    const paneEl = document.getElementById(`pane-${terminalId}`);
    const titleEl = paneEl?.querySelector('.pane-title');
    const paneData = _ctx.state.panes.find(p => p.id === terminalId);

    // Update paneData.workingDir from live tmux cwd
    if (paneData && info && info.cwd) {
      paneData.workingDir = info.cwd;
    }
    // Update Claude session ID/name and persist to cloud when they change
    if (paneData && info && info.claudeSessionId) {
      const idChanged = paneData.claudeSessionId !== info.claudeSessionId;
      const nameChanged = info.claudeSessionName && paneData.claudeSessionName !== info.claudeSessionName;
      paneData.claudeSessionId = info.claudeSessionId;
      if (info.claudeSessionName) paneData.claudeSessionName = info.claudeSessionName;
      if (idChanged || nameChanged) cloudSaveLayout(paneData);
    }

    if (paneEl && titleEl && info) {
      paneEl.classList.remove('claude-working', 'claude-idle', 'claude-permission', 'claude-question', 'claude-input-needed');

      const deviceLabel = paneData?.device ? deviceLabelHtml(paneData.device) : '';
      const beadsTag = beadsTagHtml(paneData?.beadsTag);

      // Skip title update if user is editing a beads tag
      const isEditingBeadsTag = paneEl.querySelector('.beads-tag-input');

      if (info.isClaude) {
        const stateClassMap = {
          working: 'claude-working',
          idle: 'claude-idle',
          permission: 'claude-permission',
          question: 'claude-question',
          inputNeeded: 'claude-input-needed'
        };
        if (stateClassMap[info.state]) {
          paneEl.classList.add(stateClassMap[info.state]);
        }

        const stateIndicators = CLAUDE_STATE_SVGS;
        const stateHtml = stateIndicators[info.state] || '';
        const locationHtml = info.location ? formatLocationPath(info.location.name) : '';
        const sessionBadge = claudeSessionBadgeHtml(info.claudeSessionId, info.claudeSessionName);

        if (!isEditingBeadsTag) {
          titleEl.innerHTML = `
            <span class="claude-header">
              ${deviceLabel}
              ${beadsTag}
              ${sessionBadge}
              ${sessionBadge ? '' : CLAUDE_LOGO_SVG}
              ${stateHtml}
              <span class="claude-location">${locationHtml}</span>
            </span>
          `;
        }
      } else {
        if (!isEditingBeadsTag) {
          titleEl.innerHTML = `${deviceLabel}${beadsTag}<span style="opacity:0.7;">Terminal</span>`;
        }
      }
    }
  }
}

