import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createServer } from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { WebSocket } from 'ws';

/**
 * Reaching your computer from your phone.
 *
 * This is the case the relay exists for, and the one that decides whether
 * sign-in can be optional on the hosted deployment. The relay keys everything
 * on user id — userAgents is Map<userId, Map<agentId, ...>> — so a browser
 * only ever sees the agents registered under the same id it authenticated as.
 *
 * That makes the join entirely a question of identity: two devices, one
 * account, one user id. When the hosted deployment minted an anonymous
 * identity per cookieless visitor instead of authenticating one, a phone could
 * not land on the desktop's id by any route, and the pane list was empty no
 * matter how correct the pairing had been.
 *
 * So this walks the whole path against a real server: pair the computer's
 * agent to an account, connect that agent, then connect a second browser
 * carrying only that account's cookie — the phone — and assert it is handed
 * the machine.
 */

const dir = mkdtempSync(join(tmpdir(), 'phone-to-desktop-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.AUTH_MODE = 'oauth';
process.env.JWT_SECRET = 'phone-desktop-secret';
process.env.AGENT_JWT_SECRET = 'phone-desktop-agent-secret';

const { initDatabase } = await import('../src/db/index.js');
const { setupApiRoutes } = await import('../src/routes/api.js');
const { setupWebSocketRelay } = await import('../src/ws/relay.js');
const { issueAccessToken } = await import('../src/auth/tokens.js');
const { upsertUser } = await import('../src/db/users.js');

initDatabase();

const owner = upsertUser({
  githubId: 7001, githubLogin: 'owner', email: 'owner@example.com',
  displayName: 'Owner', avatarUrl: null,
});
const stranger = upsertUser({
  githubId: 7002, githubLogin: 'stranger', email: 'stranger@example.com',
  displayName: 'Stranger', avatarUrl: null,
});

const app = express();
app.use(cookieParser());
app.use(express.json());
setupApiRoutes(app);

const server = createServer(app);
setupWebSocketRelay(server);
server.listen(0);
await new Promise((r) => server.once('listening', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const ownerCookie = `tc_access=${await issueAccessToken(owner)}`;
const strangerCookie = `tc_access=${await issueAccessToken(stranger)}`;

test.after(() => {
  agentWs?.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Wait for the first message of a given type, or fail loudly. */
function waitForMessage(ws, type, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
    ws.on('message', function onMsg(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(msg);
    });
  });
}

function openWs(path, headers) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade ${res.statusCode}`)));
  });
}

/** The whole pairing dance, as the computer and the browser perform it. */
async function pairAgent(cookie, hostname) {
  const created = await fetch(`${base}/api/agents/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ hostname, os: 'darwin', version: '0.2.2' }),
  });
  assert.equal(created.status, 200);
  const { code } = await created.json();

  const approved = await fetch(`${base}/api/agents/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code }),
  });
  assert.equal(approved.status, 200);

  const status = await fetch(`${base}/api/agents/pair-status?code=${code}`);
  assert.equal(status.status, 200);
  const { token, agentId } = await status.json();
  assert.ok(token, 'the agent is handed a token');
  return { token, agentId };
}

let laptop;
let agentWs;

test('the computer pairs its agent to the account', async () => {
  laptop = await pairAgent(ownerCookie, 'owners-laptop');

  // The token carries the owner's id — that binding is the entire mechanism
  // by which a second device finds this machine later.
  const res = await fetch(`${base}/api/me`, { headers: { Cookie: ownerCookie } });
  const me = await res.json();
  assert.equal(me.agents.length, 1);
  assert.equal(me.agents[0].hostname, 'owners-laptop');
});

test('the phone is handed the machine after signing in as the same account', async () => {
  // The computer's agent comes online and stays online for the rest of the
  // file: the relay turns away a second connection for a machine that already
  // has a live one, and reconnecting per test would race that check.
  agentWs = await openWs('/agent-ws');
  agentWs.send(JSON.stringify({
    type: 'agent:auth',
    payload: { token: laptop.token, hostname: 'owners-laptop', os: 'darwin', version: '0.2.2' },
  }));
  await waitForMessage(agentWs, 'agent:auth:ok');

  // A second device — no shared storage with the desktop, only the account
  // cookie that signing in produced.
  const phone = await openWs('/ws', { Cookie: ownerCookie });
  const list = await waitForMessage(phone, 'agents:list');

  const hostnames = (list.payload || []).map((a) => a.hostname);
  assert.ok(hostnames.includes('owners-laptop'), `phone sees the laptop, got ${JSON.stringify(hostnames)}`);

  phone.close();
});

test('a different account is shown none of it', async () => {
  // The same relay, the same live agent, a different identity. If the hosted
  // deployment ever resolves two visitors to one user id, this is the test
  // that fails — and what it would mean is one stranger holding another
  // person's shell.
  const otherPhone = await openWs('/ws', { Cookie: strangerCookie });
  const list = await waitForMessage(otherPhone, 'agents:list');

  assert.deepEqual(list.payload || [], [], 'a stranger is shown no machines');

  otherPhone.close();
});

test('a browser with no session is refused the relay outright', async () => {
  // Not merely shown an empty list: on a hosted deployment an unauthenticated
  // socket has no user id to route by and must not be upgraded at all.
  await assert.rejects(() => openWs('/ws'), /upgrade 401/);
});
