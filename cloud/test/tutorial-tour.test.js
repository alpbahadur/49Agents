import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const cloud = join(here, '..');

const tutorialHtml = readFileSync(join(cloud, 'public/tutorial.html'), 'utf8');
const indexHtml = readFileSync(join(cloud, 'public/index.html'), 'utf8');
const tourJs = readFileSync(join(cloud, 'src-client/tutorial-tour.js'), 'utf8');
const menusJs = readFileSync(join(cloud, 'src-client/modules/menus.js'), 'utf8');
const buildJs = readFileSync(join(cloud, 'build.js'), 'utf8');

/**
 * The tutorial rewrite.
 *
 * These are structural assertions against the shipped files rather than
 * behavioural tests of the tour itself — the tour is a DOM animation driven by
 * user gestures, and the parts worth pinning are the ones that silently rotted
 * last time: the simulated menu drifting behind the real one, dead guides
 * still being referenced, and steps that could strand a user with no way out.
 */

test('the simulated add-pane menu offers every real pane type', () => {
  const types = (html) => {
    const menu = html.slice(html.indexOf('<div id="add-pane-menu"'));
    const end = menu.indexOf('\n  </div>');
    return [...menu.slice(0, end).matchAll(/data-type="([^"]+)"/g)].map(m => m[1]).sort();
  };

  // The old tutorial listed six of the ten types, so beads, conversations,
  // project and checkpoint were invisible to anyone learning the app.
  assert.deepEqual(types(tutorialHtml), types(indexHtml));
});

test('every pane type in the menu has a placement label', () => {
  const menu = tutorialHtml.slice(tutorialHtml.indexOf('<div id="add-pane-menu"'));
  const declared = [...menu.slice(0, menu.indexOf('\n  </div>')).matchAll(/data-type="([^"]+)"/g)]
    .map(m => m[1])
    .filter(t => t !== 'project' && t !== 'checkpoint');   // drawn, not placed

  const labelBlock = tutorialHtml.slice(tutorialHtml.indexOf('const labels = {'));
  for (const type of declared) {
    assert.ok(
      labelBlock.includes(`'${type}':`),
      `placement ghost has no label for "${type}" — it would read as a raw slug`
    );
  }
});

test('no step can strand the user: every gated beat races the Next button', () => {
  // beat() resolves on the gesture OR on Next/Back, so a user who cannot
  // perform a gesture — touch device, no keyboard — always has a way forward.
  // A bare `await ctx.waitForX()` outside beat() would reintroduce the trap
  // that left mobile users stuck on Tab+A in the old panes tour.
  const gated = [...tourJs.matchAll(/await\s+ctx\.(waitFor\w+)\(/g)].map(m => m[1]);
  assert.deepEqual(
    gated, ['waitForClick'],
    'only the welcome splash may await a gesture directly; everything else goes through beat()'
  );
  assert.ok(tourJs.includes("waitForClick('#tut-start-btn')"));
});

test('interactive beats pass a thunk so their listeners can be revoked', () => {
  // beat() can end without the gesture happening. If wait: were a bare
  // promise, the helper's document listener would survive and keep eating
  // keystrokes — a stray WASD handler hijacks typing for the rest of the tour.
  // Only real call sites. Strip comments first so the header block, which
  // mentions wait: in prose, does not count as a call.
  const code = tourJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const waits = [...code.matchAll(/\bwait:\s*([^,\n}]+)/g)].map(m => m[1].trim());
  assert.ok(waits.length > 0, 'expected the tour to gate on at least one gesture');
  for (const w of waits) {
    assert.ok(w.startsWith('() =>'), `wait: must be a thunk, got: ${w}`);
  }
});

test('skipping is recorded distinctly from finishing, on both paths', () => {
  // Previously Skip wrote the same 'completed' flag as finishing, so a tour
  // nobody watched was indistinguishable from one they did.
  assert.ok(tutorialHtml.includes("localStorage.setItem('tc_tutorial', 'skipped')"));
  // Completion is recorded by the step runner, which owns the end of the tour.
  assert.ok(tutorialHtml.includes("markTutorial('completed')"));

  // Skip must also reach the server, or the redirect follows the user onto
  // every other device they log in from.
  const splashSkip = tutorialHtml.slice(tutorialHtml.indexOf("document.getElementById('tut-skip-btn')"));
  assert.ok(
    splashSkip.slice(0, 1200).includes('/api/preferences'),
    'the welcome-splash skip must persist to the server too'
  );
});

test('the spotlight does not reposition absolutely-positioned targets', () => {
  // Forcing position:relative on the fixed-position add-pane menu laid it out
  // from the wrong origin and pushed it off the bottom of the viewport.
  const rule = tutorialHtml.slice(
    tutorialHtml.indexOf('.tut-spotlight-target {'),
    tutorialHtml.indexOf('.tut-spotlight-target.tut-spotlight-static')
  );
  assert.ok(!/position:\s*relative\s*!important/.test(rule));
  assert.ok(tutorialHtml.includes("getComputedStyle(el).position === 'static'"));
});

test('dead tutorial guides are gone and unreferenced', () => {
  // tutorial.js shipped ~600 lines to every user with no caller at all.
  for (const dead of ['tutorial.min.js', 'tutorial-getting-started.min.js', 'tutorial-panes.min.js']) {
    assert.ok(!indexHtml.includes(dead), `${dead} still referenced by index.html`);
    assert.ok(!tutorialHtml.includes(dead), `${dead} still referenced by tutorial.html`);
  }
  assert.ok(tutorialHtml.includes('tutorial-tour.min.js'));
  assert.ok(buildJs.includes("'tutorial-tour.js'"));
  assert.ok(!buildJs.includes("'tutorial-getting-started.js'"));
  assert.ok(!buildJs.includes("'tutorial-panes.js'"));
});

test('the tutorial menu advertises only chapters that exist', () => {
  // Three of the five old entries were permanently disabled "Coming soon"
  // stubs, which reads as a broken product.
  assert.ok(!indexHtml.includes('Coming soon'));
  assert.ok(!/tutorial-menu-item[^>]*\bdisabled\b/.test(indexHtml));

  const chapters = [...indexHtml.matchAll(/data-tutorial="chapter" data-chapter="(\d+)"/g)].map(m => Number(m[1]));
  const defined = (tourJs.match(/\{ num: 'Chapter/g) || []).length;
  assert.deepEqual(chapters, [...Array(defined).keys()], 'menu chapters must match the tour');
  assert.ok(menusJs.includes('/tutorial?chapter='));
  assert.ok(menusJs.includes('/tutorial?sheet=1'));
});

test('old tutorial links still resolve', () => {
  // ?guide=panes was the second tour. Bookmarks and older builds still use it.
  assert.ok(tutorialHtml.includes("LEGACY_CHAPTER = { 'panes':"));
});

test('every beat states whether it advances on its own or waits', () => {
  // The only cue used to be a spinner on Next, and a narration beat was told
  // apart from a waiting beat by its hint being empty — an absence is not a
  // signal. Each of the three states now names itself.
  const hint = tutorialHtml.slice(
    tutorialHtml.indexOf('function defaultHint(opts)'),
    tutorialHtml.indexOf('function beat(opts)')
  );
  assert.match(hint, /opts\.wait && opts\.auto/);   // wants the gesture, but not forever
  assert.match(hint, /Waiting for you/);
  assert.match(hint, /Moves on by itself/);
  assert.match(hint, /Press Next when you are ready/);

  // No beat may blank the hint and fall back to being unlabelled.
  const code = tourJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/hint:\s*''/.test(code), 'a blank hint leaves the beat unlabelled');
  assert.ok(!/hint:\s*''/.test(tutorialHtml.slice(tutorialHtml.indexOf('function say(chapter'))));
});

test('the arrow keys that drive the tour are advertised', () => {
  // They were wired up from the start but nothing on screen mentioned them.
  // The wording matters: the arrows move one *step*, not one chapter.
  assert.ok(tutorialHtml.includes('step back / forward'));
  assert.match(tutorialHtml, /const ARROW_KEYS/);

  // Every default hint carries the reminder...
  const hint = tutorialHtml.slice(
    tutorialHtml.indexOf('function defaultHint(opts)'),
    tutorialHtml.indexOf('function beat(opts)')
  );
  assert.equal((hint.match(/ARROW_KEYS/g) || []).length, 4, 'each hint branch appends it');

  // A step may word its own hint, but the runner is what appends the arrow
  // reminder — otherwise a custom hint silently loses it.
  assert.match(tutorialHtml, /hint: step\.hint === undefined \? undefined[\s\S]*?ARROW_KEYS/);
  const customHints = [...tourJs.matchAll(/\bhint:\s*'([^']*)'/g)].map(m => m[1]);
  for (const h of customHints) {
    assert.ok(!h.includes('tut-waiting'), `step hints are plain text now: ${h}`);
  }

  // And the splash sets the expectation before the tour even starts.
  assert.match(tutorialHtml, /Some steps play by themselves, some wait for you/);
});

test('the countdown ring is a real countdown', () => {
  // A spinner says "something is happening"; this has to say "how long left".
  assert.ok(tutorialHtml.includes('animation-name: tut-drain'));
  assert.match(tutorialHtml, /@keyframes tut-drain[\s\S]*?stroke-dashoffset: 0[\s\S]*?stroke-dashoffset: 36\.13/);
  assert.ok(tutorialHtml.includes('animation-duration:${opts.auto}ms'), 'duration must track the beat');

  // Geometry belongs on the SVG attributes: cx/cy/r as CSS properties are not
  // supported widely enough, and the ring silently failed to render with them.
  assert.ok(tutorialHtml.includes('cx="7" cy="7" r="5.75"'));
  assert.ok(!/\.tut-autoring circle \{[^}]*\br:\s/.test(tutorialHtml));

  // The waiting state gets a steady dot — the visual opposite of a countdown.
  assert.ok(tutorialHtml.includes('tut-holddot'));
});

test('the tour never animates box-shadow on a pane', () => {
  // styles.css pulses the Claude backlights by animating box-shadow with
  // 40-80px blur radii. Each frame is a full repaint of the pane and its glow
  // footprint, and the tour shows three or four at once — which is where the
  // stutter came from. Inside the tour the pulse is an opacity-only
  // pseudo-element, so it composites instead of repainting.
  assert.ok(tutorialHtml.includes('#canvas .pane[class*="claude-"] { animation: none !important; }'));
  const kf = tutorialHtml.slice(tutorialHtml.indexOf('@keyframes tut-backlight'));
  assert.ok(!/box-shadow/.test(kf.slice(0, 160)), 'the pulse must animate opacity, not box-shadow');
  assert.match(kf, /opacity: 0[\s\S]*?opacity: 1/);
});

test('no full-screen backdrop-filter sits over animating content', () => {
  // A blur that covers the viewport is re-rasterised every frame of whatever
  // moves behind it. The prompt, chapter card, cheatsheet and toast are all
  // opaque, so the blur bought nothing and cost a filter pass.
  for (const id of ['#tut-prompt', '.tut-chapter-card', '#tut-cheatsheet', '.tut-toast']) {
    const start = tutorialHtml.indexOf(id + ' {');
    assert.ok(start > -1, `${id} rule not found`);
    const rule = tutorialHtml.slice(start, tutorialHtml.indexOf('}', start));
    assert.ok(!/backdrop-filter/.test(rule), `${id} still blurs its backdrop`);
  }
});

test('an arrow press is never silently dropped', () => {
  // Between beats — a chapter returning, the canvas resetting, a title card
  // mounting — nothing is listening. Presses landing there used to vanish,
  // which is what made the arrows feel unreliable.
  assert.match(tutorialHtml, /if \(how === 'next' \|\| how === 'back'\) nav\.pending = how;/);
  assert.ok(tutorialHtml.includes('pending: null'));

  // Both waiters replay a buffered press instead of starting a fresh wait.
  const beatFn = tutorialHtml.slice(tutorialHtml.indexOf('function beat(opts)'));
  assert.match(beatFn.slice(0, 2600), /if \(nav\.pending\)/);
  const pauseFn = tutorialHtml.slice(tutorialHtml.indexOf('function pause(ms)'));
  assert.match(pauseFn.slice(0, 700), /if \(nav\.pending\)/);

  // And a press that brought us into a chapter is not replayed into its card.
  assert.ok(tutorialHtml.includes('nav.pending = null'));
});

test('waiting between beats stays interruptible', () => {
  // A plain sleep() swallows every key pressed during it. Mid-chapter pauses
  // go through pause(), which resolves early on Next/Back.
  assert.ok(tutorialHtml.includes('function pause(ms)'));
  // The title card is skippable too, and reports how it ended.
  assert.match(tutorialHtml, /const how = await pause\(1500\)/);
  assert.ok(tutorialHtml.includes("chapterCard(m.num, m.name, m.desc) === 'back'"));
});

test('held arrow keys cannot run away with the tour', () => {
  // Key repeat fires ~30/s; without a throttle one long press tears through
  // several chapters and the user has no idea where they landed.
  assert.match(tutorialHtml, /if \(e\.repeat\) return;/);
  assert.match(tutorialHtml, /now - lastNavKey < \d+/);
  // A keyboard press has no pointer feedback of its own, so it is echoed.
  assert.ok(tutorialHtml.includes('function flashNav'));
  assert.ok(tutorialHtml.includes('@keyframes tut-press'));
});

test('the prompt card is not flush against the bottom edge', () => {
  const rule = tutorialHtml.slice(
    tutorialHtml.indexOf('#tut-prompt {'),
    tutorialHtml.indexOf('}', tutorialHtml.indexOf('#tut-prompt {'))
  );
  const m = rule.match(/bottom:\s*calc\((\d+)px/);
  assert.ok(m, 'bottom should be a calc() including the safe-area inset');
  assert.ok(Number(m[1]) >= 40, `desktop gap too small: ${m[1]}px`);
  assert.ok(rule.includes('env(safe-area-inset-bottom'), 'must clear the phone home indicator');

  // The mobile override must not undo it.
  const mob = tutorialHtml.slice(tutorialHtml.indexOf('@media (max-width: 640px)'));
  const mm = mob.match(/#tut-prompt \{[\s\S]*?bottom:\s*calc\((\d+)px/);
  assert.ok(mm && Number(mm[1]) >= 20, 'mobile prompt sits too close to the edge');
});

test('the arrows move one step, not one chapter', () => {
  // Back used to jump to the start of the previous chapter while Next
  // advanced a single substep — asymmetric, and the main thing that made
  // progression confusing. Both now move exactly one step.
  assert.ok(!tutorialHtml.includes('backTo'), 'the chapter-jump path should be gone');
  assert.match(tutorialHtml, /else if \(!navBtnBack\.disabled\) \{ flashNav\(navBtnBack\); settleBeat\('back'\); \}/);

  // Back is live everywhere except the very first step of the first chapter.
  assert.match(tutorialHtml, /navBtnBack\.disabled = nav\.chapterIdx <= 0 && \(nav\.stepIdx \|\| 0\) <= 0;/);

  // Stepping back past a chapter boundary lands on the previous chapter's
  // LAST step, not its first.
  const runner = tutorialHtml.slice(tutorialHtml.indexOf('async function runChapters'));
  assert.match(runner, /si = chapters\[ci\]\.steps\.length - 1;/);
});

test('a skipped step is stepped over in the direction of travel', () => {
  // skipIf() only ever advanced forward, so pressing Back onto a skipped step
  // bounced off it and returned you to where you started. "Or jump straight
  // there" was unleaveable, because the WASD step behind it is skipped
  // whenever move mode was never entered.
  const runner = tutorialHtml.slice(tutorialHtml.indexOf('async function runChapters'));
  const skipBlock = runner.slice(runner.indexOf('if (step.skipIf && step.skipIf())'));

  assert.match(skipBlock.slice(0, 500), /if \(dir < 0\)/, 'skipping must respect direction');
  assert.match(skipBlock.slice(0, 500), /si--/, 'backwards travel skips backwards');

  // Direction is tracked, reset on landing, and flipped when going back.
  assert.match(runner, /let dir = 1;/);
  assert.match(runner, /dir = 1;\s*\/\/ landed on a real step/);
  assert.match(runner, /dir = -1;\s*\/\/ now travelling backwards/);

  // A run of skipped steps at the very start of a chapter must fall through
  // to the previous chapter rather than bounce.
  assert.match(skipBlock.slice(0, 500), /if \(ci > 0\) \{ ci--; si = chapters\[ci\]\.steps\.length - 1;/);
});

test('chapters are declarative so any step can be replayed', () => {
  // An imperative await-chain cannot be rewound; that is why back-navigation
  // had to throw the user to a chapter boundary. Steps are data now, and
  // going back re-runs setup() then fast-forwards each apply().
  assert.ok(tourJs.includes('ctx.runChapters(chapters, CHAPTERS)'));
  const chapterFns = tourJs.match(/function chapter\d\(ctx\) \{/g) || [];
  assert.equal(chapterFns.length, 5);
  // Each returns { setup, steps }.
  assert.equal((tourJs.match(/^      setup\(\) \{/gm) || []).length, 5);
  assert.equal((tourJs.match(/^      steps: \[/gm) || []).length, 5);

  // The replay path exists and re-applies prior steps.
  const runner = tutorialHtml.slice(tutorialHtml.indexOf('async function runChapters'));
  assert.match(runner, /chapter\.setup\(\)/);
  assert.match(runner, /for \(let i = 0; i < si; i\+\+\)/);
});

test('every Tab chord the app implements is taught somewhere', () => {
  // The old tour taught three of eleven. This keeps the tour honest against
  // modules/shortcuts.js rather than letting it drift again.
  const shortcuts = readFileSync(join(cloud, 'src-client/modules/shortcuts.js'), 'utf8');
  const implemented = new Set(
    [...shortcuts.matchAll(/e\.key === '([^']+)' && tabHeld/g)].map(m => m[1])
  );
  const taught = new Set(
    [...tourJs.matchAll(/<kbd>Tab<\/kbd>\+<kbd>([^<]+)<\/kbd>/g)].map(m => m[1].toLowerCase())
  );
  const missing = [...implemented].filter(k => !taught.has(k));
  assert.deepEqual(missing, [], `chords implemented but never taught: ${missing.join(', ')}`);

  // And the non-chord keys that matter.
  for (const k of ['Ctrl', 'Shift', 'Esc', 'Enter', 'WASD']) {
    assert.ok(tourJs.includes(k), `${k} is never mentioned`);
  }
});

test('progress advances on every prompt', () => {
  // The old tour reused one stepIdx across consecutive prompts, so the bar
  // froze for several screens and "12 steps" never matched the 19 shown.
  // The runner shows "step i of chapter.steps.length", so the bar can never
  // disagree with the number of screens actually shown.
  assert.match(tutorialHtml, /showPrompt\(chap, title, body, si, chapter\.steps\.length\)/);
  assert.match(tutorialHtml, /nav\.stepIdx = si;/);
});
