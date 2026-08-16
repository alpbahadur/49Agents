/**
 * Cloud Callback Routes — local-side endpoints for the cloud auth redirect flow.
 *
 * These routes handle the local instance's side of the OAuth-like flow:
 *   GET  /auth/cloud-login    — initiates the flow, redirects to cloud
 *   GET  /auth/cloud-callback — receives the authorization code from cloud
 *   GET  /auth/cloud-logout   — clears local auth and redirects to login
 *   POST /api/auth/telemetry-consent — sets telemetry consent preference
 */

import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { upsertUser } from '../db/users.js';
import { saveLocalAuth, clearLocalAuth, getLocalAuth, setTelemetryConsent } from './localAuth.js';
import { getEmailAuth, setEmailTelemetryConsent, setCloudInstanceId } from './emailAuth.js';
import { issueAccessToken, issueRefreshToken, setAuthCookies } from './github.js';
import { recordEvent } from '../db/events.js';
import { refreshTelemetryState } from '../telemetry/localCollector.js';

export function setupCloudCallbackRoutes(app) {
  const cloudAuthUrl = config.cloudAuthUrl;
  const localPort = config.port;

  // GET /auth/cloud-login — start the cloud auth flow
  app.get('/auth/cloud-login', (req, res) => {
    const state = nanoid(32);

    // Store state in a cookie for CSRF verification
    res.cookie('cloud_auth_state', state, {
      httpOnly: true,
      secure: false, // localhost is always HTTP
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000, // 10 minutes
      path: '/',
    });

    const host = req.hostname || 'localhost';
    const redirectUri = `http://${host}:${localPort}/auth/cloud-callback`;
    const grantUrl = `${cloudAuthUrl}/auth/local-grant?redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
    res.redirect(grantUrl);
  });

  // GET /auth/cloud-callback — receive the authorization code from cloud
  app.get('/auth/cloud-callback', async (req, res) => {
    try {
      const { code, state } = req.query;
      const storedState = req.cookies?.cloud_auth_state;

      // Validate CSRF state if both are present (when flow started via /auth/cloud-login).
      // When the flow starts directly from the login page linking to cloud OAuth,
      // no state cookie exists — security is provided by the cloud's own OAuth CSRF
      // protection and the one-time authorization code.
      if (storedState) {
        if (!state || state !== storedState) {
          console.error('[cloud-callback] State mismatch');
          return res.status(403).send('Invalid state. Please try again.');
        }
        res.clearCookie('cloud_auth_state', { path: '/' });
      }

      if (!code) {
        return res.status(400).send('Missing authorization code.');
      }

      // Exchange code for token by calling the cloud server
      const host = req.hostname || 'localhost';
      const redirectUri = `http://${host}:${localPort}/auth/cloud-callback`;
      const exchangeUrl = `${cloudAuthUrl}/auth/local-grant/exchange`;

      const exchangeRes = await fetch(exchangeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, redirect_uri: redirectUri }),
      });

      if (!exchangeRes.ok) {
        const err = await exchangeRes.json().catch(() => ({}));
        console.error('[cloud-callback] Exchange failed:', err);
        return res.status(400).send(`Authentication failed: ${err.error || 'Unknown error'}. Please try again.`);
      }

      const { token, instanceId, user: cloudUser } = await exchangeRes.json();

      // Save cloud auth data locally
      saveLocalAuth({
        cloudUserId: cloudUser.id,
        cloudToken: token,
        instanceId,
        displayName: cloudUser.display_name,
        email: cloudUser.email,
        avatarUrl: cloudUser.avatar_url,
        githubLogin: cloudUser.github_login,
        tier: cloudUser.tier,
      });

      // Create or update a local user record matching the cloud identity
      const localUser = upsertUser({
        githubId: null,
        githubLogin: cloudUser.github_login || null,
        googleId: null,
        email: cloudUser.email || null,
        displayName: cloudUser.display_name || cloudUser.github_login || 'Local User',
        avatarUrl: cloudUser.avatar_url || null,
      });

      // Issue local JWT cookies so the existing auth middleware works
      const jwtAccess = await issueAccessToken(localUser);
      const jwtRefresh = await issueRefreshToken(localUser);
      setAuthCookies(res, jwtAccess, jwtRefresh);

      console.log(`[cloud-callback] Local instance authenticated: ${cloudUser.display_name || cloudUser.email} (cloud: ${cloudUser.id})`);
      recordEvent('user.login', localUser.id, { provider: 'cloud_local', cloudUserId: cloudUser.id });

      // Check if telemetry consent is needed
      const localAuth = getLocalAuth();
      if (localAuth && localAuth.telemetryConsent === -1) {
        return res.redirect('/consent');
      }

      res.redirect('/');
    } catch (err) {
      console.error('[cloud-callback] Error:', err);
      res.status(500).send('Authentication failed. Please try again.');
    }
  });

  // GET /auth/cloud-logout — clear local auth and redirect to login
  app.get('/auth/cloud-logout', (req, res) => {
    clearLocalAuth();
    res.clearCookie('tc_access', { path: '/' });
    res.clearCookie('tc_refresh', { path: '/' });
    res.redirect('/login');
  });

  // GET /api/auth/telemetry-consent returns the current telemetry preference.
  // Reads from whichever identity path is in use (OAuth cloud auth or onboarding email).
  app.get('/api/auth/telemetry-consent', (req, res) => {
    const localAuth = getLocalAuth();
    const raw = localAuth ? localAuth.telemetryConsent : (getEmailAuth() || {}).telemetryConsent;

    if (raw === undefined || raw === null) {
      return res.json({ consent: false, status: 'not_authenticated' });
    }

    res.json({
      consent: raw === 1,
      status: raw === -1 ? 'pending' : (raw === 1 ? 'accepted' : 'declined'),
    });
  });

  // POST /api/auth/telemetry-consent — set telemetry preference
  app.post('/api/auth/telemetry-consent', (req, res) => {
    try {
      const { consent } = req.body;
      const localAuth = getLocalAuth();
      const emailAuth = localAuth ? null : getEmailAuth();

      if (!localAuth && !emailAuth) {
        return res.status(400).json({ error: 'Not authenticated' });
      }

      if (localAuth) {
        setTelemetryConsent(!!consent);
      } else {
        setEmailTelemetryConsent(!!consent);
      }

      refreshTelemetryState();

      // Push the new preference to the cloud so it is enforced server-side too.
      //
      // Both directions matter. Turning consent ON may be this instance's first
      // ever contact (someone who declined during onboarding), so it needs an id
      // before the collector has anywhere to send. Turning it OFF must mark the
      // cloud record as revoked. Otherwise stopping the local collector is the
      // only thing protecting the user, and anything still holding the instance
      // id could keep writing events against it.
      if (emailAuth) {
        fetch(`${config.cloudAuthUrl}/api/local-email-signup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instanceId: emailAuth.cloudInstanceId || emailAuth.instanceId,
            email: emailAuth.email,
            consent: !!consent,
            hostname: req.hostname,
            os: process.platform,
            version: config.version || null,
          }),
          signal: AbortSignal.timeout(8000),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (data && data.instanceId) {
              setCloudInstanceId(data.instanceId);
              refreshTelemetryState();
            }
          })
          .catch((err) => {
            console.warn('[cloud-callback] Consent sync failed (non-fatal):', err.message);
          });
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('[cloud-callback] Consent error:', err);
      res.status(500).json({ error: 'Failed to save preference' });
    }
  });
}
