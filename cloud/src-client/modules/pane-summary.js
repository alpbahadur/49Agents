// ─── Pane Summaries ───────────────────────────────────────────────────────
// How a pane describes itself when it is being listed rather than rendered:
// its icon, its human label, and the order a set of panes should appear in.
//
// Pure functions over pane data, shared by the bottom-sheet drawer and list
// view so the two cannot drift into naming the same pane differently. No DOM,
// so the ordering and labelling rules are directly testable.

export const PANE_ICONS = {
  terminal: '>_',
  file: '\u{1F4C4}',
  note: '\u{1F4DD}',
  'git-graph': '\u{1F333}',
  iframe: '\u{1F310}',
  beads: '\u{1F4CE}',
  folder: '\u{1F4C1}',
  conversations: '\u{1F4AC}',
};

export function paneIcon(pane) {
  return PANE_ICONS[pane?.type] || PANE_ICONS.terminal;
}

// A user-given name always wins; otherwise each type names itself from
// whatever it is pointed at, falling back to the type itself.
export function paneLabel(pane) {
  if (!pane) return 'Pane';
  if (pane.paneName) return pane.paneName;

  switch (pane.type) {
    case 'file':
      return pane.fileName || pane.filePath || 'File';
    case 'note':
      return 'Note';
    case 'git-graph':
      return pane.repoName || 'Git Graph';
    case 'iframe':
      return hostnameOf(pane.url) || 'Browser';
    case 'beads':
      return 'Beads';
    case 'folder':
      return lastSegment(pane.folderPath) || 'Folder';
    case 'conversations':
      return 'Claude Sessions';
    default:
      return 'Terminal';
  }
}

// A pane whose url was never set, or was typed by hand and is not yet valid,
// must not take the whole list down with it.
function hostnameOf(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function lastSegment(path) {
  if (!path) return null;
  const parts = String(path).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

// Numbered panes first, in their number order, then everything else in reading
// order across the canvas. Listing in canvas order alone would scatter the
// panes the user has deliberately numbered.
export function sortPanesForList(panes) {
  return [...(panes || [])].sort((a, b) => {
    const aNum = a.shortcutNumber || 99;
    const bNum = b.shortcutNumber || 99;
    if (aNum !== bNum) return aNum - bNum;
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  });
}

// Which Claude state, if any, a pane's element is advertising. List view leans
// on this: the reason to look at a phone is to see which agent wants
// something, and the canvas says that through classes on the pane element.
const CLAUDE_STATE_CLASSES = [
  ['claude-permission', 'Needs permission'],
  ['claude-question', 'Asking a question'],
  ['claude-input-needed', 'Waiting for input'],
  ['claude-working', 'Working'],
  ['claude-idle', 'Idle'],
];

export function claudeStateOf(paneEl) {
  if (!paneEl) return null;
  for (const [cls, label] of CLAUDE_STATE_CLASSES) {
    if (paneEl.classList.contains(cls)) return { state: cls, label };
  }
  return null;
}
