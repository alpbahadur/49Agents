import test from 'node:test';
import assert from 'node:assert/strict';
import {
  paneIcon, paneLabel, sortPanesForList, claudeStateOf, PANE_ICONS,
} from '../src-client/modules/pane-summary.js';

/**
 * The bottom-sheet drawer and list view both list the same panes, and both had
 * to name them. Keeping two copies of the labelling rules would let the two
 * views disagree about what a pane is called, so the rules live in one place
 * and are pinned here.
 */

test('a user-given name wins over anything derived', () => {
  assert.equal(paneLabel({ type: 'file', paneName: 'Scratch', fileName: 'a.js' }), 'Scratch');
  assert.equal(paneLabel({ type: 'terminal', paneName: 'Build' }), 'Build');
});

test('each pane type names itself from what it points at', () => {
  assert.equal(paneLabel({ type: 'file', fileName: 'app.js' }), 'app.js');
  assert.equal(paneLabel({ type: 'file', filePath: '/src/app.js' }), '/src/app.js');
  assert.equal(paneLabel({ type: 'git-graph', repoName: 'cloud' }), 'cloud');
  assert.equal(paneLabel({ type: 'iframe', url: 'https://example.com/a/b' }), 'example.com');
  assert.equal(paneLabel({ type: 'folder', folderPath: '/a/b/src' }), 'src');
  assert.equal(paneLabel({ type: 'note' }), 'Note');
  assert.equal(paneLabel({ type: 'beads' }), 'Beads');
  assert.equal(paneLabel({ type: 'conversations' }), 'Claude Sessions');
});

test('each type falls back to its own name when it points nowhere', () => {
  assert.equal(paneLabel({ type: 'file' }), 'File');
  assert.equal(paneLabel({ type: 'git-graph' }), 'Git Graph');
  assert.equal(paneLabel({ type: 'iframe' }), 'Browser');
  assert.equal(paneLabel({ type: 'folder' }), 'Folder');
  assert.equal(paneLabel({ type: 'terminal' }), 'Terminal');
  assert.equal(paneLabel({ type: 'unheard-of' }), 'Terminal');
});

test('a malformed url does not take the whole list down', () => {
  // A url typed by hand is not valid until it is, and new URL() throws.
  assert.equal(paneLabel({ type: 'iframe', url: 'not a url' }), 'Browser');
  assert.equal(paneLabel({ type: 'iframe', url: '' }), 'Browser');
});

test('a trailing slash does not produce an empty folder label', () => {
  assert.equal(paneLabel({ type: 'folder', folderPath: '/a/b/src/' }), 'src');
  assert.equal(paneLabel({ type: 'folder', folderPath: '/' }), 'Folder');
});

test('paneLabel tolerates no pane at all', () => {
  assert.equal(paneLabel(null), 'Pane');
  assert.equal(paneLabel(undefined), 'Pane');
});

test('every icon key is a known pane type and unknowns fall back', () => {
  assert.equal(paneIcon({ type: 'note' }), PANE_ICONS.note);
  assert.equal(paneIcon({ type: 'unheard-of' }), PANE_ICONS.terminal);
  assert.equal(paneIcon(null), PANE_ICONS.terminal);
});

test('numbered panes lead, in their number order', () => {
  const panes = [
    { id: 'c', shortcutNumber: 3, x: 0, y: 0 },
    { id: 'a', shortcutNumber: 1, x: 900, y: 900 },
    { id: 'b', shortcutNumber: 2, x: 50, y: 50 },
  ];
  assert.deepEqual(sortPanesForList(panes).map(p => p.id), ['a', 'b', 'c']);
});

test('unnumbered panes follow, in reading order across the canvas', () => {
  const panes = [
    { id: 'right', x: 500, y: 0 },
    { id: 'below', x: 0, y: 400 },
    { id: 'left', x: 0, y: 0 },
  ];
  assert.deepEqual(sortPanesForList(panes).map(p => p.id), ['left', 'right', 'below']);
});

test('a numbered pane outranks an unnumbered one wherever it sits', () => {
  const panes = [
    { id: 'unnumbered-top-left', x: 0, y: 0 },
    { id: 'numbered-far-away', shortcutNumber: 9, x: 5000, y: 5000 },
  ];
  assert.deepEqual(
    sortPanesForList(panes).map(p => p.id),
    ['numbered-far-away', 'unnumbered-top-left'],
  );
});

test('sorting does not mutate the caller array', () => {
  const panes = [{ id: 'b', x: 10, y: 0 }, { id: 'a', x: 0, y: 0 }];
  sortPanesForList(panes);
  assert.deepEqual(panes.map(p => p.id), ['b', 'a']);
});

test('sorting tolerates no panes', () => {
  assert.deepEqual(sortPanesForList([]), []);
  assert.deepEqual(sortPanesForList(null), []);
});

// claudeStateOf reads classes off a pane element; a bare object with a
// classList is all it needs.
const withClasses = (...classes) => ({ classList: { contains: (c) => classes.includes(c) } });

test('the state needing a human is reported ahead of the ones that do not', () => {
  // A pane can carry more than one of these at once; the ordering decides
  // which the list shows, and a request for permission must not be hidden
  // behind "working".
  assert.equal(claudeStateOf(withClasses('claude-working', 'claude-permission')).state, 'claude-permission');
  assert.equal(claudeStateOf(withClasses('claude-idle', 'claude-question')).state, 'claude-question');
});

test('each state reports a human-readable label', () => {
  assert.equal(claudeStateOf(withClasses('claude-working')).label, 'Working');
  assert.equal(claudeStateOf(withClasses('claude-idle')).label, 'Idle');
  assert.equal(claudeStateOf(withClasses('claude-input-needed')).label, 'Waiting for input');
});

test('a pane with no Claude state, or no element, reports nothing', () => {
  assert.equal(claudeStateOf(withClasses('pane', 'note-pane')), null);
  assert.equal(claudeStateOf(null), null);
});
