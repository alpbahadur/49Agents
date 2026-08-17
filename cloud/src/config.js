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
const localMode = !hasOAuth && !isProduction && !process.env.SKIP_CLOUD_AUTH;
const defaultHost = localMode ? '127.0.0.1' : '0.0.0.0';

export const config = {
  port,
  host: process.env.HOST || defaultHost,
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
