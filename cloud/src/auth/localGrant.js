/**
 * Local Grant Routes — the cloud side of the local-instance auth bridge.
 *
 * cloudCallback.js (running on the user's own machine) has always pointed at
 * these two endpoints, but nothing ever served them, so a self-hosted instance
 * could never actually bind itself to a cloud account. This is that missing
 * half:
 *
 *   GET  /auth/local-grant          — signed-in user approves handing this
 *                                     machine a token for their account
 *   POST /auth/local-grant/approve  — mints a one-time code, bounces back to
 *                                     the machine's redirect_uri
 *   POST /auth/local-grant/exchange — the machine trades the code for a
 *                                     long-lived local_instance token
 *
 * The token this issues is durable and carries the user's full identity, so
 * the flow is deliberately narrow: the destination must be a private address,
 * the grant needs an explicit click (never a bare GET), and the code is
 * single-use, short-lived, and bound to the redirect_uri it was minted for.
 */

import express from 'express';
import { SignJWT } from 'jose';
import { nanoid } from 'nanoid';

import { requireAuth } from './middleware.js';
import { getSecretKey } from './tokens.js';
import { getUserById } from '../db/users.js';
import { recordEvent } from '../db/events.js';

const CODE_TTL_MS = 5 * 60 * 1000;      // codes are redeemed within seconds
const INSTANCE_TOKEN_TTL = '365d';       // the machine should not re-pair monthly

// code -> { userId, redirectUri, expiresAt }
const pendingGrants = new Map();

function sweepExpiredGrants() {
  const now = Date.now();
  for (const [code, grant] of pendingGrants) {
    if (now > grant.expiresAt) pendingGrants.delete(code);
  }
}
setInterval(sweepExpiredGrants, 60 * 1000).unref?.();

/**
 * A grant hands out a durable credential for the user's account, so the only
 * acceptable destinations are the ones a local instance can actually occupy:
 * the user's own machine, over plain HTTP, at the callback path.
 *
 * Anything else — a public host, https elsewhere, a different path — is an
 * attempt to have the user's browser deliver that credential somewhere it
 * does not belong.
 */
export function isAllowedRedirectUri(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:') return false;
  if (url.pathname !== '/auth/cloud-callback') return false;
  if (url.username || url.password || url.hash) return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host === '::1') return true;

  // IPv4 loopback, private ranges, and link-local — the addresses a machine on
  // the user's own network answers to.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (v4.slice(1).some((n) => Number(n) > 255)) return false;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;

  return false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderApprovalPage({ redirectUri, state, user }) {
  const host = new URL(redirectUri).host;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect a machine — 49Agents</title>
  <link rel="stylesheet" href="/styles.css">
  <style>
    body { display: grid; place-items: center; min-height: 100vh; margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
    .card { max-width: 26rem; padding: 2rem; text-align: left; }
    .host { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
    .actions { display: flex; gap: .75rem; margin-top: 1.5rem; }
    button { padding: .6rem 1.1rem; border-radius: .5rem; border: 0; font: inherit; cursor: pointer; }
    .primary { background: #2563eb; color: #fff; }
    .muted { opacity: .75; font-size: .9rem; line-height: 1.5; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Connect this machine?</h1>
    <p>The instance at <span class="host">${escapeHtml(host)}</span> is asking to sign in as
       <strong>${escapeHtml(user.display_name || user.email || user.github_login || user.id)}</strong>.</p>
    <p class="muted">It will be able to act as you on 49Agents until you disconnect it.
       Only continue if you started this from that machine.</p>
    <form method="POST" action="/auth/local-grant/approve">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(state || '')}">
      <div class="actions">
        <button type="submit" class="primary">Connect</button>
        <button type="button" onclick="location.href='/'">Cancel</button>
      </div>
    </form>
  </main>
</body>
</html>`;
}

export function setupLocalGrantRoutes(app) {
  // GET /auth/local-grant — ask the signed-in user to approve the machine.
  // requireAuth sends them to /login?next=… first when they are not signed in,
  // which is how a fresh machine's flow starts.
  app.get('/auth/local-grant', requireAuth, (req, res) => {
    const { redirect_uri: redirectUri, state } = req.query;

    if (!redirectUri) {
      return res.status(400).send('Missing redirect_uri.');
    }
    if (!isAllowedRedirectUri(redirectUri)) {
      console.warn(`[local-grant] Rejected redirect_uri: ${redirectUri}`);
      return res.status(400).send('That redirect_uri is not a local address this flow can return to.');
    }

    res.type('html').send(renderApprovalPage({ redirectUri, state, user: req.user }));
  });

  // POST /auth/local-grant/approve — the deliberate click. Mints the code.
  app.post('/auth/local-grant/approve', requireAuth, express.urlencoded({ extended: false }), (req, res) => {
    const redirectUri = req.body?.redirect_uri;
    const state = req.body?.state || '';

    if (!redirectUri || !isAllowedRedirectUri(redirectUri)) {
      return res.status(400).send('That redirect_uri is not a local address this flow can return to.');
    }

    const code = nanoid(32);
    pendingGrants.set(code, {
      userId: req.user.id,
      redirectUri,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    if (state) target.searchParams.set('state', state);

    console.log(`[local-grant] Granted code to ${target.host} for user ${req.user.id}`);
    res.redirect(target.toString());
  });

  // POST /auth/local-grant/exchange — the machine redeems the code. No session
  // here: the one-time code, its five-minute life, and the redirect_uri it is
  // pinned to are what authenticate this call.
  app.post('/auth/local-grant/exchange', async (req, res) => {
    try {
      const { code, redirect_uri: redirectUri } = req.body || {};

      if (!code || !redirectUri) {
        return res.status(400).json({ error: 'code and redirect_uri are required' });
      }

      const grant = pendingGrants.get(code);
      if (!grant) {
        return res.status(404).json({ error: 'Authorization code not found or already used' });
      }

      // Single use, whatever happens next.
      pendingGrants.delete(code);

      if (Date.now() > grant.expiresAt) {
        return res.status(410).json({ error: 'Authorization code has expired' });
      }
      if (grant.redirectUri !== redirectUri) {
        console.warn('[local-grant] redirect_uri mismatch on exchange');
        return res.status(400).json({ error: 'redirect_uri does not match the one the code was issued for' });
      }

      const user = getUserById(grant.userId);
      if (!user) {
        return res.status(404).json({ error: 'User no longer exists' });
      }

      const token = await new SignJWT({ sub: user.id, type: 'local_instance' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(INSTANCE_TOKEN_TTL)
        .setJti(nanoid())
        .sign(getSecretKey());

      const instanceId = `inst_${nanoid(16)}`;
      recordEvent('user.local_instance_granted', user.id, { instance_id: instanceId });
      console.log(`[local-grant] Issued instance token ${instanceId} for user ${user.id}`);

      res.json({
        token,
        instanceId,
        user: {
          id: user.id,
          display_name: user.display_name,
          email: user.email,
          avatar_url: user.avatar_url,
          github_login: user.github_login,
          tier: user.tier,
        },
      });
    } catch (err) {
      console.error('[local-grant] Exchange error:', err);
      res.status(500).json({ error: 'Failed to exchange authorization code' });
    }
  });
}
