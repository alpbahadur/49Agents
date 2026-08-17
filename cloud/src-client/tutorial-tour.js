/**
 * The 49Agents tour.
 *
 * One guide, five short chapters, registered on window.TUT_GUIDES['getting-started'].
 * It replaces the old getting-started + panes pair, which between them ran 27
 * gated prompts and taught three of the ten pane types.
 *
 * Two rules shape everything here:
 *
 *   1. Show first, ask second. The canvas is already populated when the tour
 *      opens, so the product sells itself before anyone is asked to click.
 *   2. No beat can trap the user. Every interactive step is written as
 *      ctx.beat({ wait: <gesture> }), and beat() always races that gesture
 *      against the Next button. Someone on a phone with no Tab key still
 *      reaches the end.
 */
(function () {
  'use strict';

  window.TUT_GUIDES = window.TUT_GUIDES || {};

  const CHAPTERS = [
    { num: 'Chapter 1', name: 'Your whole fleet, one screen', desc: 'What 49Agents actually is, before you touch anything.' },
    { num: 'Chapter 2', name: 'Panes', desc: 'Ten kinds of pane. Place them anywhere you like.' },
    { num: 'Chapter 3', name: 'Getting around', desc: 'Move mode, jump numbers, and never losing a pane again.' },
    { num: 'Chapter 4', name: 'Watching your agents', desc: 'The part that makes running many Claudes bearable.' },
    { num: 'Chapter 5', name: 'Running many at once', desc: 'Broadcast, mentions, and where to go next.' },
  ];

  window.TUT_GUIDES['getting-started'] = async function tour(ctx) {
    ctx.nav.chapters = CHAPTERS;

    // ── Welcome ──────────────────────────────────────────────────────────
    await ctx.waitForClick('#tut-start-btn');
    ctx.tutOverlay.classList.add('hiding');
    await ctx.sleep(500);
    ctx.tutOverlay.classList.add('hidden');

    ctx.createHud();
    ctx.controls.style.display = '';

    // Resume where they left off if they bailed out mid-tour.
    let idx = ctx.loadResume();
    if (idx >= CHAPTERS.length) idx = 0;

    // ── Chapter loop ─────────────────────────────────────────────────────
    // Each chapter is a self-contained async function that returns 'back',
    // 'next' or undefined. Chapters always start from a clean canvas, so
    // going back is just "run that chapter again".
    const chapters = [chapter1, chapter2, chapter3, chapter4, chapter5];

    while (idx < chapters.length) {
      ctx.nav.chapterIdx = idx;
      ctx.nav.stepIdx = 0;          // progress is per-chapter, not per-tour
      ctx.saveResume(idx);
      ctx.renderDots();

      const c = CHAPTERS[idx];
      await ctx.chapterCard(c.num, c.name, c.desc);

      const outcome = await chapters[idx](ctx);

      if (outcome === 'back' && idx > 0) {
        ctx.resetCanvas();
        idx = ctx.nav.backTo !== null && ctx.nav.backTo !== undefined ? ctx.nav.backTo : idx - 1;
        ctx.nav.backTo = null;
        continue;
      }
      idx++;
    }

    // ── Done ─────────────────────────────────────────────────────────────
    ctx.hidePrompt();
    ctx.clearSpotlight();
    await ctx.markTutorial('completed');
    ctx.clearResume();
    await ctx.sleep(300);
    ctx.tutComplete.classList.add('visible');
  };

  // ═══════════════════════════════════════════════════════════════════════
  //  Chapter 1 — the cold open
  //
  //  No clicks at all. A workspace assembles itself while the copy explains
  //  what is being assembled. The old tour spent its first three steps on an
  //  "Add Machine" button and a fake 1.5s connection spinner; a new user saw
  //  nothing of the product until step four. Connecting a real machine is a
  //  chore, so it now lives at the very end, once they want one.
  // ═══════════════════════════════════════════════════════════════════════
  async function chapter1(ctx) {
    const C = 'Your fleet';
    ctx.nav.stepTotal = 4;

    ctx.renderHudWithDevice();

    // Panes are created before the narration that describes them, not after.
    // A beat can end the instant it starts — the user pressed Next, or hit
    // Right twice — and the canvas must never be emptier than the copy claims.
    // Staggering is done with pure setTimeout so it keeps running regardless
    // of how fast someone clicks through.
    const stagger = (fn, ms) => setTimeout(fn, ms);

    let r = await ctx.say(C, 'This is one canvas',
      'Not tabs, not splits. An infinite surface you place things on — and it remembers exactly where you left everything.', 3800);
    if (r === 'back') return 'back';

    // Terminals, each already mid-task.
    const t1 = ctx.createFakeTerminalPane(80, 90);
    ctx.setClaudeState(t1, 'working');
    stagger(() => {
      const t2 = ctx.createFakeTerminalPane(720, 90);
      ctx.setClaudeState(t2, 'idle');
    }, 450);
    stagger(() => {
      const t3 = ctx.createFakeTerminalPane(80, 530);
      ctx.setClaudeState(t3, 'working');
    }, 850);

    r = await ctx.say(C, 'Every terminal is a real shell',
      'Real tmux sessions on real machines, with Claude Code running inside them. Close the tab and they keep going.', 4200);
    if (r === 'back') return 'back';

    // Then the non-terminal panes, so breadth lands early.
    ctx.createFakeGitGraphPane(720, 530);
    stagger(() => ctx.createFakeBeadsPane(1300, 90), 350);
    stagger(() => ctx.createFakeNotePane(1300, 480), 700);

    r = await ctx.say(C, 'And not only terminals',
      'Git graphs, issue tables, editors, notes, directories, live web pages — all on the same surface, next to the agent working on them.', 4400);
    if (r === 'back') return 'back';

    // Pull back so the whole workspace is visible at once. This is the shot.
    ctx.setZoom(0.55, window.innerWidth / 2, window.innerHeight / 2);
    await ctx.sleep(700);

    r = await ctx.say(C, 'Three machines could be in this shot',
      'Panes carry a label showing which machine they live on. No SSH, no jumping between windows — everything is here.', 4200);
    if (r === 'back') return 'back';

    ctx.setZoom(1, window.innerWidth / 2, window.innerHeight / 2);
    await ctx.sleep(500);
    return 'next';
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Chapter 2 — panes
  //
  //  The old tour walked the add-menu three times and made the user click
  //  through two invented filesystem modals. Here they place exactly one pane
  //  by hand; the rest of the catalogue is demonstrated for them.
  // ═══════════════════════════════════════════════════════════════════════
  async function chapter2(ctx) {
    const C = 'Panes';
    ctx.resetCanvas();
    ctx.renderHudWithDevice();
    ctx.addPaneBtn.style.display = '';

    // ── One real placement, start to finish ──
    ctx.showMenuItems(['terminal', 'note', 'file', 'git-graph', 'beads', 'iframe', 'folder', 'conversations']);
    ctx.spotlight(ctx.addPaneBtn);
    ctx.showPrompt(C, 'Open the pane menu',
      'Click <span class="hl">+</span>. There is a keyboard route too — <kbd>Tab</kbd>+<kbd>A</kbd> — which is worth learning early.', 0, 4);

    let r = await ctx.beat({ wait: () => ctx.waitForClick(ctx.addPaneBtn, 'tut-glow-purple') });
    if (r === 'back') return 'back';
    ctx.clearSpotlight();
    ctx.paneMenu.classList.remove('hidden');

    ctx.spotlight(ctx.paneMenu);
    ctx.showPrompt(C, 'Pick Terminal',
      'Ten pane types live here. Each has a letter — <kbd>T</kbd> for terminal — so once it is muscle memory you never open this menu again.', 1, 4);
    r = await ctx.beat({ wait: () => ctx.waitForMenuItemClick('terminal') });
    if (r === 'back') return 'back';
    ctx.clearSpotlight();
    ctx.paneMenu.classList.add('hidden');

    ctx.showPrompt(C, 'Drop it anywhere',
      'Click to place. Hold <kbd>Shift</kbd> while clicking and you stay in placement mode, dropping one pane after another.', 2, 4);
    r = await ctx.beat({ wait: () => ctx.enterPlacementMode('terminal'), hint: '<span class="tut-waiting">Click the canvas to place it</span>' + ctx.ARROW_KEYS });
    if (r === 'back') return 'back';
    // If they pressed Next instead of placing, put one down so the canvas is
    // never emptier than the narration claims.
    if (r !== 'action' && !ctx.panes.length) ctx.createFakeTerminalPane(200, 160);

    // ── The rest of the catalogue, demonstrated ──
    ctx.showPrompt(C, 'The other nine', 'Watch — each of these is one menu pick away.', 3, 4);
    await ctx.sleep(700);

    const tour = [
      [() => ctx.createFakeBeadsPane(860, 110),         'Issues',         'Your beads tracker as a live table. Tag a terminal with an issue and its status shows in the header.'],
      [() => ctx.createFakeFilePane(200, 620),          'Editor',         'A real Monaco editor on a remote file. Ctrl+S saves it back.'],
      [() => ctx.createFakeGitGraphPane(880, 500),      'Git graph',      'Branches and commits, refreshing as your agents commit.'],
      [() => ctx.createFakeConversationsPane(1440, 110), 'Claude sessions', 'Every past Claude Code conversation on that machine, searchable and exportable.'],
      [() => ctx.createFakeFolderPane(1440, 460),       'Directory',      'A file tree you can open files from.'],
      [() => ctx.createFakeIframePane(1440, 800),       'Web page',       'Your dev server, embedded — see the change the moment the agent makes it.'],
      [() => ctx.createFakeNotePane(880, 900),          'Note',           'Markdown scratchpad. Handy for the plan the agents are working from.'],
    ];

    for (const [make, title, body] of tour) {
      make();
      ctx.showPrompt(C, title, body, 3, 4);
      const rr = await ctx.beat({ auto: 2600 });
      if (rr === 'back') return 'back';
    }

    ctx.setZoom(0.5, window.innerWidth / 2, window.innerHeight / 2);
    await ctx.sleep(600);
    r = await ctx.say(C, 'Two more, not panes at all',
      'A <span class="hl">Project Area</span> is a labelled rectangle you draw around related panes. A <span class="hl">Checkpoint</span> pins a spot you can jump back to. Both keep a big canvas navigable.', 4600);
    if (r === 'back') return 'back';
    ctx.setZoom(1, window.innerWidth / 2, window.innerHeight / 2);
    await ctx.sleep(400);

    return 'next';
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Chapter 3 — navigation
  //
  //  Move mode is the signature interaction and has no visual affordance
  //  whatsoever, so it is the one keyboard gesture worth gating on — softly.
  // ═══════════════════════════════════════════════════════════════════════
  async function chapter3(ctx) {
    const C = 'Getting around';
    ctx.resetCanvas();
    ctx.renderHudWithDevice();

    // A spread-out workspace to navigate.
    const a = ctx.createFakeTerminalPane(120, 120);
    ctx.setClaudeState(a, 'working');
    ctx.createFakeGitGraphPane(820, 140);
    ctx.createFakeBeadsPane(120, 620);
    const d = ctx.createFakeTerminalPane(900, 640);
    ctx.setClaudeState(d, 'idle');
    ctx.createFakeNotePane(1500, 200);

    let r = await ctx.say(C, 'Drag, resize, snap',
      'Drag a header to move a pane, drag the corner to resize. Panes snap to their neighbours so a canvas stays tidy without any grid.', 4000);
    if (r === 'back') return 'back';

    ctx.showPrompt(C, 'Try it',
      'Drag any pane by its header. Edges will snap as you get close.', 1, 5);
    r = await ctx.beat({ wait: () => ctx.waitForDrag(ctx.panes[0], 30) });
    if (r === 'back') return 'back';

    r = await ctx.say(C, 'Zoom out to think',
      'Ctrl+scroll zooms the canvas, or use the buttons. Zoom out for the whole picture, in to focus. Panes zoom independently with Ctrl and +/−.', 4200);
    if (r === 'back') return 'back';

    ctx.setZoom(0.45, window.innerWidth / 2, window.innerHeight / 2);
    await ctx.sleep(800);
    ctx.setZoom(1, window.innerWidth / 2, window.innerHeight / 2);
    await ctx.sleep(400);

    // Move mode — the one gesture genuinely worth practising.
    ctx.showPrompt(C, 'Move mode',
      'Tap <kbd>Tab</kbd> twice, quickly. The canvas dims and you steer between panes with <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>, then <kbd>Enter</kbd> to land on one.', 3, 5);
    r = await ctx.beat({
      wait: () => ctx.waitForMoveMode(),
      hint: '<span class="tut-waiting">Double-tap Tab — or press Next to skip</span>' + ctx.ARROW_KEYS,
    });
    if (r === 'back') return 'back';

    if (r === 'action') {
      ctx.showPrompt(C, 'Steer with WASD',
        'Move between panes. <kbd>Enter</kbd> focuses the one you land on, <kbd>Esc</kbd> backs out.', 3, 5);
      const rr = await ctx.beat({ wait: () => ctx.waitForWASDNav(2) });
      if (rr === 'back') return 'back';
    }

    r = await ctx.say(C, 'Or jump straight there',
      'Every pane gets a number. <kbd>Tab</kbd>+<kbd>1</kbd> through <kbd>Tab</kbd>+<kbd>9</kbd> flies you to it instantly — the fastest way to move once you have more panes than screen.', 4400);
    if (r === 'back') return 'back';

    r = await ctx.say(C, 'And a map when it gets big',
      '<kbd>Tab</kbd>+<kbd>M</kbd> shows a minimap of the whole canvas. <kbd>Tab</kbd>+<kbd>P</kbd> opens the projects sidebar to jump between areas and checkpoints.', 4400);
    if (r === 'back') return 'back';

    return 'next';
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Chapter 4 — agents
  //
  //  Entirely new. The pane backlight telling you an agent is blocked is the
  //  reason this product exists and the old tour never mentioned it once.
  // ═══════════════════════════════════════════════════════════════════════
  async function chapter4(ctx) {
    const C = 'Your agents';
    ctx.resetCanvas();
    ctx.renderHudWithDevice();

    const p1 = ctx.createFakeTerminalPane(140, 130);
    const p2 = ctx.createFakeTerminalPane(800, 130);
    const p3 = ctx.createFakeTerminalPane(140, 600);
    const p4 = ctx.createFakeTerminalPane(800, 600);
    [p1, p2, p3, p4].forEach(p => ctx.setClaudeState(p, 'idle'));

    let r = await ctx.say(C, 'Panes tell you how Claude is doing',
      'You do not read four terminals to find the one that needs you. The pane itself changes colour.', 3800);
    if (r === 'back') return 'back';

    ctx.setClaudeState(p1, 'working');
    ctx.setClaudeState(p3, 'working');
    r = await ctx.say(C, 'Blue means working',
      'A soft blue backlight, breathing gently. Claude is busy and wants nothing from you.', 3600);
    if (r === 'back') return 'back';

    ctx.setClaudeState(p2, 'permission');
    const toast = ctx.showTutToast('permission', 'Claude needs permission', 'my-server · Bash(rm -rf build/)');
    ctx.showPrompt(C, 'Red means blocked',
      'This agent is stopped waiting for a yes or no. It glows red from across the room and a notification appears. <span class="hl">Click the notification</span> to jump straight to that pane.', 2, 5);
    r = await ctx.beat({ wait: () => toast.waitForClick() });
    if (r === 'back') { ctx.clearTutToasts(); return 'back'; }
    toast.dismiss();
    ctx.setClaudeState(p2, 'working');
    await ctx.sleep(400);

    ctx.setClaudeState(p4, 'question');
    const q = ctx.showTutToast('question', 'Claude asked a question', 'my-server · "Which database should I use?"');
    r = await ctx.say(C, 'Purple means it asked you something',
      'A question rather than a permission. Same idea — you can see it without looking for it. Notifications can be snoozed per terminal when an agent is being chatty.', 4600);
    q.dismiss();
    ctx.setClaudeState(p4, 'idle');
    if (r === 'back') return 'back';

    // Usage HUD.
    ctx.createUsageHud();
    ctx.spotlight('#agents-hud');
    r = await ctx.say(C, 'And how much Claude you have left',
      'Usage against your 5-hour and weekly windows, per model, with the reset countdown. <kbd>Tab</kbd>+<kbd>U</kbd> toggles it. Running ten agents burns a limit quickly.', 5000);
    ctx.clearSpotlight();
    if (r === 'back') return 'back';

    return 'next';
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Chapter 5 — power features, then the one real chore
  // ═══════════════════════════════════════════════════════════════════════
  async function chapter5(ctx) {
    const C = 'Many at once';
    ctx.resetCanvas();
    ctx.renderHudWithDevice();

    const a = ctx.createFakeTerminalPane(140, 150);
    const b = ctx.createFakeTerminalPane(800, 150);
    const c = ctx.createFakeTerminalPane(470, 620);

    ctx.showPrompt(C, 'Talk to several agents at once',
      '<kbd>Shift</kbd>+click two or three terminals to select them. Shift+drag on empty canvas does the same with a rubber band.', 0, 4);
    let r = await ctx.beat({ wait: () => ctx.waitForBroadcastSelect(2) });
    if (r === 'back') return 'back';

    if (r === 'action') {
      ctx.showPrompt(C, 'Now type once',
        'Whatever you type goes to every selected terminal. This is how you start the same task on five machines, or tell them all to stop.', 1, 4);
      const rr = await ctx.beat({ wait: () => ctx.waitForBroadcastType() });
      if (rr === 'back') return 'back';
      ctx.showPrompt(C, 'Escape clears it',
        'Press <kbd>Esc</kbd> to drop the selection. <kbd>Tab</kbd>+<kbd>W</kbd> closes every selected pane at once.', 2, 4);
      const r3 = await ctx.beat({ wait: () => ctx.waitForEscClear(), auto: 9000 });
      if (r3 === 'back') return 'back';
    } else {
      ctx.clearBroadcastSelect();
    }

    r = await ctx.say(C, 'Point an agent at something',
      '<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>@</kbd>, or the <span class="hl">@</span> button on a file, web or issue pane, pastes a reference to it into whichever terminal you choose. That is how a file on the canvas becomes context for Claude.', 5200);
    if (r === 'back') return 'back';

    r = await ctx.say(C, 'Tidy the clutter',
      'Drag one terminal onto another to stack them into a tab group — <kbd>Tab</kbd>+<kbd>`</kbd> cycles tabs, <kbd>Tab</kbd>+<kbd>=</kbd> adds one. <kbd>Tab</kbd>+<kbd>H</kbd> hides every overlay when you want the canvas bare.', 4800);
    if (r === 'back') return 'back';

    // The cheatsheet, offered rather than recited.
    ctx.showPrompt(C, 'That is the whole app',
      'There is a shortcut cheatsheet on the <span class="hl">Shortcuts</span> button below — it stays available from the <kbd>?</kbd> menu once you are back in the app.', 3, 4);
    r = await ctx.beat({ next: 'Last thing' });
    if (r === 'back') return 'back';

    // Now — and only now — the setup chore.
    ctx.spotlight('#hud-container');
    ctx.showPrompt('Set up', 'Connect your own machine',
      'Everything so far was a simulation. To make it real, run the agent install on any machine you work on and it appears in this panel. You can add as many as you like.', 3, 4);
    r = await ctx.beat({ next: 'Finish' });
    ctx.clearSpotlight();
    if (r === 'back') return 'back';

    return 'next';
  }
})();
