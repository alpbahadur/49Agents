// ─── Notification System ──────────────────────────────────────────────────
// Toast notifications, snooze/escalation, browser notifications, tab title badge.
// Manages notification state independently; receives callbacks for external actions.

import { escapeHtml } from './utils.js';
import { playNotificationSound, playDismissSound } from './sounds.js';

let _ctx = null;

export function initNotificationDeps(ctx) { _ctx = ctx; }

// ── State ──
const previousClaudeStates = new Map();
const notifiedStates = new Map();
let isFirstClaudeStateUpdate = true;
let notificationContainer = null;
const activeToasts = new Map();
const snoozedNotifications = new Map();
const snoozeCount = new Map();
const originalTitle = '49Agents';

// These are read from the IIFE via ctx
function getSnoozeDurationMs() { return _ctx.getSnoozeDurationMs(); }
function getAutoRemoveDoneNotifs() { return _ctx.getAutoRemoveDoneNotifs(); }

// Expose for updateClaudeStates (still in app.js)
export { previousClaudeStates, notifiedStates, activeToasts, snoozedNotifications, snoozeCount };

/**
 * Forget every per-terminal notification record for a closed pane.
 *
 * These maps are keyed by terminal id and were only ever pruned on a state
 * transition, which a closed terminal never produces again — so each open and
 * close cycle left entries behind for the lifetime of the tab. The entries are
 * small, but the growth is unbounded across a long session.
 *
 * snoozeCount is keyed `terminalId:state`, so it needs a prefix sweep rather
 * than a single delete.
 */
export function clearTerminalNotificationState(terminalId) {
  previousClaudeStates.delete(terminalId);
  notifiedStates.delete(terminalId);
  snoozedNotifications.delete(terminalId);
  const prefix = `${terminalId}:`;
  for (const key of snoozeCount.keys()) {
    if (key.startsWith(prefix)) snoozeCount.delete(key);
  }
}
export function getNotificationContainer() { return notificationContainer; }
export function getIsFirstClaudeStateUpdate() { return isFirstClaudeStateUpdate; }
export function setIsFirstClaudeStateUpdate(val) { isFirstClaudeStateUpdate = val; }

// ── Init ──

export function initNotifications() {
  notificationContainer = document.createElement('div');
  notificationContainer.id = 'notification-container';
  document.body.appendChild(notificationContainer);

  setInterval(checkSnoozedNotifications, 10000);
  setInterval(checkActiveNotifications, 5000);
}

// ── Toast ──

export function showToast(terminalId, title, deviceName, locationName, icon, priority, claudeState, info = null) {
  dismissToast(terminalId);
  snoozedNotifications.delete(terminalId);

  const toast = document.createElement('div');
  toast.className = `notification-toast state-${claudeState || 'idle'}`;
  toast.dataset.terminalId = terminalId;
  toast.dataset.claudeState = claudeState || 'idle';

  const isHighPriority = priority === 'high';
  const actionButton = isHighPriority
    ? `<button class="notification-snooze" data-tooltip="Snooze for 3 minutes">\uD83D\uDD50</button>`
    : `<button class="notification-dismiss" data-tooltip="Dismiss">&times;</button>`;

  toast.innerHTML = `
    <div class="notification-icon">${icon}</div>
    <div class="notification-body">
      <div class="notification-title">${escapeHtml(title)}</div>
      ${deviceName ? `<div class="notification-device">${escapeHtml(deviceName)}</div>` : ''}
      ${locationName ? `<div class="notification-path">${escapeHtml(locationName)}</div>` : ''}
    </div>
    ${actionButton}
  `;

  toast._notificationInfo = { title, deviceName, locationName, icon, priority, claudeState, info };

  if (!localStorage.getItem('hasSeenToastTooltip')) {
    const onFirstHover = () => {
      toast.removeEventListener('mouseenter', onFirstHover);
      const tip = document.createElement('div');
      tip.className = 'toast-tooltip';
      tip.textContent = isHighPriority ? 'Right-click to snooze' : 'Right-click to dismiss';
      toast.appendChild(tip);
      requestAnimationFrame(() => tip.classList.add('visible'));
      setTimeout(() => { tip.classList.remove('visible'); setTimeout(() => tip.remove(), 200); }, 3000);
      localStorage.setItem('hasSeenToastTooltip', '1');
    };
    toast.addEventListener('mouseenter', onFirstHover);
  }

  toast.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const isDone = toast._notificationInfo.claudeState === 'idle';
    if (isDone) {
      dismissToast(terminalId);
    } else {
      snoozeNotification(terminalId, toast._notificationInfo);
    }
  });

  toast.addEventListener('click', (e) => {
    if (e.target.closest('.notification-dismiss') || e.target.closest('.notification-snooze')) return;
    _ctx.panToPane(terminalId);
  });

  const snoozeBtn = toast.querySelector('.notification-snooze');
  if (snoozeBtn) {
    snoozeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      snoozeNotification(terminalId, toast._notificationInfo);
    });
  }

  const dismissBtn = toast.querySelector('.notification-dismiss');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissToast(terminalId);
    });
  }

  notificationContainer.prepend(toast);
  activeToasts.set(terminalId, toast);

  requestAnimationFrame(() => toast.classList.add('visible'));

  if (priority === 'medium' && getAutoRemoveDoneNotifs()) {
    toast._autoDismissTimer = setTimeout(() => dismissToast(terminalId), 15000);
  }

  const allToasts = notificationContainer.querySelectorAll('.notification-toast');
  if (allToasts.length > 8) {
    for (let i = 8; i < allToasts.length; i++) {
      const old = allToasts[i];
      if (old.dataset.terminalId) activeToasts.delete(old.dataset.terminalId);
      old.remove();
    }
  }
}

// ── Snooze ──

export function snoozeNotification(terminalId, notificationInfo) {
  const toast = activeToasts.get(terminalId);
  if (toast) {
    toast.classList.add('dismissing');
    activeToasts.delete(terminalId);
    setTimeout(() => toast.remove(), 200);
  }

  const key = `${terminalId}:${notificationInfo.claudeState}`;
  snoozeCount.set(key, (snoozeCount.get(key) || 0) + 1);

  snoozedNotifications.set(terminalId, {
    snoozeUntil: Date.now() + getSnoozeDurationMs(),
    ...notificationInfo,
  });
}

function checkSnoozedNotifications() {
  const now = Date.now();
  for (const [terminalId, snoozed] of snoozedNotifications) {
    if (now >= snoozed.snoozeUntil) {
      snoozedNotifications.delete(terminalId);

      const currentState = previousClaudeStates.get(terminalId);
      const stateStillNeedsAttention =
        currentState === undefined ||
        currentState === snoozed.claudeState;

      if (stateStillNeedsAttention) {
        const key = `${terminalId}:${snoozed.claudeState}`;
        const count = snoozeCount.get(key) || 0;

        showToast(
          terminalId, snoozed.title, snoozed.deviceName, snoozed.locationName,
          snoozed.icon, snoozed.priority, snoozed.claudeState, snoozed.info
        );

        const toast = activeToasts.get(terminalId);
        if (toast && count >= 5) {
          toast.classList.add('critical-escalated');
        } else if (toast && count >= 3) {
          toast.classList.add('escalated');
        }

        playNotificationSound(snoozed.claudeState, count);
      }
    }
  }
}

function checkActiveNotifications() {
  for (const [terminalId, toast] of activeToasts) {
    const notifState = toast.dataset.claudeState;
    const currentState = previousClaudeStates.get(terminalId);

    if (notifState === 'permission' || notifState === 'question' || notifState === 'inputNeeded') {
      if (currentState && currentState !== notifState) {
        dismissToast(terminalId);
      }
    }
  }
}

// ── Dismiss ──

export function dismissToast(terminalId) {
  const toast = activeToasts.get(terminalId);
  if (toast) {
    if (toast._autoDismissTimer) clearTimeout(toast._autoDismissTimer);
    if (toast._guestCountdown) clearInterval(toast._guestCountdown);
    const isHighPriority = toast.classList.contains('state-permission') ||
                           toast.classList.contains('state-question') ||
                           toast.classList.contains('state-inputNeeded');
    if (isHighPriority) {
      playDismissSound();
    }
    toast.classList.add('dismissing');
    activeToasts.delete(terminalId);
    setTimeout(() => toast.remove(), 200);
  }
}

// ── Admin notifications ──

const adminToasts = new Map();

export function showAdminToast(notification) {
  const toastId = `admin-notif-${notification.id}`;
  if (adminToasts.has(toastId)) return;

  const toast = document.createElement('div');
  toast.className = `notification-toast admin-notification admin-notification-${notification.type || 'info'}`;
  toast.dataset.notifId = notification.id;

  const iconMap = { info: '\u2139\uFE0F', warning: '\u26A0\uFE0F', error: '\u274C' };
  const icon = iconMap[notification.type] || iconMap.info;

  toast.innerHTML = `
    <div class="notification-icon">${icon}</div>
    <div class="notification-body">
      <div class="notification-title">${escapeHtml(notification.message)}</div>
      <div class="notification-device admin-notification-meta">From 49Agents team</div>
    </div>
    <button class="notification-dismiss" data-tooltip="Dismiss">&times;</button>
  `;

  const dismissBtn = toast.querySelector('.notification-dismiss');
  dismissBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissAdminToast(notification.id);
  });

  toast.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dismissAdminToast(notification.id);
  });

  notificationContainer.prepend(toast);
  adminToasts.set(toastId, toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
}

export function dismissAdminToast(notifId) {
  const toastId = `admin-notif-${notifId}`;
  const toast = adminToasts.get(toastId);
  if (toast) {
    toast.classList.add('dismissing');
    adminToasts.delete(toastId);
    setTimeout(() => toast.remove(), 200);
  }
  fetch(`/api/notifications/${notifId}/dismiss`, { method: 'POST' }).catch(() => {});
}

// ── Browser notifications ──

export function sendBrowserNotification(terminalId, title, body) {
  if (!document.hidden) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission();
    return;
  }
  if (Notification.permission !== 'granted') return;

  const notification = new Notification(title, {
    body: body,
    tag: `claude-${terminalId}`,
    icon: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="%23e87b35"><circle cx="8" cy="8" r="8"/></svg>'),
  });
  notification.onclick = () => {
    window.focus();
    _ctx.panToPane(terminalId);
    notification.close();
  };
}

// ── Tab title ──

export function updateTabTitleBadge(states) {
  let highPriorityCount = 0;
  for (const [, info] of Object.entries(states)) {
    if (info.isClaude && (info.state === 'permission' || info.state === 'question' || info.state === 'inputNeeded')) {
      highPriorityCount++;
    }
  }
  document.title = highPriorityCount > 0 ? `(${highPriorityCount}) ${originalTitle}` : originalTitle;
}

// ── State transition handler ──

export function handleStateTransition(terminalId, prevState, newState, info) {
  const paneData = _ctx.getState().panes.find(p => p.id === terminalId);
  const deviceName = paneData?.device || '';
  const locationName = info.location?.name || '';

  if (prevState && prevState !== newState) {
    snoozeCount.delete(`${terminalId}:${prevState}`);
  }

  let title, icon, priority;
  if (newState === 'permission') {
    title = 'Needs permission';
    icon = '\uD83D\uDD11';
    priority = 'high';
  } else if (newState === 'question' || newState === 'inputNeeded') {
    title = 'Needs input';
    icon = '\u2754';
    priority = 'high';
  } else if (newState === 'idle' && prevState === 'working') {
    title = 'Task complete';
    icon = '\u2705';
    priority = 'medium';
  } else {
    return;
  }

  if (notifiedStates.get(terminalId) === newState && !snoozedNotifications.has(terminalId)) return;
  notifiedStates.set(terminalId, newState);

  showToast(terminalId, title, deviceName, locationName, icon, priority, newState, info);
  playNotificationSound(newState);
  const detail = [deviceName, locationName].filter(Boolean).join(' \u00b7 ');
  sendBrowserNotification(terminalId, `Claude: ${title}`, detail);
}

// ── Promo / Community Toasts ──

const PROMO_STORAGE_KEY = '49a_promo_last_shown';

const PROMO_ITEMS = [
  {
    id: 'promo-discord',
    title: 'Join our Discord community',
    url: 'https://discord.gg/WgSYYbxH',
    state: 'promo-discord',
    icon: `<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>`,
  },
  {
    id: 'promo-x',
    title: 'Follow us on X',
    url: 'https://x.com/49agents',
    state: 'promo-x',
    icon: `<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
  },
  {
    id: 'promo-github',
    title: 'Leave us a star on GitHub',
    url: 'https://github.com/49Agents/49Agents',
    state: 'promo-github',
    icon: `<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`,
  },
  {
    id: 'promo-linkedin',
    title: 'Follow us on LinkedIn',
    url: 'https://www.linkedin.com/company/49agents',
    state: 'promo-linkedin',
    icon: `<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>`,
  },
  {
    id: 'promo-license',
    title: 'BSL License — enterprises please contact us',
    url: null,
    state: 'promo-license',
    icon: `<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`,
  },
];

function shouldShowPromo() {
  const lastShown = localStorage.getItem(PROMO_STORAGE_KEY);
  if (!lastShown) return true;

  const lastDate = new Date(parseInt(lastShown, 10));
  const now = new Date();

  // Find the most recent Monday (start of this week)
  const thisMonday = new Date(now);
  thisMonday.setHours(0, 0, 0, 0);
  const day = thisMonday.getDay();
  const diff = day === 0 ? 6 : day - 1; // Monday = 0 offset
  thisMonday.setDate(thisMonday.getDate() - diff);

  return lastDate < thisMonday;
}

function showPromoToast(item, delay) {
  setTimeout(() => {
    const id = item.id;

    // Remove existing if any
    const existing = activeToasts.get(id);
    if (existing) { existing.remove(); activeToasts.delete(id); }

    const toast = document.createElement('div');
    toast.className = `notification-toast state-${item.state}`;
    toast.dataset.terminalId = id;
    toast.dataset.claudeState = item.state;
    toast.dataset.promo = '1';

    toast.innerHTML = `
      <div class="notification-icon promo-icon">${item.icon}</div>
      <div class="notification-body">
        <div class="notification-title">${escapeHtml(item.title)}</div>
      </div>
      <button class="notification-dismiss" data-tooltip="Dismiss">&times;</button>
    `;

    // Click opens URL (if any)
    toast.addEventListener('click', (e) => {
      if (e.target.closest('.notification-dismiss')) return;
      if (item.url) {
        window.open(item.url, '_blank', 'noopener');
      }
    });

    // Right-click dismisses
    toast.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dismissPromoToast(id);
    });

    const dismissBtn = toast.querySelector('.notification-dismiss');
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissPromoToast(id);
    });

    notificationContainer.prepend(toast);
    activeToasts.set(id, toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
  }, delay);
}

function dismissPromoToast(id) {
  const toast = activeToasts.get(id);
  if (!toast) return;
  toast.classList.add('dismissing');
  activeToasts.delete(id);
  setTimeout(() => toast.remove(), 200);
}

export function showPromoToasts() {
  if (!shouldShowPromo()) return;
  localStorage.setItem(PROMO_STORAGE_KEY, Date.now().toString());

  PROMO_ITEMS.forEach((item, i) => {
    showPromoToast(item, i * 250);
  });

  // Auto-dismiss all promo toasts after 30 seconds
  setTimeout(() => {
    PROMO_ITEMS.forEach(item => dismissPromoToast(item.id));
  }, 30000);
}
