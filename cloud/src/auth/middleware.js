import { jwtVerify } from 'jose';
import { issueAccessToken, getSecretKey } from './tokens.js';
import { getUserById } from '../db/users.js';
import { upsertUser } from '../db/users.js';
import { getLocalAuth } from './localAuth.js';
import { config } from '../config.js';

const hasOAuth = !!(config.github.clientId || config.google.clientId);
const isProduction = config.nodeEnv === 'production';
const devModeEnabled = !hasOAuth && !isProduction;

/**
 * Express middleware that requires a valid JWT cookie or bearer token.
 * No OAuth provider exists anymore — every visitor is auto-authenticated as
 * the shared instance identity by autoLocalSession before they ever reach a
 * route guarded by requireAuth, so in practice this just verifies the
 * session cookie autoLocalSession already set:
 * 1. Extract access token from tc_access cookie
 * 2. Verify it — if valid, attach user to req.user
 * 3. If expired, try the refresh token (tc_refresh cookie)
 *    - If refresh valid: issue new access token, set cookie, continue
 *    - If refresh also invalid: 401
 * 4. If no token at all: 401 (API) or redirect to / (HTML)
 *
 * SKIP_CLOUD_AUTH remains as an escape hatch for contributors running
 * without internet, bypassing even the cookie check.
 */
export function requireAuth(req, res, next) {
  handleAuth(req, res, next).catch((err) => {
    console.error('[auth] Middleware error:', err);
    return sendUnauthorized(req, res);
  });
}

/**
 * Local-mode entry: authenticate normally, but mint an anonymous identity
 * instead of bouncing to /login when there isn't one yet.
 *
 * A fresh clone should open into the working app. The consent modal appears
 * inside the app after ten minutes of use, so there is nothing to ask at the
 * door. Telemetry stays off until that modal is answered.
 */
export function autoLocalSession(req, res, next) {
  resolveOrCreateLocalSession(req, res, next).catch((err) => {
    console.error('[auth] Local session error:', err);
    return sendUnauthorized(req, res);
  });
}

async function resolveOrCreateLocalSession(req, res, next) {
  // Reuse an existing identity when there is one. handleAuth() responds to the
  // request itself when auth fails, so it cannot be used here: we need to know
  // the outcome and then fall through, not send a 401.
  const localAuth = getLocalAuth();
  if (localAuth) {
    const user = getUserById(localAuth.cloudUserId) || upsertUser({
      githubLogin: localAuth.githubLogin,
      email: localAuth.email,
      displayName: localAuth.displayName || 'Local User',
      avatarUrl: localAuth.avatarUrl,
    });
    req.user = user;
    return next();
  }

  const accessToken = req.cookies?.tc_access;
  if (accessToken) {
    try {
      const { payload } = await jwtVerify(accessToken, getSecretKey());
      const user = getUserById(payload.sub);
      if (user) {
        req.user = user;
        return next();
      }
    } catch {
      // Expired or malformed. Fall through and mint a fresh session below.
    }
  }

  const { ensureLocalSession, getEmailAuth } = await import('./emailAuth.js');
  const { instanceId, created } = ensureLocalSession();
  const emailAuth = getEmailAuth();

  const user = upsertUser({
    githubId: null,
    githubLogin: null,
    googleId: null,
    email: emailAuth?.email || null,
    displayName: emailAuth?.email ? emailAuth.email.split('@')[0] : 'Local User',
    avatarUrl: null,
  });

  const { issueRefreshToken, setAuthCookies } = await import('./tokens.js');
  const access = await issueAccessToken(user);
  const refresh = await issueRefreshToken(user);
  setAuthCookies(res, access, refresh);

  if (created) {
    console.log(`[auth] Local session created automatically (instance: ${instanceId})`);
  }

  req.user = user;
  return next();
}

async function handleAuth(req, res, next) {
  if (devModeEnabled && process.env.SKIP_CLOUD_AUTH) {
    const devUser = upsertUser({
      githubId: 'dev-0',
      githubLogin: 'dev-user',
      email: 'dev@localhost',
      displayName: 'Dev User',
      avatarUrl: null,
    });
    req.user = devUser;
    return next();
  }

  // A local instance that has authenticated against the external managed
  // cloud (cloudCallback.js) carries that identity here too.
  const localAuth = getLocalAuth();
  if (localAuth) {
    const user = getUserById(localAuth.cloudUserId) || upsertUser({
      githubLogin: localAuth.githubLogin,
      email: localAuth.email,
      displayName: localAuth.displayName || 'Local User',
      avatarUrl: localAuth.avatarUrl,
    });
    req.user = user;
    return next();
  }

  // Check for Bearer token (local instance tokens proxying requests to cloud)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7);
      const secretKey = getSecretKey();
      const { payload } = await jwtVerify(token, secretKey);
      if (payload.type === 'local_instance' && payload.sub) {
        const user = getUserById(payload.sub);
        if (user) {
          req.user = user;
          return next();
        }
      }
    } catch {
      // Bearer token invalid — fall through to cookie check
    }
  }

  const accessToken = req.cookies?.tc_access;
  const refreshToken = req.cookies?.tc_refresh;
  const secretKey = getSecretKey();

  // Try access token first
  if (accessToken) {
    try {
      const { payload } = await jwtVerify(accessToken, secretKey);
      const user = getUserById(payload.sub);
      if (user) {
        req.user = user;
        return next();
      }
    } catch (err) {
      // Access token invalid or expired — fall through to refresh
      if (err.code !== 'ERR_JWT_EXPIRED') {
        // Token is malformed or tampered — don't try refresh
        return sendUnauthorized(req, res);
      }
    }
  }

  // Try refresh token
  if (refreshToken) {
    try {
      const { payload } = await jwtVerify(refreshToken, secretKey);

      if (payload.type !== 'refresh') {
        return sendUnauthorized(req, res);
      }

      const user = getUserById(payload.sub);
      if (!user) {
        return sendUnauthorized(req, res);
      }

      // Issue a new access token
      const newAccessToken = await issueAccessToken(user);

      const isProduction = config.nodeEnv === 'production';
      res.cookie('tc_access', newAccessToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 1000, // 1 hour
      });

      req.user = user;
      return next();
    } catch (err) {
      // Refresh token also invalid/expired
      return sendUnauthorized(req, res);
    }
  }

  // No tokens at all
  return sendUnauthorized(req, res);
}

/**
 * Send a 401 or redirect to /login depending on the request type.
 */
function sendUnauthorized(req, res) {
  // For API/JSON requests, return 401
  if (
    req.path.startsWith('/api/') ||
    req.path.startsWith('/auth/') ||
    req.xhr ||
    req.headers.accept?.includes('application/json')
  ) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Please log in.' });
  }

  // For browser/HTML requests, send them to the app, where autoLocalSession
  // creates a session on arrival — there is no separate login page.
  return res.redirect('/');
}
