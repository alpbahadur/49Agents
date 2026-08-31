import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import { Google, generateCodeVerifier } from 'arctic';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { upsertUser, getUserById, transferGuestData } from '../db/users.js';
import { recordEvent } from '../db/events.js';
import { issueAccessToken, issueRefreshToken, setAuthCookies, getSecretKey } from './tokens.js';

// Lazily initialize the Google OAuth client — only when credentials are present
let google = null;

function getGoogle() {
  if (!google && config.google.clientId && config.google.clientSecret) {
    google = new Google(
      config.google.clientId,
      config.google.clientSecret,
      config.google.callbackUrl
    );
  }
  return google;
}

/**
 * Register Google OAuth routes on the Express app.
 */
export function setupGoogleAuth(app) {
  // GET /auth/google — redirect to Google OAuth
  app.get('/auth/google', (req, res) => {
    const g = getGoogle();
    if (!g) {
      return res.status(503).json({
        error: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
      });
    }

    const state = nanoid();
    const codeVerifier = generateCodeVerifier();

    // Store state and code verifier in short-lived cookies for CSRF/PKCE verification
    const cookieOpts = {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000, // 10 minutes
      path: '/',
    };

    res.cookie('google_oauth_state', state, cookieOpts);
    res.cookie('google_code_verifier', codeVerifier, cookieOpts);

    // Preserve ?next= parameter through the OAuth flow (used by local instance auth)
    const next = req.query.next;
    if (next) {
      res.cookie('oauth_next', next, cookieOpts);
    }

    const url = g.createAuthorizationURL(state, codeVerifier, ['openid', 'profile', 'email']);
    res.redirect(url.toString());
  });

  // GET /auth/google/callback — handle OAuth callback
  app.get('/auth/google/callback', async (req, res) => {
    try {
      const { code, state } = req.query;
      const storedState = req.cookies?.google_oauth_state;
      const codeVerifier = req.cookies?.google_code_verifier;

      // Validate state for CSRF protection
      if (!state || !storedState || state !== storedState) {
        console.error('[auth] Google OAuth state mismatch');
        return res.status(403).send('Invalid OAuth state. Please try again.');
      }

      // Clear the state and verifier cookies
      res.clearCookie('google_oauth_state', { path: '/' });
      res.clearCookie('google_code_verifier', { path: '/' });

      if (!code || !codeVerifier) {
        return res.status(400).send('Missing authorization code or verifier.');
      }

      const g = getGoogle();
      if (!g) {
        return res.status(503).send('Google OAuth not configured.');
      }

      // Exchange code for tokens (Google uses PKCE)
      const tokens = await g.validateAuthorizationCode(code, codeVerifier);
      const accessToken = tokens.accessToken();

      // Fetch user profile from Google's userinfo endpoint
      const userResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!userResponse.ok) {
        console.error('[auth] Failed to fetch Google user:', userResponse.status);
        return res.status(500).send('Failed to fetch user profile from Google.');
      }

      const googleUser = await userResponse.json();

      // Read UTM attribution cookie (set by analytics.js before OAuth redirect)
      const utmSource = req.cookies?._49a_utm || null;

      // Upsert user in database (with email-based account linking)
      const user = upsertUser({
        googleId: googleUser.sub,
        email: googleUser.email || null,
        displayName: googleUser.name || googleUser.email,
        avatarUrl: googleUser.picture || null,
        utmSource,
      });

      // Clear the UTM cookie after use
      if (utmSource) res.clearCookie('_49a_utm', { path: '/' });

      // Transfer guest data if this user was previously a guest
      try {
        const oldAccessToken = req.cookies?.tc_access;
        if (oldAccessToken) {
          const { jwtVerify } = await import('jose');
          try {
            const { payload } = await jwtVerify(oldAccessToken, getSecretKey());
            const oldUser = getUserById(payload.sub);
            if (oldUser && oldUser.is_guest && oldUser.id !== user.id) {
              transferGuestData(oldUser.id, user.id);
              console.log(`[auth] Transferred guest data: ${oldUser.id} -> ${user.id}`);
            }
          } catch (e) {
            // Token invalid — no guest to transfer
          }
        }
      } catch (e) {
        console.warn('[auth] Guest transfer check failed:', e.message);
      }

      console.log(`[auth] User authenticated via Google: ${user.email || user.display_name} (${user.id})`);
      recordEvent('user.login', user.id, { provider: 'google', email: user.email });

      // Issue JWTs (reuse shared helpers from github.js)
      const jwtAccess = await issueAccessToken(user);
      const jwtRefresh = await issueRefreshToken(user);

      // Set cookies
      setAuthCookies(res, jwtAccess, jwtRefresh);

      // Check for a ?next= redirect (e.g., from local instance auth flow)
      const nextUrl = req.cookies?.oauth_next;
      if (nextUrl) {
        res.clearCookie('oauth_next', { path: '/' });
        // Only allow relative redirects (prevent open redirect)
        if (nextUrl.startsWith('/')) {
          return res.redirect(nextUrl);
        }
      }

      // Redirect to the main app
      res.redirect('/');
    } catch (err) {
      console.error('[auth] Google OAuth callback error:', err);
      res.status(500).send('Authentication failed. Please try again.');
    }
  });
}
