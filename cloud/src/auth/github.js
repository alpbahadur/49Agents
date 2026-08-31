import { GitHub } from 'arctic';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { upsertUser, createGuestUser, transferGuestData, getUserById } from '../db/users.js';
import { recordEvent } from '../db/events.js';
import {
  issueAccessToken,
  issueRefreshToken,
  setAuthCookies,
  clearAuthCookies,
  getSecretKey,
} from './tokens.js';

// Lazily initialize the GitHub OAuth client — only when credentials are present
let github = null;

function getGitHub() {
  if (!github && config.github.clientId && config.github.clientSecret) {
    github = new GitHub(
      config.github.clientId,
      config.github.clientSecret,
      config.github.callbackUrl
    );
  }
  return github;
}

/**
 * Register GitHub OAuth routes on the Express app.
 */
export function setupGitHubAuth(app) {
  // POST /auth/guest — create a guest session (when OAuth is enabled or in local mode)
  app.post('/auth/guest', async (req, res) => {
    // Guest sessions exist to let someone try the hosted relay without an
    // account. An 'open' deployment has no sign-in to skip, so there is
    // nothing for a guest session to mean there.
    if (config.authMode !== 'oauth') {
      return res.status(400).json({ error: 'Guest mode not available' });
    }

    try {
      const guest = createGuestUser();
      const jwtAccess = await issueAccessToken(guest);
      const jwtRefresh = await issueRefreshToken(guest);
      setAuthCookies(res, jwtAccess, jwtRefresh);
      res.json({ ok: true, userId: guest.id });
    } catch (err) {
      console.error('[auth] Guest creation error:', err);
      res.status(500).json({ error: 'Failed to create guest session' });
    }
  });

  // GET /auth/github — redirect to GitHub OAuth
  app.get('/auth/github', (req, res) => {
    const gh = getGitHub();
    if (!gh) {
      return res.status(503).json({
        error: 'GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.',
      });
    }

    const state = nanoid();

    const cookieOpts = {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000, // 10 minutes
      path: '/',
    };

    // Store state in a short-lived cookie for CSRF verification
    res.cookie('oauth_state', state, cookieOpts);

    // Preserve ?next= parameter through the OAuth flow (used by local instance auth)
    const next = req.query.next;
    if (next) {
      res.cookie('oauth_next', next, cookieOpts);
    }

    const url = gh.createAuthorizationURL(state, ['read:user', 'user:email']);
    res.redirect(url.toString());
  });

  // GET /auth/github/callback — handle OAuth callback
  app.get('/auth/github/callback', async (req, res) => {
    try {
      const { code, state } = req.query;
      const storedState = req.cookies?.oauth_state;

      // Validate state for CSRF protection
      if (!state || !storedState || state !== storedState) {
        console.error('[auth] OAuth state mismatch');
        return res.status(403).send('Invalid OAuth state. Please try again.');
      }

      // Clear the state cookie
      res.clearCookie('oauth_state', { path: '/' });

      if (!code) {
        return res.status(400).send('Missing authorization code.');
      }

      const gh = getGitHub();
      if (!gh) {
        return res.status(503).send('GitHub OAuth not configured.');
      }

      // Exchange code for access token
      const tokens = await gh.validateAuthorizationCode(code);
      const accessToken = tokens.accessToken();

      // Fetch user profile from GitHub API
      const userResponse = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (!userResponse.ok) {
        console.error('[auth] Failed to fetch GitHub user:', userResponse.status);
        return res.status(500).send('Failed to fetch user profile from GitHub.');
      }

      const ghUser = await userResponse.json();

      // Fetch user emails if primary email not in profile
      let email = ghUser.email;
      if (!email) {
        try {
          const emailsResponse = await fetch('https://api.github.com/user/emails', {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/vnd.github.v3+json',
            },
          });
          if (emailsResponse.ok) {
            const emails = await emailsResponse.json();
            const primary = emails.find(e => e.primary && e.verified);
            if (primary) email = primary.email;
          }
        } catch (err) {
          console.warn('[auth] Could not fetch user emails:', err.message);
        }
      }

      // Read UTM attribution cookie (set by analytics.js before OAuth redirect)
      const utmSource = req.cookies?._49a_utm || null;

      // Upsert user in database
      const user = upsertUser({
        githubId: ghUser.id,
        githubLogin: ghUser.login,
        email: email || null,
        displayName: ghUser.name || ghUser.login,
        avatarUrl: ghUser.avatar_url || null,
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
            // Token invalid — no guest to transfer, that's fine
          }
        }
      } catch (e) {
        console.warn('[auth] Guest transfer check failed:', e.message);
      }

      console.log(`[auth] User authenticated: ${user.github_login} (${user.id})`);
      recordEvent('user.login', user.id, { provider: 'github', login: user.github_login });

      // Issue JWTs
      const jwtAccess = await issueAccessToken(user);
      const jwtRefresh = await issueRefreshToken(user);

      // Set cookies
      setAuthCookies(res, jwtAccess, jwtRefresh);

      // Check for a ?next= redirect (e.g., from local instance auth flow)
      const nextUrl = req.cookies?.oauth_next;
      console.log('[auth] oauth_next cookie:', nextUrl || '(none)');
      if (nextUrl) {
        res.clearCookie('oauth_next', { path: '/' });
        // Only allow relative redirects (prevent open redirect)
        if (nextUrl.startsWith('/')) {
          console.log('[auth] Redirecting to next:', nextUrl);
          return res.redirect(nextUrl);
        }
      }

      // Redirect to the main app
      res.redirect('/');
    } catch (err) {
      console.error('[auth] OAuth callback error:', err);
      res.status(500).send('Authentication failed. Please try again.');
    }
  });

  // POST /auth/logout — clear cookies and redirect
  app.post('/auth/logout', (req, res) => {
    clearAuthCookies(res);
    res.redirect('/login');
  });

  // Also support GET for convenience (e.g., link-based logout)
  app.get('/auth/logout', (req, res) => {
    clearAuthCookies(res);
    res.redirect('/login');
  });
}
