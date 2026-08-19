import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const tmuxJs = readFileSync(join(here, '..', '..', 'agent', 'services', 'tmux.js'), 'utf-8');
const statesJs = readFileSync(join(here, '..', 'src-client', 'modules', 'claude-states.js'), 'utf-8');

/**
 * The gh-20 fix routes scrolls on the foreground command name, which the
 * browser can only see if the agent sends it. It previously did so only for
 * Claude panes: every other terminal got a states entry with isClaude, state,
 * cwd and alternateOn, and no command at all.
 *
 * That makes the client-side decision silently inert for exactly the panes the
 * bug affects — an attached tmux is not a Claude pane. These tests pin both
 * ends of that wire, because a regression here reintroduces the bug without
 * failing any behavioural test of chooseScrollAction.
 */

test('the agent reports the foreground command for non-Claude terminals', () => {
  // The branch that marks remaining non-Claude terminals.
  const marker = 'results[id] = { isClaude: false, state: null, command:';
  assert.ok(
    tmuxJs.includes(marker),
    'non-Claude states entries must carry command, or the browser cannot tell an attached tmux from a TUI',
  );
});

test('the agent reports a command field even when it knows nothing about the pane', () => {
  // The no-session-info default. Shape consistency matters: the client reads
  // info.command unconditionally.
  assert.match(
    tmuxJs,
    /results\[id\] = \{ isClaude: false, state: null, command: null, cwd: null, alternateOn: false \}/,
    'the unknown-pane default must include command so the payload shape is uniform',
  );
});

test('Claude panes still report their command', () => {
  // Claude entries always carried it; the fix must not have disturbed them.
  assert.ok(tmuxJs.includes("command: 'claude'"));
});

test('the client stores the foreground command alongside the alternate flag', () => {
  // Both are read together by the wheel handler, and storing one without the
  // other is the failure mode this guards.
  assert.match(statesJs, /termInfo\._alternateOn = !!info\.alternateOn;/);
  assert.match(statesJs, /termInfo\._foregroundCommand = info\.command \|\| null;/);
});
