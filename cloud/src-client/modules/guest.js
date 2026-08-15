// ─── Guest Mode ───────────────────────────────────────────────────────────
// Nudges for unregistered sessions: the expiry countdown toast and the
// registration modal it leads to. Guest sessions expire, so the toast
// escalates as the remaining time shrinks.

import { escapeHtml } from './utils.js';
import { activeToasts, getNotificationContainer } from './notifications.js';

const GUEST_TOAST_ID = '__guest_expiry__';
const GUEST_HARD_LIMIT_MS = 30 * 60 * 1000; // 30 minutes

// Reassigned wholesale when the schedule is rebuilt, so it lives here
// rather than being handed down by reference.
let guestExpiryTimers = [];

let _ctx = null;

export function initGuestDeps(ctx) { _ctx = ctx; }

export function showGuestRegisterModal(force) {
  let overlay = document.getElementById('guest-register-overlay');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'guest-register-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:200000;';

  const card = document.createElement('div');
  card.style.cssText = 'background:#1a1a2e;border:1px solid #8b8ff6;border-radius:14px;padding:36px;max-width:440px;width:90%;color:#e0e0e0;font-family:Montserrat,sans-serif;text-align:center;';

  const title = force ? 'sorry\u{1F614}\u{1F61E} \u2014 guest session expired' : 'Guest session ending soon';
  const msg = force
    ? 'we are not VC funded and we are paying out of pocket. Unfortunately we can not yet afford to let people use this as guests for longer, BUT if you register now, you get to keep all your work!!'
    : 'we are not VC funded and we are paying out of pocket. Unfortunately we can not yet afford to let people use this as guests for longer, BUT if you register now, you get to keep all your work!!';
  const continueBtn = force
    ? ''
    : `<button id="guest-continue-btn" style="background:transparent;color:#5a6578;border:1px solid rgba(255,255,255,0.1);padding:10px 24px;border-radius:8px;cursor:pointer;font-family:monospace;font-size:13px;margin-top:4px;">continue in guest mode</button>`;

  // In local mode, redirect to login page instead of showing OAuth modal
  const isLocal = !window.__tcUser || window.__tcAuthMode === 'local';
  if (isLocal && force) {
    window.location.href = '/login';
    return;
  }

  card.innerHTML = `
    <h2 style="margin:0 0 12px;color:#8b8ff6;font-size:20px;font-weight:600;">${title}</h2>
    <p style="color:#8a8faa;margin:0 0 24px;font-size:14px;line-height:1.5;">${msg}</p>
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px;">
      <a href="/login" style="display:inline-flex;align-items:center;justify-content:center;gap:10px;padding:12px 20px;background:rgba(139,143,246,0.15);border:1px solid rgba(139,143,246,0.35);border-radius:8px;color:#e8ecf4;text-decoration:none;font-size:14px;transition:all 0.2s;">
        Sign up
      </a>
    </div>
    ${continueBtn}
  `;
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Force mode: block all interaction (no dismiss)
  if (force) return;

  // Continue in guest mode button
  const continueEl = document.getElementById('guest-continue-btn');
  if (continueEl) {
    continueEl.addEventListener('click', () => overlay.remove());
  }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// Show a guest expiry toast using the same notification system as claude state notifs
export function showGuestExpiryToast(remainingMs, snoozable) {
  // Remove existing guest toast
  const existingToast = activeToasts.get(GUEST_TOAST_ID);
  if (existingToast) {
    if (existingToast._guestCountdown) clearInterval(existingToast._guestCountdown);
    activeToasts.delete(GUEST_TOAST_ID);
    existingToast.remove();
  }

  const toast = document.createElement('div');
  toast.className = 'notification-toast state-guest-expiry';
  toast.dataset.terminalId = GUEST_TOAST_ID;
  toast.dataset.claudeState = 'guest-expiry';

  const minutesLeft = Math.ceil(remainingMs / 60000);
  const timeLabel = minutesLeft > 1 ? `${minutesLeft} min` : '< 1 min';

  const actionButton = snoozable
    ? `<button class="notification-snooze" data-tooltip="Snooze">\u{1F554}</button>`
    : '';

  toast.innerHTML = `
    <div class="notification-icon">\u{1F616}</div>
    <div class="notification-body">
      <div class="notification-title">Guest session ending</div>
      <div class="notification-device guest-timer-label">${timeLabel} remaining</div>
    </div>
    ${actionButton}
  `;

  toast._notificationInfo = { claudeState: 'guest-expiry' };

  // Click toast → open modal with "continue in guest mode" (unless expired)
  toast.addEventListener('click', (e) => {
    if (e.target.closest('.notification-snooze')) return;
    const user = window.__tcUser;
    if (!user || !user.isGuest) return;
    const startedAt = new Date(user.guestStartedAt).getTime();
    const nowRemaining = GUEST_HARD_LIMIT_MS - (Date.now() - startedAt);
    showGuestRegisterModal(nowRemaining <= 0);
  });

  // Snooze button (only on 60/15 min toasts)
  const snoozeBtn = toast.querySelector('.notification-snooze');
  if (snoozeBtn) {
    snoozeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (toast._guestCountdown) clearInterval(toast._guestCountdown);
      toast.classList.add('dismissing');
      activeToasts.delete(GUEST_TOAST_ID);
      setTimeout(() => toast.remove(), 200);
    });
  }

  // For the 3-min (unsnoozable) toast, run a live countdown timer
  if (!snoozable) {
    const timerLabel = toast.querySelector('.guest-timer-label');
    const expiresAt = Date.now() + remainingMs;
    toast._guestCountdown = setInterval(() => {
      const left = Math.max(0, expiresAt - Date.now());
      const m = Math.floor(left / 60000);
      const s = Math.floor((left % 60000) / 1000);
      timerLabel.textContent = `${m}:${String(s).padStart(2, '0')} remaining`;
      if (left <= 0) {
        clearInterval(toast._guestCountdown);
        timerLabel.textContent = 'expired';
        showGuestRegisterModal(true);
      }
    }, 1000);
  }

  if (getNotificationContainer()) {
    getNotificationContainer().prepend(toast);
    activeToasts.set(GUEST_TOAST_ID, toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
  }
}

export function initGuestNudge(user) {
  if (!user.isGuest) return;

  const startedAt = new Date(user.guestStartedAt).getTime();
  const elapsed = Date.now() - startedAt;
  const remaining = GUEST_HARD_LIMIT_MS - elapsed;

  // Already expired
  if (remaining <= 0) {
    showGuestRegisterModal(true);
    return;
  }

  // Clear any previous timers
  guestExpiryTimers.forEach(t => clearTimeout(t));
  guestExpiryTimers = [];

  // Schedule toast at 60 min before expiry (snoozable) — only if enough time left
  const t60 = remaining - 60 * 60 * 1000; // won't fire for 30min sessions, that's fine
  if (t60 > 0) {
    guestExpiryTimers.push(setTimeout(() => {
      if (!activeToasts.has(GUEST_TOAST_ID)) showGuestExpiryToast(60 * 60 * 1000, true);
    }, t60));
  }

  // 15 min before expiry (snoozable) — transform existing or show new
  const t15 = remaining - 15 * 60 * 1000;
  if (t15 > 0) {
    guestExpiryTimers.push(setTimeout(() => {
      showGuestExpiryToast(15 * 60 * 1000, true);
    }, t15));
  } else if (remaining > 3 * 60 * 1000) {
    // Already past 15 min mark but not yet at 3 min — show immediately
    showGuestExpiryToast(remaining, true);
  }

  // 3 min before expiry (unsnoozable + live countdown)
  const t3 = remaining - 3 * 60 * 1000;
  if (t3 > 0) {
    guestExpiryTimers.push(setTimeout(() => {
      showGuestExpiryToast(3 * 60 * 1000, false);
    }, t3));
  } else {
    // Already under 3 min — show countdown immediately
    showGuestExpiryToast(remaining, false);
  }

  // Hard expiry — force modal
  guestExpiryTimers.push(setTimeout(() => {
    showGuestRegisterModal(true);
  }, remaining));
}

