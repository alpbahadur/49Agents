import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import express from 'express';
import cookieParser from 'cookie-parser';

/**
 * The local-grant flow — the cloud half of the local-instance auth bridge.
 *
 * cloudCallback.js on the user's own machine has always redirected to
 * /auth/local-grant and POSTed to /auth/local-grant/exchange, but nothing ever
 * served either endpoint, so a self-hosted instance could never bind itself to
 * a cloud account. These tests pin the half that was missing.
 *
 * What this flow hands out is a year-long token carrying the user's full
 * identity, so the interesting cases are all about refusing to hand it to the
 * wrong place: a redirect_uri that is not the user's own machine, a code used
 * twice, a code redeemed against a different destination than it was minted
 * for. Those are checked against a real database over real HTTP, because the
 * thing being pinned is the route's behaviour and not a helper's return value.
 */

const dir = mkdtempSync(join(tmpdir(), 'local-grant-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.AUTH_MODE = 'oauth';
process.env.JWT_SECRET = 'test-secret-for-local-grant';

const { initDatabase, getDb } = await import('../src/db/index.js');
const { setupLocalGrantRoutes, isAllowedRedirectUri } = await import('../src/auth/localGrant.js');
const { issueAccessToken } = await import('../src/auth/tokens.js');
const { upsertUser } = await import('../src/db/users.js');
const { jwtVerify } = await import('jose');
const { getSecretKey } = await import('../src/auth/tokens.js');

initDatabase();

const user = upsertUser({
  githubId: 4901,
  githubLogin: 'testuser',
  email: 'test@example.com',
  displayName: 'Test User',
  avatarUrl: null,
});

const app = express();
app.use(cookieParser());
app.use(express.json());
setupLocalGrantRoutes(app);

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const accessToken = await issueAccessToken(user);
const authCookie = `tc_access=${accessToken}`;

const CALLBACK = 'http://127.0.0.1:1071/auth/cloud-callback';

test.after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Walk the flow to a fresh, unredeemed code. */
async function mintCode(redirectUri = CALLBACK) {
  const res = await fetch(`${base}/auth/local-grant/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: authCookie },
    body: new URLSearchParams({ redirect_uri: redirectUri, state: 'st4te' }),
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  return new URL(res.headers.get('location')).searchParams.get('code');
}

// ---------------------------------------------------------------------------
// Where a grant is allowed to land
// ---------------------------------------------------------------------------

test('only a local address at the callback path is a valid destination', () => {
  // The machine running the local instance — loopback, or somewhere on the
  // user's own network when they have opted into a LAN bind.
  assert.ok(isAllowedRedirectUri('http://localhost:1071/auth/cloud-callback'));
  assert.ok(isAllowedRedirectUri('http://127.0.0.1:1071/auth/cloud-callback'));
  assert.ok(isAllowedRedirectUri('http://192.168.1.40:1071/auth/cloud-callback'));
  assert.ok(isAllowedRedirectUri('http://10.0.0.5:1071/auth/cloud-callback'));
  assert.ok(isAllowedRedirectUri('http://172.16.4.2:1071/auth/cloud-callback'));
});

test('a grant cannot be redirected off the user\'s own network', () => {
  // Each of these would have the user's browser deliver a year-long credential
  // for their account to a host they do not control.
  assert.ok(!isAllowedRedirectUri('http://evil.example.com/auth/cloud-callback'));
  assert.ok(!isAllowedRedirectUri('https://evil.example.com/auth/cloud-callback'));
  assert.ok(!isAllowedRedirectUri('http://8.8.8.8/auth/cloud-callback'));

  // 172.32 is outside the private 172.16–172.31 range, and a public address
  // that merely looks private is the whole point of checking properly.
  assert.ok(!isAllowedRedirectUri('http://172.32.0.1/auth/cloud-callback'));

  // Right host, wrong path: the code must land on the endpoint that redeems it.
  assert.ok(!isAllowedRedirectUri('http://127.0.0.1:1071/somewhere-else'));

  // Credentials in the URL, and outright junk.
  assert.ok(!isAllowedRedirectUri('http://user:pw@127.0.0.1:1071/auth/cloud-callback'));
  assert.ok(!isAllowedRedirectUri('not-a-url'));
  assert.ok(!isAllowedRedirectUri(''));
});

test('the approval page refuses a destination it would not redirect to', async () => {
  const res = await fetch(
    `${base}/auth/local-grant?redirect_uri=${encodeURIComponent('http://evil.example.com/auth/cloud-callback')}`,
    { headers: { Cookie: authCookie }, redirect: 'manual' }
  );
  assert.equal(res.status, 400);
});

test('approval is a deliberate POST, never a bare navigation', async () => {
  // A GET that minted a code would let any page the signed-in user visits
  // start a grant on their behalf.
  const res = await fetch(
    `${base}/auth/local-grant?redirect_uri=${encodeURIComponent(CALLBACK)}&state=st4te`,
    { headers: { Cookie: authCookie, Accept: 'text/html' }, redirect: 'manual' }
  );
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<form method="POST" action="\/auth\/local-grant\/approve">/);
  assert.match(html, /Connect this machine\?/);
  // The destination is shown, so the user can see where this is going.
  assert.match(html, /127\.0\.0\.1:1071/);
});

test('an unauthenticated visitor is sent to sign in first, keeping their destination', async () => {
  const res = await fetch(
    `${base}/auth/local-grant?redirect_uri=${encodeURIComponent(CALLBACK)}`,
    { headers: { Accept: 'text/html' }, redirect: 'manual' }
  );
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.match(location, /^\/login\?next=/);
  assert.match(decodeURIComponent(location), /\/auth\/local-grant/);
});

// ---------------------------------------------------------------------------
// Redeeming the code
// ---------------------------------------------------------------------------

test('approval bounces back to the machine with a code and the original state', async () => {
  const res = await fetch(`${base}/auth/local-grant/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: authCookie },
    body: new URLSearchParams({ redirect_uri: CALLBACK, state: 'st4te' }),
    redirect: 'manual',
  });

  assert.equal(res.status, 302);
  const target = new URL(res.headers.get('location'));
  assert.equal(target.origin + target.pathname, CALLBACK);
  assert.ok(target.searchParams.get('code'));
  // cloudCallback.js compares this against its own cookie for CSRF.
  assert.equal(target.searchParams.get('state'), 'st4te');
});

test('a code trades for an instance token carrying the account identity', async () => {
  const code = await mintCode();

  const res = await fetch(`${base}/auth/local-grant/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirect_uri: CALLBACK }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();

  // Exactly the shape cloudCallback.js destructures.
  assert.ok(body.token);
  assert.ok(body.instanceId);
  assert.equal(body.user.id, user.id);
  assert.equal(body.user.email, 'test@example.com');
  assert.equal(body.user.github_login, 'testuser');

  // requireAuth accepts a Bearer token only when it says local_instance.
  const { payload } = await jwtVerify(body.token, getSecretKey());
  assert.equal(payload.type, 'local_instance');
  assert.equal(payload.sub, user.id);
});

test('a code is spent the first time it is redeemed', async () => {
  const code = await mintCode();

  const first = await fetch(`${base}/auth/local-grant/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirect_uri: CALLBACK }),
  });
  assert.equal(first.status, 200);

  // A code that survived redemption could be replayed by anyone who saw it in
  // a log, a proxy, or the URL bar.
  const second = await fetch(`${base}/auth/local-grant/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirect_uri: CALLBACK }),
  });
  assert.equal(second.status, 404);
});

test('a code is bound to the destination it was minted for', async () => {
  const code = await mintCode('http://192.168.1.40:1071/auth/cloud-callback');

  const res = await fetch(`${base}/auth/local-grant/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirect_uri: CALLBACK }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /redirect_uri does not match/);

  // And the mismatch still spends it, so it cannot be retried correctly.
  const retry = await fetch(`${base}/auth/local-grant/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirect_uri: 'http://192.168.1.40:1071/auth/cloud-callback' }),
  });
  assert.equal(retry.status, 404);
});

test('an unknown code buys nothing', async () => {
  const res = await fetch(`${base}/auth/local-grant/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'never-issued', redirect_uri: CALLBACK }),
  });
  assert.equal(res.status, 404);
});

test('the exchange requires both halves of the request', async () => {
  const res = await fetch(`${base}/auth/local-grant/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'something' }),
  });
  assert.equal(res.status, 400);
});
