const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

// In production, JWT secrets MUST be set — refuse to start with known defaults
if (isProduction) {
  if (!process.env.JWT_SECRET) {
    throw new Error('FATAL: JWT_SECRET must be set in production. Refusing to start with default secret.');
  }
  if (!process.env.AGENT_JWT_SECRET) {
    throw new Error('FATAL: AGENT_JWT_SECRET must be set in production. Refusing to start with default secret.');
  }
}

const port = parseInt(process.env.PORT || '1071');

// Two servers on one machine must not share a database: the local_auth table
// holds a single identity row (CHECK id = 1), so a shared file makes the second
// instance impersonate the first. The default port keeps the original path so
// existing installs are untouched; any other port gets its own database file.
const defaultDbPath = port === 1071 ? './data/tc.db' : `./data/tc-${port}.db`;

// A self-hosted instance accepts the literal agent token 'dev' without any
// signature check (see auth/agentAuth.js), and /agent-ws performs no auth on
// the upgrade itself. Binding 0.0.0.0 therefore hands a shell to anyone on the
// same network: connect, send agent:auth with 'dev', and the relay treats you
// as the user's agent. Loopback is the correct default for that mode.
//
// isLocalMode() lives in auth/localAuth.js and imports config, so the same
// condition is recomputed here rather than creating a cycle. Setting HOST
// explicitly still wins, for anyone deliberately serving a LAN or a tunnel.
const hasOAuth = !!(process.env.GITHUB_CLIENT_ID || process.env.GOOGLE_CLIENT_ID);

// How this deployment authenticates its own visitors. Two shapes, and they are
// genuinely different products rather than two settings of one:
//
//   'oauth' — the hosted relay. Every visitor signs in (GitHub, Google, or a
//             guest session) and gets their own identity. Required, because
//             the relay routes agents and browsers by user id: a phone and a
//             desktop only meet if they resolve to the same user.
//   'open'  — a local or self-hosted instance. No sign-in at all; one shared
//             identity is auto-provisioned on first request. The machine's
//             owner is the only visitor, so there is nobody to tell apart.
//
// Left unset this is inferred exactly as it used to be implied — by whether
// OAuth credentials exist and whether we are in production — so deployments
// that never set it keep the behaviour they already had.
const authModeEnv = (process.env.AUTH_MODE || '').trim().toLowerCase();
if (authModeEnv && authModeEnv !== 'oauth' && authModeEnv !== 'open') {
  throw new Error(`FATAL: AUTH_MODE must be 'oauth' or 'open', got '${authModeEnv}'.`);
}
const authMode = authModeEnv || ((hasOAuth || isProduction) ? 'oauth' : 'open');

// A login screen with no providers behind it locks everyone out permanently,
// and guest mode is not an acceptable only door to a hosted deployment.
if (authMode === 'oauth' && isProduction && !hasOAuth) {
  throw new Error(
    'FATAL: AUTH_MODE=oauth in production requires GITHUB_CLIENT_ID or GOOGLE_CLIENT_ID. Refusing to start with a sign-in page that has no providers.'
  );
}

const localMode = authMode === 'open' && !process.env.SKIP_CLOUD_AUTH;
const defaultHost = localMode ? '127.0.0.1' : '0.0.0.0';

export const config = {
  port,
  host: process.env.HOST || defaultHost,
  authMode,
  hasOAuth,
  dbPath: process.env.DATABASE_PATH || defaultDbPath,
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    callbackUrl: process.env.GITHUB_CALLBACK_URL || 'http://localhost:1071/auth/github/callback',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    callbackUrl: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:1071/auth/google/callback',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    agentSecret: process.env.AGENT_JWT_SECRET || 'dev-agent-secret-change-in-production',
    userTtl: '1h',
    refreshTtl: '7d',
  },
  cloudHost: process.env.CLOUD_HOST || 'localhost:1071',
  appHost: process.env.APP_HOST || '',
  landingDir: process.env.LANDING_DIR || '',
  discord: {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  },
  adminUserId: process.env.ADMIN_USER_ID || '',
  adminToken: process.env.TELEMETRY_ADMIN_TOKEN || '',
  cloudAuthUrl: process.env.CLOUD_AUTH_URL || 'https://app.49agents.com',
  version: process.env.APP_VERSION || '',
  nodeEnv,
};
