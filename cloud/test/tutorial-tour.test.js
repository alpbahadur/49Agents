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
  assert.ok(tourJs.includes("markTutorial('completed')"));

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

test('progress advances on every prompt', () => {
  // The old tour reused one stepIdx across consecutive prompts, so the bar
  // froze for several screens and "12 steps" never matched the 19 shown.
  const say = tutorialHtml.slice(tutorialHtml.indexOf('function say(chapter'));
  assert.ok(say.slice(0, 400).includes('nav.stepIdx = (nav.stepIdx || 0) + 1'));
  assert.ok(tourJs.includes('ctx.nav.stepIdx = 0'), 'progress must reset per chapter');
});
