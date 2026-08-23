// ─── Scroll Routing ───────────────────────────────────────────────────────
// Where a wheel gesture over a terminal pane should go. Three destinations,
// and picking the wrong one does not merely fail to scroll — it can type into
// the user's shell.
//
// Pure so the decision table is directly testable; the wheel handler in
// editors.js owns the actual dispatch.

// A pane whose foreground process is tmux is a client attached to another
// session. That inner tmux draws on the alternate screen, so it looks
// identical to vim or htop from the outside, but arrow keys mean something
// entirely different: they reach the inner session's shell, where readline
// treats Up as previous-command.
const NESTED_MULTIPLEXERS = new Set(['tmux', 'screen']);

export function isNestedMultiplexer(foregroundCommand) {
  if (!foregroundCommand) return false;
  // tmux reports the bare command name, but a wrapper or a versioned binary
  // can arrive with a path or suffix attached.
  const name = String(foregroundCommand).trim().split('/').pop().toLowerCase();
  return NESTED_MULTIPLEXERS.has(name);
}

/**
 * Decide how to route a scroll.
 *
 * 'mouse'  — the running app has mouse reporting on, so re-dispatch the wheel
 *            and let it handle the gesture itself. Correct for a nested tmux
 *            with `set -g mouse on` too, which is why this is checked first.
 * 'arrows' — an alternate-screen TUI with no mouse reporting. It has no
 *            scrollback of its own to offer, so arrow keys are the only way to
 *            move its viewport.
 * 'buffer' — an ordinary shell: scroll xterm's own scrollback.
 * 'none'   — an attached inner multiplexer with mouse reporting off. Arrows
 *            would land on its shell's command line, and xterm's alternate
 *            buffer holds no scrollback to move, so there is nothing safe to
 *            do. Doing nothing beats corrupting the line the user is typing.
 */
export function chooseScrollAction({ mouseActive, alternateOn, foregroundCommand } = {}) {
  if (mouseActive) return 'mouse';
  if (!alternateOn) return 'buffer';
  if (isNestedMultiplexer(foregroundCommand)) return 'none';
  return 'arrows';
}
