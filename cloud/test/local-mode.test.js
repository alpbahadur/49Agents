import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const cloud = join(here, '..');

const read = (p) => readFileSync(join(cloud, p), 'utf8');
const configJs = read('src/config.js');
const indexJs = read('src/index.js');
const agentUi = read('src-client/modules/agent-ui.js');
const hudJs = read('src-client/modules/hud.js');
const appJs = read('src-client/app.js');
const tourJs = read('src-client/tutorial-tour.js');
const tutorialHtml = read('public/tutorial.html');

/**
 * Self-hosted ("local") mode.
 *
 * A self-hosted instance starts its own agent — ./49ctl start and the desktop
 * app both do — and that agent authenticates with the literal token 'dev',
 * which auth/agentAuth.js accepts without a signature check. Two things follow,
 * and both are pinned here:
 *
 *   1. Nothing should tell that user to go and pair a machine. They are
 *      already running the thing they would be installing.
 *   2. Because 'dev' is accepted and /agent-ws does no auth on upgrade,
 *      binding a routable interface hands a shell to the local network.
 */

test('local mode binds loopback by default', () => {
  // The combination that makes 0.0.0.0 dangerous here: an unauthenticated
  // /agent-ws upgrade plus a token that is accepted verbatim. Anyone on the
  // LAN could register as the user's agent, and an agent connection is
  // remote code execution by design.
  assert.match(configJs, /const defaultHost = localMode \? '127\.0\.0\.1' : '0\.0\.0\.0';/);
  assert.match(configJs, /host: process\.env\.HOST \|\| defaultHost/);

  // Same predicate as auth/localAuth.js isLocalMode(), which now reads
  // config.authMode rather than recomputing the OAuth check itself.
  assert.match(configJs, /const localMode = authMode === 'open' && !process\.env\.SKIP_CLOUD_AUTH;/);
  assert.match(configJs, /GITHUB_CLIENT_ID \|\| process\.env\.GOOGLE_CLIENT_ID/);
});

test('binding loopback is explained, and still overridable', () => {
  // Anyone reaching this box from a phone or another laptop needs to know why
  // it stopped working and how to opt back in.
  assert.match(indexJs, /Local mode: reachable from this machine only/);
  assert.match(indexJs, /HOST=0\.0\.0\.0/);
  // HOST is read before the default is applied, so an explicit value wins.
  assert.ok(configJs.indexOf('process.env.HOST ||') > -1);
});

test('a self-hosted user is not told to add a machine', () => {
  // The pulse is the only thing that ever pushed users toward the paste step,
  // and it fired purely on "no agent online" regardless of mode.
  const overlay = agentUi.slice(
    agentUi.indexOf('export function updateAgentOverlay'),
    agentUi.indexOf('export function isLocalMode')
  );
  assert.match(overlay, /if \(isLocalMode\(\)\) \{\s*\n\s*pulseAddMachineButton\(false\);/);
  assert.match(overlay, /showLocalAgentStatus\(true\);/);
  // Cloud mode keeps the nag: there, a machine really does need pairing.
  assert.match(overlay, /\} else \{\s*\n\s*pulseAddMachineButton\(true\);/);
});

test('unknown mode is treated as cloud', () => {
  // Failing open would hide the pairing prompt from a hosted user who needs
  // it. Failing closed only costs a self-hosted user a brief pulse.
  assert.match(agentUi, /window\.__tcAuthMode === 'local'/);
  // The catch leaves __tcAuthMode unset, and isLocalMode() only returns true
  // on an exact 'local' match, so an unreachable endpoint reads as cloud.
  assert.match(appJs, /which reads as cloud/);
  assert.match(agentUi, /window\.__tcAuthMode === 'local';/);
});

test('the mode is resolved before anything reads it', () => {
  // The telemetry bootstrap also sets __tcAuthMode, but it sits behind the
  // tutorial gate and may never run, so the overlay would read undefined.
  const init = appJs.slice(appJs.indexOf('async function init()'));
  const modeFetch = init.indexOf("fetch('/api/auth/mode')");
  const authCheck = init.indexOf("fetch('/auth/me'");
  assert.ok(modeFetch > -1, 'init must resolve the auth mode');
  assert.ok(modeFetch < authCheck, 'mode must be resolved before the rest of init');

  // The tutorial page does not run app.js and needs its own copy.
  assert.match(tutorialHtml, /fetch\('\/api\/auth\/mode'\)/);
  assert.match(tutorialHtml, /isLocalMode: \(\) => window\.__tcAuthMode === 'local'/);
});

test('the status line survives a HUD re-render', () => {
  // renderHud() reassigns the panel's innerHTML on every poll, so anything
  // appended from outside is wiped within the second. The pulse already used
  // a flag for this reason; the status line follows the same pattern.
  assert.match(hudJs, /if \(window\.__localAgentStarting\)/);
  assert.match(hudJs, /class="local-agent-status"/);
  assert.match(agentUi, /window\.__localAgentStarting = waiting;/);

  // And it must not call renderHud(), because hud.js already imports this
  // module — that would close an import cycle.
  const fn = agentUi
    .slice(agentUi.indexOf('function showLocalAgentStatus'), agentUi.length)
    .slice(0, 600)
    .replace(/^\s*\/\/.*$/gm, '');          // the comment explains the absence by name
  assert.ok(!/\brenderHud\(\)/.test(fn), 'must not call renderHud from agent-ui');
});

test('the connect-a-machine step is dropped when self-hosted', () => {
  // Not reworded — removed. ./49ctl start already connected this machine, so
  // a setup step at the end of the tour has nothing left to ask for.
  const step = tourJs.slice(tourJs.indexOf("skipIf: () => ctx.isLocalMode()"));
  assert.match(step.slice(0, 700), /prompt: \['Set up', 'Connect your own machine'/);

  // Hosted users still get it, and it still closes the tour.
  assert.match(step.slice(0, 700), /next: 'Finish'/);

  // With that step gone, the one before it has to carry the closing label,
  // or a self-hosted user ends the tour on a button reading "Next".
  assert.match(tourJs, /next: ctx\.isLocalMode\(\) \? 'Finish' : undefined/);
});

test('a second machine gets an address it can actually reach', () => {
  // The install command embeds the browser's origin, which on a self-hosted
  // instance is localhost — pasting that on another machine points its agent
  // back at itself. The server reports its own LAN address instead.
  assert.match(indexJs, /app\.get\('\/api\/network'/);
  assert.match(indexJs, /loopbackOnly/);
  assert.match(indexJs, /a\.family === 'IPv4' \|\| a\.family === 4/);

  // Substitution happens only in local mode; a hosted origin is already right.
  assert.match(agentUi, /if \(!isLocalMode\(\)\) return null;/);
  assert.match(agentUi, /const httpOrigin = reachable \? `http:\/\/\$\{reachable\.host\}` : location\.origin;/);
  assert.match(agentUi, /const httpHost = reachable \? reachable\.host : location\.host;/);
});

test('the dialog says what adding a machine is for', () => {
  // It used to open with "Copy the command below" and no statement of what
  // the feature does or which machine to run it on.
  const dialog = agentUi.slice(agentUi.indexOf('export function showAddMachineDialog'));
  assert.match(dialog.slice(0, 3000), /Run a second agent on <em>another<\/em> computer/);
  assert.match(dialog.slice(0, 3000), /on that machine/);
  assert.match(dialog.slice(0, 3000), /Nothing needs installing on the machine you are reading this on/);
});

test('loopback-only is called out before the command is copied', () => {
  // Otherwise the local-mode default hands over a command that cannot work,
  // and the failure surfaces on the other machine with no explanation.
  const dialog = agentUi.slice(agentUi.indexOf('export function showAddMachineDialog'));
  assert.match(dialog, /if \(net\.loopbackOnly\)/);
  assert.match(dialog, /cannot reach it yet/);
  assert.match(dialog, /HOST=0\.0\.0\.0 \.\/49ctl start/);
  // And the risk of opening it up is stated, not buried.
  assert.match(dialog, /can run commands on your machines/);
});

/**
 * AUTH_MODE — the explicit split between the two deployment shapes.
 *
 * Before this was explicit, "is there a login screen" was a side effect of
 * whether OAuth credentials happened to be present. That is a dangerous thing
 * to leave implicit: a hosted deployment that loses its client id silently
 * turns into an open one, and an open one is a shared identity that anybody
 * who reaches it gets to be.
 */
test('the deployment shape is explicit, and its inference is unchanged', () => {
  // Either mode may be stated outright.
  assert.match(configJs, /const authModeEnv = \(process\.env\.AUTH_MODE \|\| ''\)/);
  assert.match(configJs, /AUTH_MODE must be 'oauth' or 'open'/);

  // Unset, it infers exactly what used to be implied, so deployments that
  // never set it keep the behaviour they already had.
  assert.match(configJs, /const authMode = authModeEnv \|\| \(\(hasOAuth \|\| isProduction\) \? 'oauth' : 'open'\)/);
});

test('a hosted deployment refuses to start with a sign-in page it cannot serve', () => {
  // A login screen with no providers behind it locks everyone out for good,
  // and guest mode must not become the only way into a hosted instance.
  assert.match(configJs, /if \(authMode === 'oauth' && isProduction && !hasOAuth\)/);
  assert.match(configJs, /Refusing to start with a sign-in page that has no providers/);
});

test('the single-identity shortcut is confined to open deployments', () => {
  const middleware = read('src/auth/middleware.js');
  const relay = read('src/ws/relay.js');

  // local_auth and local_email_auth each hold one row (CHECK id = 1): they
  // describe this machine's owner. On a hosted deployment that row is
  // server-wide, so resolving a visitor through it would handof every visitor
  // the same account — and with it everyone else's machines.
  assert.match(middleware, /const singleTenant = config\.authMode === 'open';/);
  assert.match(middleware, /const localAuth = singleTenant \? getLocalAuth\(\) : null;/);
  assert.match(relay, /const localAuth = config\.authMode === 'open' \? getLocalAuth\(\) : null;/);
});

test('an open deployment reuses one identity instead of minting one per request', () => {
  const middleware = read('src/auth/middleware.js');
  const users = read('src/db/users.js');

  // upsertUser matches on github_id, google_id, then email. A local instance
  // has none of the three until its owner enters an email, so every cookieless
  // request used to fall through to the INSERT: a second browser never landed
  // on the same identity as the agent, and the users table grew without bound.
  assert.match(middleware, /getOrCreateLocalSharedUser\(instanceId, \{/);
  assert.match(users, /export function getOrCreateLocalSharedUser/);

  // Derived from the persisted instance id, so it is stable across restarts.
  assert.match(users, /createHash\('sha256'\)\.update\(`local:\$\{instanceId\}`\)/);
});
