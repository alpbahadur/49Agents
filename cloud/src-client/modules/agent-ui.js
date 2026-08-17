// ─── Agent UI ─────────────────────────────────────────────────────────────
// Toasts and dialogs around agent lifecycle: relay notifications, the agent
// update toasts, the "Add Machine" install dialog, and the pulse highlight
// that draws attention to the add-machine button when nothing is connected.
//
// This is presentation only. The agents array and the WebSocket live in
// app.js and are reached through the injected context, because both are
// reassigned there and shared with the rest of the app.

import { escapeHtml } from './utils.js';
import { getNotificationContainer } from './notifications.js';

let _ctx = null;

export function initAgentUiDeps(ctx) { _ctx = ctx; }

// Simple notification for relay messages (tier limits, etc.)
export function showRelayNotification(message, type, duration) {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed; top:20px; left:50%; transform:translateX(-50%); z-index:100001; background:${type === 'warning' ? '#b58900' : '#333'}; color:#fff; padding:10px 20px; border-radius:8px; font-size:13px; font-family:inherit; box-shadow:0 4px 20px rgba(0,0,0,0.4); pointer-events:auto;`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => { el.remove(); }, duration || 5000);
}

/**
 * Where a second machine should point its agent.
 *
 * The browser's own origin is the right answer on a hosted relay, but on a
 * self-hosted instance the user is looking at http://localhost — pasting that
 * on another machine tells its agent to connect to itself. The server knows
 * its real address, so it is asked.
 *
 * Returns null outside local mode, meaning "the origin is already correct".
 */
async function fetchLocalReachableHost() {
  if (!isLocalMode()) return null;
  try {
    const res = await fetch('/api/network');
    if (!res.ok) return null;
    const net = await res.json();
    if (!net.lanAddress) return null;
    return { host: `${net.lanAddress}:${net.port}`, loopbackOnly: net.loopbackOnly };
  } catch {
    return null;
  }
}

export async function fetchInstallCommand(hostname, platform = 'linux') {
  const res = await fetch('/api/agents/token', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostname, os: platform === 'windows' ? 'windows' : 'linux' })
  });
  const data = await res.json();
  if (!data.token) throw new Error(data.error || 'Unknown');

  // Self-hosted: substitute the address another machine can actually resolve.
  const reachable = await fetchLocalReachableHost();
  const httpHost = reachable ? reachable.host : location.host;
  const httpOrigin = reachable ? `http://${reachable.host}` : location.origin;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';

  if (platform === 'windows') {
    return `$env:TC_TOKEN="${data.token}"; irm ${httpOrigin}/dl/install.ps1 | iex`;
  }
  return `curl -fsSL ${httpOrigin}/dl/install.sh | TC_TOKEN=${data.token} TC_CLOUD_URL=${proto}//${httpHost} sh`;
}

// --- Agent Update Notification Helpers ---

export function showUpdateToast(agentId, hostname, currentVersion, latestVersion) {
  // Remove any existing update toast for this agent
  const existingToast = document.querySelector(`.update-toast[data-agent-id="${agentId}"]`);
  if (existingToast) existingToast.remove();

  const toast = document.createElement('div');
  toast.className = 'notification-toast update-toast visible';
  toast.dataset.agentId = agentId;
  toast.style.borderLeft = '3px solid #f59e0b';
  toast.innerHTML = `
    <div class="notification-icon" style="color:#f59e0b;">⬆</div>
    <div class="notification-body">
      <div class="notification-title">Update available for ${escapeHtml(hostname)}</div>
      <div class="notification-device">v${escapeHtml(currentVersion)} → v${escapeHtml(latestVersion)}</div>
    </div>
    <button class="update-now-btn" style="background:#f59e0b;color:#000;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-family:monospace;font-size:11px;font-weight:bold;white-space:nowrap;margin-left:8px;">Update</button>
    <button class="notification-dismiss" title="Dismiss">&times;</button>
  `;

  const updateBtn = toast.querySelector('.update-now-btn');
  updateBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    triggerAgentUpdate(agentId);
    updateBtn.textContent = 'Updating...';
    updateBtn.disabled = true;
    updateBtn.style.opacity = '0.6';
  });

  const dismissBtn = toast.querySelector('.notification-dismiss');
  dismissBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toast.classList.add('dismissing');
    setTimeout(() => toast.remove(), 300);
  });

  if (getNotificationContainer()) {
    getNotificationContainer().prepend(toast);
  }
}

export function showUpdateProgressToast(agentId, hostname, status) {
  const existingToast = document.querySelector(`.update-toast[data-agent-id="${agentId}"]`);
  const statusText = {
    downloading: 'Downloading update...',
    installing: 'Installing update...',
    restarting: 'Restarting agent...',
    failed: 'Update failed!',
  }[status] || status;

  if (existingToast) {
    const titleEl = existingToast.querySelector('.notification-title');
    const deviceEl = existingToast.querySelector('.notification-device');
    if (titleEl) titleEl.textContent = `${hostname}: ${statusText}`;
    if (deviceEl) deviceEl.textContent = status === 'failed' ? 'Please try again later' : '';
    const btn = existingToast.querySelector('.update-now-btn');
    if (btn) btn.style.display = 'none';
    if (status === 'failed') {
      existingToast.style.borderLeftColor = '#ef4444';
      const icon = existingToast.querySelector('.notification-icon');
      if (icon) { icon.textContent = '✗'; icon.style.color = '#ef4444'; }
      setTimeout(() => {
        existingToast.classList.add('dismissing');
        setTimeout(() => existingToast.remove(), 300);
      }, 5000);
    }
  }
}

export function showUpdateCompleteToast(agentId, hostname, newVersion) {
  // Remove progress toast
  const existingToast = document.querySelector(`.update-toast[data-agent-id="${agentId}"]`);
  if (existingToast) existingToast.remove();

  const toast = document.createElement('div');
  toast.className = 'notification-toast update-toast visible';
  toast.dataset.agentId = agentId;
  toast.style.borderLeft = '3px solid #10b981';
  toast.innerHTML = `
    <div class="notification-icon" style="color:#10b981;">✓</div>
    <div class="notification-body">
      <div class="notification-title">${escapeHtml(hostname)} updated</div>
      <div class="notification-device">Now running v${escapeHtml(newVersion)}</div>
    </div>
    <button class="notification-dismiss" title="Dismiss">&times;</button>
  `;

  const dismissBtn = toast.querySelector('.notification-dismiss');
  dismissBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toast.classList.add('dismissing');
    setTimeout(() => toast.remove(), 300);
  });

  if (getNotificationContainer()) {
    getNotificationContainer().prepend(toast);
  }

  // Auto-dismiss after 8 seconds
  setTimeout(() => {
    if (toast.parentNode) {
      toast.classList.add('dismissing');
      setTimeout(() => toast.remove(), 300);
    }
  }, 8000);
}

export function triggerAgentUpdate(agentId) {
  const ws = _ctx.getWs();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'update:install',
      agentId,
      payload: {},
    }));
  }
}

// "Connect a Machine" overlay
export function updateAgentOverlay() {
  let overlay = document.getElementById('agent-connect-overlay');
  const hasOnlineAgents = _ctx.getAgents().some(a => a.online);

  // Suppress overlay when tutorial hasn't been completed (user will be redirected)
  const tutorialState = localStorage.getItem('tc_tutorial');
  if (!hasOnlineAgents && !tutorialState && !_ctx.getTutorialsCompleted()['getting-started']) {
    if (overlay) overlay.style.display = 'none';
    return;
  }

  if (!hasOnlineAgents) {
    if (overlay) overlay.style.display = 'none';
    // A self-hosted instance starts its own agent — ./49ctl start and the
    // desktop app both launch one, and it authenticates without a token.
    // Telling that user to "Add Machine" sends them to install software they
    // are already running; the agent is simply still connecting. Pulsing the
    // button is only useful where a machine genuinely has to be paired.
    if (isLocalMode()) {
      pulseAddMachineButton(false);
      showLocalAgentStatus(true);
    } else {
      pulseAddMachineButton(true);
    }
  } else {
    if (overlay) {
      overlay.style.display = 'none';
    }
    pulseAddMachineButton(false);
    showLocalAgentStatus(false);
  }
}

/**
 * Whether this instance is self-hosted.
 *
 * Populated by the early /api/auth/mode fetch in app.js. Undefined until that
 * resolves, and the safe reading of "unknown" is cloud: a hosted user who
 * briefly loses the pulse is worse off than a local user who briefly sees it.
 */
export function isLocalMode() {
  return window.__tcAuthMode === 'local';
}

/**
 * A quiet line in the machines panel while the local agent connects, in place
 * of the add-machine nag. Says what is happening rather than asking for
 * something the user has already done.
 *
 * A flag rather than a DOM edit: renderHud() replaces the panel's innerHTML on
 * every poll, so anything appended from here is wiped within the second. Same
 * reason __pulseAddMachine works the way it does.
 */
function showLocalAgentStatus(waiting) {
  window.__localAgentStarting = waiting;
  // renderHud() is not called from here: hud.js already imports this module,
  // and the panel re-renders on its own poll, so the flag is picked up without
  // adding a second edge to the cycle.
  const el = document.querySelector('#hud-overlay .local-agent-status');
  if (!waiting && el) el.remove();
}

// Inject pulse animation style once
let pulseStyleInjected = false;
function injectPulseStyle() {
  if (pulseStyleInjected) return;
  pulseStyleInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    @keyframes addMachinePulse {
      0% { box-shadow: 0 0 4px rgba(78, 201, 176, 0.4), 0 0 8px rgba(78, 201, 176, 0.2); }
      50% { box-shadow: 0 0 12px rgba(78, 201, 176, 0.7), 0 0 24px rgba(78, 201, 176, 0.3); }
      100% { box-shadow: 0 0 4px rgba(78, 201, 176, 0.4), 0 0 8px rgba(78, 201, 176, 0.2); }
    }
    .add-machine-fleet-btn.pulsing {
      animation: addMachinePulse 2s ease-in-out infinite !important;
      background: #4ec9b0 !important;
      border: 1px solid rgba(78, 201, 176, 0.6) !important;
      font-weight: 700 !important;
      transform: scale(1.02);
      transition: transform 0.2s ease;
    }
    .add-machine-fleet-btn.pulsing:hover {
      transform: scale(1.06);
      animation: none !important;
      box-shadow: 0 0 16px rgba(78, 201, 176, 0.8), 0 0 32px rgba(78, 201, 176, 0.4) !important;
    }
  `;
  document.head.appendChild(style);
}

export function pulseAddMachineButton(enable) {
  if (enable) injectPulseStyle();
  // The HUD fleet button gets re-rendered, so we set a flag and apply in renderHud
  window.__pulseAddMachine = enable;
  // Also apply immediately if the button exists
  const btn = document.querySelector('.add-machine-fleet-btn');
  if (btn) {
    if (enable) btn.classList.add('pulsing');
    else btn.classList.remove('pulsing');
  }
}

// Show "Add Machine" dialog (can be called from HUD even when agents are connected)
export function showAddMachineDialog() {
  // Reuse the overlay logic but force-show it
  let overlay = document.getElementById('add-machine-overlay');
  if (overlay) { overlay.remove(); }

  overlay = document.createElement('div');
  overlay.id = 'add-machine-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:100000;';

  const card = document.createElement('div');
  card.style.cssText = 'background:#1a1a2e;border:1px solid #4ec9b0;border-radius:12px;padding:32px;max-width:560px;width:90%;color:#e0e0e0;font-family:monospace;';
  card.innerHTML = `
    <h3 style="margin:0 0 12px;color:#4ec9b0;">Add Machine</h3>
    <p style="opacity:0.8;margin:0 0 10px;line-height:1.6;">
      Run a second agent on <em>another</em> computer — a desktop, a server, a VM — and its
      terminals, editors and git graphs appear on this same canvas, labelled with that
      machine's name. Each machine runs its own agent; you drive them all from here.
    </p>
    <p style="opacity:0.55;margin:0 0 16px;font-size:12px;line-height:1.6;">
      Paste the command below into a terminal <strong>on that machine</strong>. It installs the
      agent and connects it. Nothing needs installing on the machine you are reading this on.
    </p>
    <div id="add-machine-reach" style="display:none;margin:0 0 16px;padding:10px 12px;border-radius:6px;font-size:12px;line-height:1.6;"></div>
    <div style="margin-bottom:12px;">
      <label style="display:block;margin-bottom:4px;opacity:0.6;font-size:12px;">Platform</label>
      <div id="add-machine-platform" style="display:flex;gap:0;margin-bottom:12px;">
        <button data-platform="linux" style="flex:1;padding:8px;background:#4ec9b0;color:#0a0a1a;border:1px solid #4ec9b0;border-radius:4px 0 0 4px;cursor:pointer;font-family:monospace;font-size:12px;font-weight:bold;">Linux / macOS</button>
        <button data-platform="windows" style="flex:1;padding:8px;background:transparent;color:#6a6a8a;border:1px solid #333;border-radius:0 4px 4px 0;cursor:pointer;font-family:monospace;font-size:12px;">Windows (WSL2)</button>
      </div>
    </div>
    <div id="add-machine-cmd-box" style="margin-bottom:12px;">
      <label style="display:block;margin-bottom:4px;opacity:0.6;font-size:12px;">Install Command</label>
      <code id="add-machine-cmd" style="display:block;padding:12px;background:#0a0a1a;border-radius:6px;word-break:break-all;font-size:11px;cursor:pointer;user-select:all;border:1px solid #333;opacity:0.5;">Generating...</code>
    </div>
    <div style="display:flex;gap:12px;">
      <button id="add-machine-copy" style="background:transparent;color:#4ec9b0;border:1px solid #4ec9b0;padding:10px 24px;border-radius:6px;cursor:pointer;font-family:monospace;display:none;">Copy</button>
      <button id="add-machine-close" style="background:transparent;color:#6a6a8a;border:1px solid #6a6a8a;padding:10px 24px;border-radius:6px;cursor:pointer;font-family:monospace;margin-left:auto;">Close</button>
    </div>
  `;
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const copyBtn = document.getElementById('add-machine-copy');
  const closeBtn = document.getElementById('add-machine-close');

  copyBtn.style.transition = 'background 0.15s, color 0.15s, transform 0.1s';
  copyBtn.addEventListener('mouseenter', () => { copyBtn.style.background = '#4ec9b0'; copyBtn.style.color = '#0a0a1a'; copyBtn.style.transform = 'scale(1.03)'; });
  copyBtn.addEventListener('mouseleave', () => {
    if (!copyBtn.dataset.copied) { copyBtn.style.background = 'transparent'; copyBtn.style.color = '#4ec9b0'; }
    copyBtn.style.transform = '';
  });

  closeBtn.style.transition = 'background 0.15s, color 0.15s, transform 0.1s';
  closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = '#6a6a8a'; closeBtn.style.color = '#0a0a1a'; closeBtn.style.transform = 'scale(1.03)'; });
  closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = 'transparent'; closeBtn.style.color = '#6a6a8a'; closeBtn.style.transform = ''; });

  closeBtn.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  // Self-hosted instances need a word about reachability before the command is
  // any use: the default bind is loopback, so another machine cannot connect
  // until the user opts into a LAN bind. Saying that up front beats handing
  // them a command that silently fails.
  if (isLocalMode()) {
    fetch('/api/network')
      .then(r => r.ok ? r.json() : null)
      .then(net => {
        const box = document.getElementById('add-machine-reach');
        if (!net || !box) return;

        if (net.loopbackOnly) {
          box.style.display = 'block';
          box.style.background = 'rgba(181, 137, 0, 0.12)';
          box.style.border = '1px solid rgba(181, 137, 0, 0.5)';
          box.style.color = '#e8c46a';
          box.innerHTML =
            `This server is only listening on this machine, so another computer cannot reach it yet.<br><br>` +
            `Restart it with <code style="color:#fff;">HOST=0.0.0.0 ./49ctl start</code> — on a network you trust — ` +
            `then reopen this dialog. Anyone who can reach the port can run commands on your machines, so avoid public Wi-Fi.`;
        } else if (net.lanAddress) {
          box.style.display = 'block';
          box.style.background = 'rgba(78, 201, 176, 0.08)';
          box.style.border = '1px solid rgba(78, 201, 176, 0.35)';
          box.style.color = '#9fdcd0';
          box.innerHTML =
            `The other machine must be able to reach <code style="color:#fff;">${net.lanAddress}:${net.port}</code> — ` +
            `same network, VPN, or Tailscale. The command below already points there.`;
        }
      })
      .catch(() => {});
  }

  // Platform toggle
  let selectedPlatform = 'linux';
  async function dialogGenerateCmd() {
    const cmdEl = document.getElementById('add-machine-cmd');
    cmdEl.textContent = 'Generating...';
    cmdEl.style.opacity = '0.5';
    copyBtn.style.display = 'none';
    try {
      const hostname = 'machine-' + Date.now().toString(36);
      const cmd = await fetchInstallCommand(hostname, selectedPlatform);
      cmdEl.textContent = cmd;
      cmdEl.style.opacity = '1';
      copyBtn.style.display = 'inline-block';
    } catch (e) {
      cmdEl.textContent = 'Error: ' + (e.message || 'try again');
      cmdEl.style.opacity = '1';
    }
  }

  const platformBtns = document.querySelectorAll('#add-machine-platform button');
  platformBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      selectedPlatform = btn.dataset.platform;
      platformBtns.forEach(b => {
        if (b.dataset.platform === selectedPlatform) {
          b.style.background = '#4ec9b0'; b.style.color = '#0a0a1a'; b.style.borderColor = '#4ec9b0'; b.style.fontWeight = 'bold';
        } else {
          b.style.background = 'transparent'; b.style.color = '#6a6a8a'; b.style.borderColor = '#333'; b.style.fontWeight = 'normal';
        }
      });
      dialogGenerateCmd();
    });
  });

  // Auto-generate immediately
  dialogGenerateCmd();

  copyBtn.addEventListener('click', () => {
    const cmd = document.getElementById('add-machine-cmd').textContent;
    navigator.clipboard.writeText(cmd).then(() => {
      copyBtn.dataset.copied = '1';
      copyBtn.textContent = 'Copied!';
      copyBtn.style.background = '#10b981';
      copyBtn.style.color = '#fff';
      copyBtn.style.borderColor = '#10b981';
      copyBtn.style.transform = 'scale(1.08)';
      setTimeout(() => { copyBtn.style.transform = ''; }, 150);
      setTimeout(() => {
        delete copyBtn.dataset.copied;
        copyBtn.textContent = 'Copy';
        copyBtn.style.background = 'transparent';
        copyBtn.style.color = '#4ec9b0';
        copyBtn.style.borderColor = '#4ec9b0';
      }, 2000);
    });
  });
}
