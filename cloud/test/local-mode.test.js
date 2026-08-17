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

  // Same predicate as auth/localAuth.js isLocalMode(). It is recomputed rather
  // than imported because localAuth imports config, which would be a cycle.
  assert.match(configJs, /const localMode = !hasOAuth && !isProduction && !process\.env\.SKIP_CLOUD_AUTH;/);
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

test('the tutorial ending matches the mode', () => {
  // Telling a self-hosted user to install an agent sends them after software
  // that is running right now.
  assert.match(tourJs, /ctx\.isLocalMode\(\)/);
  assert.match(tourJs, /Your machine is already connected/);
  // The hosted wording is still there for the case that needs it.
  assert.match(tourJs, /Connect your own machine/);
});
