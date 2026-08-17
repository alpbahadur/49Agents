/**
 * The 49Agents tour.
 *
 * Five chapters, registered on window.TUT_GUIDES['getting-started'].
 *
 * Chapters are declarative: each is a `setup()` that builds the scene from an
 * empty canvas plus a flat list of steps. That shape is what makes the arrow
 * keys work the way people expect — the runner can jump to any step index in
 * either direction, so ← goes back one *step*, not one chapter. An imperative
 * `await` chain cannot be rewound, which is why Back used to throw you to the
 * start of the previous chapter.
 *
 * Rewinding is done by replaying: re-run setup(), then fast-forward the
 * `apply()` of every step before the target. apply() is therefore required to
 * be idempotent and instant — it sets scene state, never narrates.
 *
 * Rules:
 *   1. Show first, ask second. The canvas is populated before anything is
 *      asked of the user.
 *   2. No step can trap anyone. Interactive steps race their gesture against
 *      Next, so someone with no keyboard still reaches the end.
 *   3. Every hotkey the app has gets taught somewhere in here.
 */
(function () {
  'use strict';

  window.TUT_GUIDES = window.TUT_GUIDES || {};

  const CHAPTERS = [
    { num: 'Chapter 1', name: 'Your whole fleet, one screen', desc: 'What 49Agents actually is, before you touch anything.' },
    { num: 'Chapter 2', name: 'Panes', desc: 'Ten kinds of pane, and the keys that summon them.' },
    { num: 'Chapter 3', name: 'Getting around', desc: 'Move mode, jump numbers, and never losing a pane again.' },
    { num: 'Chapter 4', name: 'Watching your agents', desc: 'The part that makes running many Claudes bearable.' },
    { num: 'Chapter 5', name: 'Running many at once', desc: 'Broadcast, mentions, tab groups, settings.' },
  ];

  // Every Tab chord in modules/shortcuts.js, so the tour can be checked
  // against the app rather than drifting from it.
  const CHORDS = {
    a: 'add-pane menu', q: 'cycle panes', w: 'close pane', d: 'machines HUD',
    u: 'usage HUD', h: 'hide overlays', s: 'settings', m: 'minimap',
    p: 'projects sidebar', '`': 'next tab in group', '=': 'new tab in group',
    '1-9': 'jump to pane',
  };

  window.TUT_GUIDES['getting-started'] = async function tour(ctx) {
    ctx.nav.chapters = CHAPTERS;

    await ctx.waitForClick('#tut-start-btn');
    ctx.tutOverlay.classList.add('hiding');
    await ctx.sleep(500);
    ctx.tutOverlay.classList.add('hidden');

    ctx.createHud();
    ctx.controls.style.display = '';

    const chapters = [chapter1(ctx), chapter2(ctx), chapter3(ctx), chapter4(ctx), chapter5(ctx)];
    await ctx.runChapters(chapters, CHAPTERS);
  };

  // ═══════════════════════════════════════════════════════════════════════
  //  Chapter 1 — the cold open
  //
  //  No clicks. A workspace assembles itself while the copy explains what is
  //  being assembled. The old tour opened with an "Add Machine" button and a
  //  fake connection spinner, so nothing of the product was visible until
  //  step four. Connecting a real machine is a chore and now lands at the end.
  // ═══════════════════════════════════════════════════════════════════════
  function chapter1(ctx) {
    const C = 'Your fleet';
    return {
      setup() {
        ctx.resetCanvas();
        ctx.renderHudWithDevice();
      },
      steps: [
        {
          say: [C, 'This is one canvas',
            'Not tabs, not splits. An infinite surface you place things on — and it remembers exactly where you left everything.'],
          ms: 4000,
        },
        {
          apply() {
            const a = ctx.createFakeTerminalPane(80, 90);   ctx.setClaudeState(a, 'working');
            const b = ctx.createFakeTerminalPane(720, 90);  ctx.setClaudeState(b, 'idle');
            const c = ctx.createFakeTerminalPane(80, 530);  ctx.setClaudeState(c, 'working');
          },
          say: [C, 'Every terminal is a real shell',
            'Real tmux sessions on real machines, with Claude Code running inside them. Close the tab and they keep going.'],
          ms: 4200,
        },
        {
          apply() {
            ctx.createFakeGitGraphPane(720, 530);
            ctx.createFakeBeadsPane(1300, 90);
            ctx.createFakeNotePane(1300, 480);
          },
          say: [C, 'And not only terminals',
            'Git graphs, issue tables, editors, notes, directories, live web pages — all on the same surface, next to the agent working on them.'],
          ms: 4400,
        },
        {
          apply() { ctx.setZoom(0.55, innerWidth / 2, innerHeight / 2); },
          undo()  { ctx.setZoom(1, innerWidth / 2, innerHeight / 2); },
          say: [C, 'Several machines could be in this shot',
            'Panes carry a label showing which machine they live on. No SSH, no jumping between windows — everything is here.'],
          ms: 4400,
        },
      ],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Chapter 2 — panes, and the keys that summon them
  // ═══════════════════════════════════════════════════════════════════════
  function chapter2(ctx) {
    const C = 'Panes';

    // The catalogue tour: one step each, so ← walks back through them.
    const CATALOGUE = [
      ['beads',        () => ctx.createFakeBeadsPane(860, 110),          'Issues',          '<kbd>B</kbd> — your beads tracker as a live table. Tag a terminal with an issue and its status shows in the header.'],
      ['file',         () => ctx.createFakeFilePane(200, 620),           'Editor',          '<kbd>F</kbd> — a real Monaco editor on a remote file. <kbd>Ctrl</kbd>+<kbd>S</kbd> saves it back.'],
      ['git-graph',    () => ctx.createFakeGitGraphPane(880, 500),       'Git graph',       '<kbd>G</kbd> — branches and commits, refreshing as your agents commit.'],
      ['conversations',() => ctx.createFakeConversationsPane(1440, 110), 'Claude sessions', '<kbd>C</kbd> — every past Claude Code conversation on that machine, searchable and exportable.'],
      ['folder',       () => ctx.createFakeFolderPane(1440, 460),        'Directory',       '<kbd>D</kbd> — a file tree you can open files from.'],
      ['iframe',       () => ctx.createFakeIframePane(1440, 800),        'Web page',        '<kbd>W</kbd> — your dev server, embedded. See the change the moment the agent makes it.'],
      ['note',         () => ctx.createFakeNotePane(880, 900),           'Note',            '<kbd>N</kbd> — markdown scratchpad. Handy for the plan the agents are working from.'],
    ];

    return {
      setup() {
        ctx.resetCanvas();
        ctx.renderHudWithDevice();
        ctx.addPaneBtn.style.display = '';
        ctx.showMenuItems(['terminal', 'note', 'file', 'git-graph', 'beads', 'iframe', 'folder', 'conversations']);
      },
      steps: [
        {
          apply() { ctx.spotlight(ctx.addPaneBtn); },
          undo()  { ctx.clearSpotlight(); },
          prompt: [C, 'Open the pane menu',
            'Click <span class="hl">+</span> — or press <kbd>Tab</kbd>+<kbd>A</kbd>. Holding <kbd>Tab</kbd> and tapping a letter is how most of this app is driven.'],
          wait: () => ctx.waitForClick(ctx.addPaneBtn, 'tut-glow-purple'),
        },
        {
          apply() { ctx.clearSpotlight(); ctx.paneMenu.classList.remove('hidden'); ctx.spotlight(ctx.paneMenu); },
          undo()  { ctx.clearSpotlight(); ctx.paneMenu.classList.add('hidden'); },
          prompt: [C, 'Pick Terminal',
            'Every type has a letter — <kbd>T</kbd> here. Once those are muscle memory you never open this menu again.'],
          wait: () => ctx.waitForMenuItemClick('terminal'),
        },
        {
          apply() { ctx.clearSpotlight(); ctx.paneMenu.classList.add('hidden'); },
          prompt: [C, 'Drop it anywhere',
            'Click to place. Hold <kbd>Shift</kbd> while clicking to stay in placement mode and drop one after another.'],
          wait: () => ctx.enterPlacementMode('terminal'),
          hint: 'Click the canvas to place it',
          // Whichever way the step ended, the canvas must match the narration.
          ensure() { if (!ctx.panes.length) ctx.createFakeTerminalPane(200, 160); },
        },
        {
          apply() { ctx.panes.length || ctx.createFakeTerminalPane(200, 160); },
          say: [C, 'The other nine', 'Watch — each of these is one letter away.'],
          ms: 2200,
        },
        ...CATALOGUE.map(([, make, title, body]) => ({
          apply: make,
          say: [C, title, body],
          ms: 2800,
        })),
        {
          apply() { ctx.setZoom(0.5, innerWidth / 2, innerHeight / 2); },
          undo()  { ctx.setZoom(1, innerWidth / 2, innerHeight / 2); },
          say: [C, 'Two more, not panes at all',
            'A <span class="hl">Project Area</span> is a labelled rectangle you draw around related panes. A <span class="hl">Checkpoint</span> pins a spot you can jump back to. Both keep a big canvas navigable.'],
          ms: 4800,
        },
        {
          apply() { ctx.setZoom(1, innerWidth / 2, innerHeight / 2); },
          say: [C, 'Closing them again',
            '<kbd>Tab</kbd>+<kbd>W</kbd> closes the focused pane, and <kbd>Ctrl</kbd>+<kbd>W</kbd> does the same. <kbd>Tab</kbd>+<kbd>Q</kbd> cycles through panes one at a time.'],
          ms: 4600,
        },
      ],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Chapter 3 — navigation
  // ═══════════════════════════════════════════════════════════════════════
  function chapter3(ctx) {
    const C = 'Getting around';
    return {
      setup() {
        ctx.resetCanvas();
        ctx.renderHudWithDevice();
        const a = ctx.createFakeTerminalPane(120, 120); ctx.setClaudeState(a, 'working');
        ctx.createFakeGitGraphPane(820, 140);
        ctx.createFakeBeadsPane(120, 620);
        const d = ctx.createFakeTerminalPane(900, 640); ctx.setClaudeState(d, 'idle');
        ctx.createFakeNotePane(1500, 200);
      },
      steps: [
        {
          say: [C, 'Drag, resize, snap',
            'Drag a header to move a pane, drag the corner to resize. Panes snap to their neighbours, so a canvas stays tidy without any grid.'],
          ms: 4000,
        },
        {
          prompt: [C, 'Try it', 'Drag any pane by its header. Edges will snap as you get close.'],
          wait: () => ctx.waitForDrag(ctx.panes[0], 30),
        },
        {
          say: [C, 'Zooming',
            '<kbd>Ctrl</kbd>+scroll zooms the canvas. <kbd>Ctrl</kbd>+<kbd>+</kbd> and <kbd>Ctrl</kbd>+<kbd>−</kbd> zoom just the focused pane, and <kbd>Ctrl</kbd>+<kbd>0</kbd> resets it.'],
          ms: 4600,
        },
        {
          apply() { ctx.setZoom(0.45, innerWidth / 2, innerHeight / 2); },
          undo()  { ctx.setZoom(1, innerWidth / 2, innerHeight / 2); },
          say: [C, 'Zoom out to think',
            'Pull back for the whole picture, push in to focus. Your layout is saved either way.'],
          ms: 3600,
        },
        {
          apply() { ctx.setZoom(1, innerWidth / 2, innerHeight / 2); },
          prompt: [C, 'Move mode',
            'Tap <kbd>Tab</kbd> twice, quickly. The canvas dims and you steer between panes with <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>, then <kbd>Enter</kbd> to land on one, or <kbd>Esc</kbd> to back out.'],
          wait: () => ctx.waitForMoveMode(),
          hint: 'Double-tap Tab — or press Next to skip',
        },
        {
          prompt: [C, 'Steer with WASD', 'Move between panes. <kbd>Enter</kbd> focuses the one you land on.'],
          wait: () => ctx.waitForWASDNav(2),
          // Only worth showing if they actually entered move mode.
          skipIf: () => !document.querySelector('.pane.move-mode-active'),
        },
        {
          say: [C, 'Or jump straight there',
            'Every pane gets a number. <kbd>Tab</kbd>+<kbd>1</kbd> through <kbd>Tab</kbd>+<kbd>9</kbd> flies you to it instantly — the fastest way to move once you have more panes than screen.'],
          ms: 4600,
        },
        {
          say: [C, 'A map when it gets big',
            '<kbd>Tab</kbd>+<kbd>M</kbd> toggles a minimap of the whole canvas. <kbd>Tab</kbd>+<kbd>P</kbd> opens the projects sidebar to jump between areas and checkpoints.'],
          ms: 4600,
        },
      ],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Chapter 4 — agents
  //
  //  The pane backlight telling you an agent is blocked is the reason this
  //  product exists, and the old tour never mentioned it once.
  // ═══════════════════════════════════════════════════════════════════════
  function chapter4(ctx) {
    const C = 'Your agents';
    let p1, p2, p3, p4, toast;

    return {
      setup() {
        ctx.resetCanvas();
        ctx.renderHudWithDevice();
        p1 = ctx.createFakeTerminalPane(140, 130);
        p2 = ctx.createFakeTerminalPane(800, 130);
        p3 = ctx.createFakeTerminalPane(140, 600);
        p4 = ctx.createFakeTerminalPane(800, 600);
        [p1, p2, p3, p4].forEach(p => ctx.setClaudeState(p, 'idle'));
        toast = null;
      },
      steps: [
        {
          say: [C, 'Panes tell you how Claude is doing',
            'You do not read four terminals to find the one that needs you. The pane itself changes colour.'],
          ms: 3800,
        },
        {
          apply() { ctx.setClaudeState(p1, 'working'); ctx.setClaudeState(p3, 'working'); },
          undo()  { ctx.setClaudeState(p1, 'idle');    ctx.setClaudeState(p3, 'idle'); },
          say: [C, 'Blue means working', 'A soft blue backlight, breathing gently. Claude is busy and wants nothing from you.'],
          ms: 3800,
        },
        {
          apply() {
            ctx.setClaudeState(p2, 'permission');
            ctx.clearTutToasts();
            toast = ctx.showTutToast('permission', 'Claude needs permission', 'my-server · Bash(rm -rf build/)');
          },
          undo()  { ctx.setClaudeState(p2, 'idle'); ctx.clearTutToasts(); },
          prompt: [C, 'Red means blocked',
            'This agent is stopped waiting for a yes or no. It glows red from across the room and a notification appears. <span class="hl">Click the notification</span> to jump straight to that pane.'],
          wait: () => toast.waitForClick(),
          ensure() { ctx.clearTutToasts(); ctx.setClaudeState(p2, 'working'); },
        },
        {
          apply() {
            ctx.setClaudeState(p4, 'question');
            ctx.clearTutToasts();
            ctx.showTutToast('question', 'Claude asked a question', 'my-server · "Which database should I use?"');
          },
          undo()  { ctx.setClaudeState(p4, 'idle'); ctx.clearTutToasts(); },
          say: [C, 'Purple means it asked you something',
            'A question rather than a permission. Same idea — you see it without looking. Notifications can be snoozed per terminal when an agent gets chatty.'],
          ms: 4800,
        },
        {
          apply() { ctx.clearTutToasts(); ctx.setClaudeState(p4, 'idle'); ctx.createUsageHud(); ctx.spotlight('#agents-hud'); },
          undo()  { ctx.clearSpotlight(); },
          say: [C, 'How much Claude you have left',
            '<kbd>Tab</kbd>+<kbd>U</kbd> toggles usage against your 5-hour and weekly windows, per model, with the reset countdown. Running ten agents burns a limit quickly.'],
          ms: 5000,
        },
        {
          apply() { ctx.clearSpotlight(); ctx.spotlight('#hud-container'); },
          undo()  { ctx.clearSpotlight(); },
          say: [C, 'And which machines are up',
            '<kbd>Tab</kbd>+<kbd>D</kbd> toggles the machines panel — CPU, RAM and GPU per machine. <kbd>Tab</kbd>+<kbd>H</kbd> hides every overlay at once when you want the canvas bare.'],
          ms: 5000,
        },
      ],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Chapter 5 — power features, then the one real chore
  // ═══════════════════════════════════════════════════════════════════════
  function chapter5(ctx) {
    const C = 'Many at once';
    return {
      setup() {
        ctx.resetCanvas();
        ctx.renderHudWithDevice();
        ctx.createFakeTerminalPane(140, 150);
        ctx.createFakeTerminalPane(800, 150);
        ctx.createFakeTerminalPane(470, 620);
      },
      steps: [
        {
          prompt: [C, 'Talk to several agents at once',
            '<kbd>Shift</kbd>+click two or three terminals to select them. <kbd>Shift</kbd>+drag on empty canvas does the same with a rubber band.'],
          wait: () => ctx.waitForBroadcastSelect(2),
        },
        {
          prompt: [C, 'Now type once',
            'Whatever you type goes to every selected terminal. This is how you start the same task on five machines — or tell them all to stop.'],
          wait: () => ctx.waitForBroadcastType(),
          skipIf: () => !document.querySelector('.pane.broadcast-selected'),
        },
        {
          prompt: [C, 'Escape clears it',
            'Press <kbd>Esc</kbd> to drop the selection. <kbd>Tab</kbd>+<kbd>W</kbd> closes every selected pane at once.'],
          wait: () => ctx.waitForEscClear(),
          ms: 9000,
          skipIf: () => !document.querySelector('.pane.broadcast-selected'),
          ensure() { ctx.clearBroadcastSelect(); },
        },
        {
          say: [C, 'Point an agent at something',
            '<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>@</kbd>, or the <span class="hl">@</span> button on a file, web or issue pane, pastes a reference to it into whichever terminal you choose. That is how something on the canvas becomes context for Claude.'],
          ms: 5400,
        },
        {
          say: [C, 'Stack terminals into tabs',
            'Drag one terminal onto another to make a tab group. <kbd>Tab</kbd>+<kbd>`</kbd> cycles the tabs, <kbd>Tab</kbd>+<kbd>=</kbd> adds one.'],
          ms: 4800,
        },
        {
          say: [C, 'And the rest',
            '<kbd>Tab</kbd>+<kbd>S</kbd> opens settings — themes, fonts, night mode, notification sounds. Every chord is on the <span class="hl">Shortcuts</span> button below, and in the <kbd>?</kbd> menu once you are back in the app.'],
          ms: 5200,
          // On a self-hosted instance this is the last thing said, so it is
          // what has to carry the closing label.
          next: ctx.isLocalMode() ? 'Finish' : undefined,
        },
        {
          // Dropped entirely when self-hosted. ./49ctl start already launched
          // an agent for this machine and it connects on its own, so there is
          // no setup left to describe — a "connect your machine" step at the
          // end of the tour would be asking for something already done.
          // Adding a *second* machine is discoverable from + Add Machine.
          skipIf: () => ctx.isLocalMode(),
          apply() { ctx.spotlight('#hud-container'); },
          undo()  { ctx.clearSpotlight(); },
          prompt: ['Set up', 'Connect your own machine',
            'Everything so far was a simulation. To make it real, run the agent install on any machine you work on and it appears in this panel. Add as many as you like.'],
          next: 'Finish',
          ensure() { ctx.clearSpotlight(); },
        },
      ],
    };
  }
})();
