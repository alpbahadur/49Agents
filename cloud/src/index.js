import { createServer } from 'http';
import { spawnSync } from 'child_process';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';
import { initDatabase } from './db/index.js';
import { setupGitHubAuth } from './auth/github.js';
import { setupGoogleAuth } from './auth/google.js';
import { requireAuth } from './auth/middleware.js';
import { setupApiRoutes } from './routes/api.js';
import { setupLayoutRoutes } from './routes/layouts.js';
import { setupDownloadRoutes } from './routes/download.js';
import { setupPreferencesRoutes } from './routes/preferences.js';
import { setupAnalyticsRoutes } from './routes/analytics.js';
import { setupWebSocketRelay } from './ws/relay.js';
import { setupNotificationRoutes } from './routes/notifications.js';
import { setupCloudCallbackRoutes } from './auth/cloudCallback.js';
import { ensureLocalAuthTable, isLocalMode } from './auth/localAuth.js';
import { ensureEmailAuthTable, setupEmailAuthRoutes, getEmailAuth, issueEmailInstanceToken } from './auth/emailAuth.js';
import { initLocalTelemetryCollector } from './telemetry/localCollector.js';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, '..', 'public');
const landingDir = config.landingDir ? resolve(config.landingDir) : null;

const app = express();

// ---------------------------------------------------------------------------
// Landing page routing (hostname-based)
// If APP_HOST is set, requests to the root domain serve the landing page
// and only APP_HOST gets the actual app.
// ---------------------------------------------------------------------------
if (landingDir && config.appHost) {
  // Vanity redirect paths — redirect to landing page root with utm_source
  const vanityRedirects = { '/twitter': 'twitter', '/x': 'twitter', '/github': 'github', '/reddit': 'reddit', '/hn': 'hackernews', '/hackernews': 'hackernews', '/linkedin': 'linkedin', '/youtube': 'youtube', '/yt': 'youtube', '/discord': 'discord' };

  app.use((req, res, next) => {
    const host = req.hostname;
    // If this is the app subdomain, continue to the app
    if (host === config.appHost) return next();

    // Vanity redirects: /twitter -> /?utm_source=twitter
    const source = vanityRedirects[req.path.toLowerCase()];
    if (source) {
      return res.redirect(302, '/?utm_source=' + source);
    }

    // Otherwise serve the landing page
    if (req.path === '/' || req.path === '/index.html') {
      return res.sendFile('index.html', { root: landingDir });
    }
    // Try to serve static assets from landing dir, fall through if not found
    express.static(landingDir)(req, res, next);
  });
}

// ---------------------------------------------------------------------------
// Reverse proxy support — trust X-Forwarded-* headers so req.secure,
// req.protocol, and req.ip resolve correctly behind nginx / Cloudflare / etc.
// ---------------------------------------------------------------------------
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Security middleware
// ---------------------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",  // Required for Monaco AMD loader config in index.html
          "https://cdnjs.cloudflare.com",
          "https://cdn.jsdelivr.net",
          "blob:",  // Monaco web workers + extension scripts
        ],
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'", "ws:", "wss:", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
        workerSrc: ["'self'", "blob:"],  // Monaco web workers
        frameSrc: ["'self'", "https:", "http:"],  // Iframe panes (allow HTTP for LAN)
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        upgradeInsecureRequests: null,  // Disable HTTPS forcing for LAN/Tailscale HTTP access
      },
    },
    crossOriginEmbedderPolicy: false, // Allow embedding iframes in the canvas
  })
);

const allowedOrigins = config.nodeEnv === 'production'
  ? [`https://${config.cloudHost}`, ...(config.appHost ? [`https://${config.appHost}`] : [])]
  : true;

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

app.use(cookieParser());

// Load extension early routes (e.g. webhooks needing raw body) before express.json()
{
  const _extSetup = resolve(__dirname, '..', '..', 'extensions', 'setup.js');
  if (existsSync(_extSetup)) {
    try {
      const _ext = await import(_extSetup);
      if (_ext.setupEarlyRoutes) _ext.setupEarlyRoutes(app);
    } catch (_err) { console.warn('[cloud] Early extension routes skipped:', _err.message); }
  }
}

app.use(express.json({ limit: '16kb' }));

// ---------------------------------------------------------------------------
// Agent download routes (public -- no requireAuth)
// ---------------------------------------------------------------------------
setupDownloadRoutes(app);

// ---------------------------------------------------------------------------
// Auth routes (public -- no requireAuth)
// ---------------------------------------------------------------------------
setupGitHubAuth(app);
setupGoogleAuth(app);
setupCloudCallbackRoutes(app);
if (isLocalMode()) {
  setupEmailAuthRoutes(app);
}

// Auth mode endpoint (public — tells the login page if we're local or cloud)
app.get('/api/auth/mode', (req, res) => {
  res.json({
    mode: isLocalMode() ? 'local' : 'cloud',
    cloudAuthUrl: isLocalMode() ? config.cloudAuthUrl : undefined,
  });
});

// ---------------------------------------------------------------------------
// Login page (public)
// ---------------------------------------------------------------------------
app.get('/login', (req, res) => {
  res.sendFile('login.html', { root: publicDir });
});

// Telemetry consent page (local mode only, shown after first cloud auth)
app.get('/consent', (req, res) => {
  res.sendFile('consent.html', { root: publicDir });
});

// ---------------------------------------------------------------------------
// API routes (protected -- requireAuth is applied inside setupApiRoutes)
// ---------------------------------------------------------------------------
setupApiRoutes(app);

// ---------------------------------------------------------------------------
// Layout persistence routes (cloud-direct, not relayed through agents)
// ---------------------------------------------------------------------------
setupLayoutRoutes(app);

// ---------------------------------------------------------------------------
// User preferences routes (cloud-direct)
// ---------------------------------------------------------------------------
setupPreferencesRoutes(app);

// ---------------------------------------------------------------------------
// Analytics routes (public tracking only — admin routes on Tailscale server)
// ---------------------------------------------------------------------------
setupAnalyticsRoutes(app);

// ---------------------------------------------------------------------------
// Feedback proxy (local mode only — forwards /api/messages to cloud server)
// ---------------------------------------------------------------------------
if (isLocalMode()) {
  const { getLocalAuth } = await import('./auth/localAuth.js');

  async function getBearerToken() {
    // Prefer OAuth cloud token; fall back to email instance token
    const localAuth = getLocalAuth();
    if (localAuth && localAuth.cloudToken) return localAuth.cloudToken;
    const emailAuth = getEmailAuth();
    if (emailAuth) return issueEmailInstanceToken(emailAuth.instanceId, emailAuth.email);
    return null;
  }

  async function proxyToCloud(req, res) {
    const token = await getBearerToken();
    if (!token) {
      return res.status(401).json({ error: 'Not authenticated with cloud' });
    }
    const cloudUrl = config.cloudAuthUrl;
    const url = `${cloudUrl}${req.originalUrl}`;
    const opts = {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(10000),
    };
    if (req.method !== 'GET' && req.body) {
      opts.body = JSON.stringify(req.body);
    }
    try {
      const resp = await fetch(url, opts);
      const data = await resp.json();
      res.status(resp.status).json(data);
    } catch (err) {
      console.error('[feedback-proxy] Error:', err.message);
      res.status(502).json({ error: 'Cloud server unreachable' });
    }
  }

  app.get('/api/messages', proxyToCloud);
  app.post('/api/messages', proxyToCloud);
  app.get('/api/messages/unread-count', proxyToCloud);
  app.post('/api/messages/mark-read', proxyToCloud);
}

// ---------------------------------------------------------------------------
// Main app entry point (auth required in both cloud and local modes)
// SKIP_CLOUD_AUTH env var bypasses auth for contributors in local dev
// ---------------------------------------------------------------------------
const hasOAuth = config.github.clientId || config.google.clientId;
const devModeEnabled = !hasOAuth && config.nodeEnv !== 'production';
if (devModeEnabled && process.env.SKIP_CLOUD_AUTH) {
  app.get('/', (req, res) => res.sendFile('index.html', { root: publicDir }));
} else {
  app.get('/', requireAuth, (req, res) => res.sendFile('index.html', { root: publicDir }));
}

// ---------------------------------------------------------------------------
// Static assets (JS, CSS, fonts, lib/) -- served without auth.
// Only HTML entry points are protected above.
// ---------------------------------------------------------------------------
app.use('/', express.static(publicDir, {
  index: false, // Don't auto-serve index.html; we handle / above
}));

// ---------------------------------------------------------------------------
// Interactive tutorial (no auth required)
// ---------------------------------------------------------------------------
app.get('/tutorial', (req, res) => {
  res.sendFile('tutorial.html', { root: publicDir });
});

// ---------------------------------------------------------------------------
// Agent pairing page (auth required)
// ---------------------------------------------------------------------------
app.get('/pair', requireAuth, (req, res) => {
  res.sendFile('pair.html', { root: publicDir });
});

// ---------------------------------------------------------------------------
// Initialize database and start server with WebSocket relay
// ---------------------------------------------------------------------------
async function start() {
  initDatabase();
  ensureLocalAuthTable();
  ensureEmailAuthTable();
  initLocalTelemetryCollector();

  // Read latest agent version from the tarball
  let latestAgentVersion = null;
  try {
    const tarballPath = resolve(__dirname, '..', 'dl', '49-agent.tar.gz');
    const result = spawnSync('tar', ['xzf', tarballPath, '--to-stdout', 'agent/package.json'], {
      encoding: 'utf-8',
      timeout: 10000,
    });
    if (result.status !== 0) throw new Error(result.stderr || 'tar extraction failed');
    latestAgentVersion = JSON.parse(result.stdout).version || null;
    console.log(`[cloud] Latest agent version from tarball: ${latestAgentVersion}`);
  } catch (err) {
    console.warn('[cloud] Could not read agent version from tarball:', err.message);
  }

  // Warn if GitHub OAuth is not configured
  if (!config.github.clientId || !config.github.clientSecret) {
    console.warn('');
    console.warn('  WARNING: GitHub OAuth credentials are not configured.');
    console.warn('  Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET environment variables.');
    console.warn('  The login page will be served, but OAuth login will not work.');
    console.warn('');
  }

  // Create HTTP server from Express app so we can handle WebSocket upgrades
  const server = createServer(app);

  // Set up the WebSocket relay (handles /ws and /agent-ws upgrade routes)
  const { userAgents, userBrowsers } = setupWebSocketRelay(server, { latestAgentVersion });

  // Notification routes (user-facing: fetch + dismiss)
  setupNotificationRoutes(app);

  // Load extensions if present (private/cloud-only features)
  const extensionsDir = resolve(__dirname, '..', '..', 'extensions');
  if (existsSync(resolve(extensionsDir, 'setup.js'))) {
    try {
      const ext = await import(resolve(extensionsDir, 'setup.js'));
      ext.default({ app, server, userAgents, userBrowsers, publicDir });
      console.log('[cloud] Extensions loaded');
    } catch (err) {
      console.error('[cloud] Failed to load extensions:', err.message);
    }
  }

  // Catch-all: redirect unmatched routes to /login
  // Must be registered AFTER extensions so their routes take priority
  app.get('*', (req, res) => {
    res.redirect('/login');
  });

  server.listen(config.port, config.host, () => {
    console.log(`[cloud] 49Agents Cloud Server`);
    console.log(`[cloud] Listening on http://${config.host}:${config.port}`);
    console.log(`[cloud] Environment: ${config.nodeEnv}`);
  });
}

start();

export default app;
