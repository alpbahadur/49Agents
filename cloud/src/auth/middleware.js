import { jwtVerify } from 'jose';
import { issueAccessToken, getSecretKey } from './tokens.js';
import { getUserById } from '../db/users.js';
import { upsertUser, getOrCreateLocalSharedUser } from '../db/users.js';
import { getLocalAuth } from './localAuth.js';
import { config } from '../config.js';

const isProduction = config.nodeEnv === 'production';
const devModeEnabled = config.authMode === 'open' && !isProduction;

/**
 * The single-identity helpers (local_auth and local_email_auth both hold one
 * row, CHECK id = 1) describe *this machine's* owner. On a hosted deployment
 * that row is server-wide, so consulting it for identity would hand every
 * visitor the same account and, with it, everyone else's machines. Only an
 * 'open' deployment may resolve a visitor that way.
 */
const singleTenant = config.authMode === 'open';

/**
 * Express middleware that requires a valid JWT cookie or bearer token.
 *
 * On an 'oauth' deployment this is the real gate: no cookie means the visitor
 * is sent to /login to sign in with GitHub, Google, or as a guest. On an
 * 'open' deployment autoLocalSession has already minted the shared identity
 * before any guarded route is reached, so this just verifies that cookie.
 *
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
  const localAuth = singleTenant ? getLocalAuth() : null;
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

  // Keyed on the instance id, so a second browser on this machine — or a
  // crawler with no cookie — resolves to the same identity as the agent
  // rather than creating a new user row on every request.
  const user = getOrCreateLocalSharedUser(instanceId, {
    email: emailAuth?.email || null,
    displayName: emailAuth?.email ? emailAuth.email.split('@')[0] : 'Local User',
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
  const localAuth = singleTenant ? getLocalAuth() : null;
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
 * Send a 401 for API callers, or send a browser somewhere it can act: the
 * sign-in page on an 'oauth' deployment, the app itself on an 'open' one
 * (where autoLocalSession creates the session on arrival).
 */
function sendUnauthorized(req, res) {
  // Only a browser navigating to a page can be sent somewhere useful; a fetch
  // or an agent needs the status code. Path is the wrong thing to key on here:
  // /auth/local-grant is a page the user walks to from their own machine, and
  // answering that with 401 JSON strands them instead of offering a sign-in.
  //
  // /auth/me and friends are still 401s — fetch() sends Accept: */*, not
  // text/html, so they never look like a navigation.
  const isNavigation =
    req.method === 'GET' &&
    !req.xhr &&
    req.headers.accept?.includes('text/html') &&
    !req.path.startsWith('/api/');

  if (!isNavigation) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Please log in.' });
  }

  if (config.authMode === 'oauth') {
    // Preserve where they were headed so sign-in returns them to it.
    const next = req.originalUrl && req.originalUrl !== '/' ? req.originalUrl : null;
    return res.redirect(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  }

  // On an 'open' deployment there is no login page: send them to the app,
  // where autoLocalSession creates a session on arrival.
  return res.redirect('/');
}
