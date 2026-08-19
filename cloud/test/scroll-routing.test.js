import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseScrollAction, isNestedMultiplexer } from '../src-client/modules/scroll-routing.js';

/**
 * gh-20: scrolling a pane attached to an external tmux session cycled previous
 * commands instead of scrolling.
 *
 * An attached inner tmux draws on the alternate screen, so from the outside it
 * is indistinguishable from vim or htop. The wheel handler treated alternate
 * screen as "a TUI that scrolls with arrows" and sent Up/Down into the pane;
 * the inner tmux passed them to its shell, where readline reads Up as
 * previous-command. So a scroll gesture silently rewrote the line being typed.
 *
 * Verified directly against tmux 3.6a on an isolated server: with a client
 * attached inside the pane, the outer pane reports alternate_on=1 and
 * pane_current_command=tmux.
 */

test('an ordinary shell scrolls xterm own buffer', () => {
  assert.equal(chooseScrollAction({ mouseActive: false, alternateOn: false, foregroundCommand: 'zsh' }), 'buffer');
  assert.equal(chooseScrollAction({ mouseActive: false, alternateOn: false, foregroundCommand: 'bash' }), 'buffer');
});

test('an alternate-screen TUI still gets arrow keys', () => {
  // The behaviour that must not regress: vim, htop and less have no scrollback
  // to offer, so arrows are the only way to move their viewport.
  for (const cmd of ['vim', 'nvim', 'htop', 'less', 'nano', 'claude']) {
    assert.equal(
      chooseScrollAction({ mouseActive: false, alternateOn: true, foregroundCommand: cmd }),
      'arrows',
      `${cmd} should still scroll with arrows`,
    );
  }
});

test('an attached tmux gets nothing rather than arrow keys', () => {
  // The fix. Arrows here reach the inner session's shell, not a scroll region.
  assert.equal(chooseScrollAction({ mouseActive: false, alternateOn: true, foregroundCommand: 'tmux' }), 'none');
});

test('an attached screen session is treated the same way', () => {
  assert.equal(chooseScrollAction({ mouseActive: false, alternateOn: true, foregroundCommand: 'screen' }), 'none');
});

test('mouse reporting wins over everything, including a nested tmux', () => {
  // A nested tmux with `set -g mouse on` reports mouse events, and
  // re-dispatching the wheel lets it scroll natively. This is the one
  // configuration where scrolling a nested session works properly, so the
  // mouse check has to come first.
  assert.equal(chooseScrollAction({ mouseActive: true, alternateOn: true, foregroundCommand: 'tmux' }), 'mouse');
  assert.equal(chooseScrollAction({ mouseActive: true, alternateOn: false, foregroundCommand: 'zsh' }), 'mouse');
  assert.equal(chooseScrollAction({ mouseActive: true, alternateOn: true, foregroundCommand: 'htop' }), 'mouse');
});

test('a nested multiplexer not on the alternate screen scrolls the buffer', () => {
  // tmux briefly appears as the foreground command for a plain invocation like
  // `tmux ls`, which is not an attached client and leaves no alternate screen.
  // That must not suppress an ordinary scroll.
  assert.equal(chooseScrollAction({ mouseActive: false, alternateOn: false, foregroundCommand: 'tmux' }), 'buffer');
});

test('an unknown foreground command keeps the previous behaviour', () => {
  // The states payload carried no command at all before this change, and a
  // pane can report none. Absent information must not turn into suppression:
  // fall back to what alternate screen alone implies.
  assert.equal(chooseScrollAction({ mouseActive: false, alternateOn: true, foregroundCommand: null }), 'arrows');
  assert.equal(chooseScrollAction({ mouseActive: false, alternateOn: true, foregroundCommand: undefined }), 'arrows');
  assert.equal(chooseScrollAction({ mouseActive: false, alternateOn: true, foregroundCommand: '' }), 'arrows');
});

test('chooseScrollAction tolerates being called with nothing', () => {
  assert.equal(chooseScrollAction(), 'buffer');
  assert.equal(chooseScrollAction({}), 'buffer');
});

test('isNestedMultiplexer matches on the command name, not the path', () => {
  // tmux normally reports a bare name, but a wrapper script or an absolute
  // path would otherwise slip past a plain equality check.
  assert.ok(isNestedMultiplexer('tmux'));
  assert.ok(isNestedMultiplexer('/opt/homebrew/bin/tmux'));
  assert.ok(isNestedMultiplexer('TMUX'));
  assert.ok(isNestedMultiplexer('  tmux  '));
  assert.ok(isNestedMultiplexer('screen'));
});

test('isNestedMultiplexer does not match names that merely contain tmux', () => {
  // tmuxinator and tmux-mem-cpu-load are not attached clients.
  assert.equal(isNestedMultiplexer('tmuxinator'), false);
  assert.equal(isNestedMultiplexer('tmux-mem-cpu-load'), false);
  assert.equal(isNestedMultiplexer('screenfetch'), false);
  assert.equal(isNestedMultiplexer(null), false);
  assert.equal(isNestedMultiplexer(''), false);
});
