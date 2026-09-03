import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { config } from '../src/config.js';
import { createJsonStore } from './jsonStore.js';

const execFileAsync = promisify(execFile);

// Extend PATH so `bd` is found even when launched from systemd (minimal PATH)
const home = homedir();
const extendedEnv = {
  ...process.env,
  PATH: (process.env.PATH || '') + `:${home}/.local/bin:${home}/.cargo/bin`,
};

const DATA_DIR = config.dataDir;
const BEADS_PANES_FILE = join(DATA_DIR, 'beads-panes.json');

// Allowed status filter values
const VALID_STATUSES = ['open', 'in_progress', 'closed'];

const beadsPanesStore = createJsonStore({
  file: BEADS_PANES_FILE,
  key: 'beadsPanes',
  loadError: '[Beads] Error loading beads panes:',
  saveError: '[Beads] Error saving beads panes:',
});

let beadsPanesCache = beadsPanesStore.load();

/**
 * Find the beads project root by looking for .beads/ directory
 * starting from cwd and walking up.
 */
function findBeadsRoot(startDir) {
  let dir = resolve(startDir || process.cwd());
  while (dir !== '/') {
    if (existsSync(join(dir, '.beads'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Fetch beads issues by running `bd list --json` (async)
 */
async function fetchIssues(projectPath, statusFilter) {
  try {
    const root = projectPath || findBeadsRoot(process.cwd());
    if (!root) {
      return { error: 'No beads project found', issues: [] };
    }

    const args = ['list', '--json', '--limit', '0'];
    if (statusFilter && VALID_STATUSES.includes(statusFilter)) {
      args.push('--status=' + statusFilter);
    }

    const { stdout } = await execFileAsync('bd', args, {
      cwd: root,
      encoding: 'utf-8',
      timeout: 15000,
      env: extendedEnv,
    });

    const issues = JSON.parse(stdout);

    // Compute summary counts
    let openCount = 0;
    let inProgressCount = 0;
    for (const issue of issues) {
      if (issue.status === 'open') openCount++;
      else if (issue.status === 'in_progress') inProgressCount++;
    }

    return {
      issues,
      counts: { open: openCount, inProgress: inProgressCount, total: issues.length },
      projectPath: root,
      timestamp: Date.now(),
    };
  } catch (error) {
    return {
      error: error.message,
      issues: [],
      counts: { open: 0, inProgress: 0, total: 0 },
      timestamp: Date.now(),
    };
  }
}

/**
 * Fetch a single beads issue by ID (async)
 */
async function fetchIssue(projectPath, issueId) {
  try {
    const root = projectPath || findBeadsRoot(process.cwd());
    if (!root) {
      return { error: 'No beads project found' };
    }

    // Validate issueId format to prevent injection
    if (!/^[a-zA-Z0-9_-]+$/.test(issueId)) {
      return { error: 'Invalid issue ID format' };
    }

    const { stdout } = await execFileAsync('bd', ['show', issueId, '--json'], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 10000,
      env: extendedEnv,
    });

    const issues = JSON.parse(stdout);
    return issues[0] || { error: 'Issue not found' };
  } catch (error) {
    return { error: error.message };
  }
}

async function closeIssue(projectPath, issueId) {
  try {
    const root = projectPath || findBeadsRoot(process.cwd());
    if (!root) {
      return { error: 'No beads project found' };
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(issueId)) {
      return { error: 'Invalid issue ID format' };
    }
    await execFileAsync('bd', ['close', issueId], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 10000,
      env: extendedEnv,
    });
    return { success: true, issueId };
  } catch (error) {
    return { error: error.message };
  }
}

async function createIssue(projectPath, { title, type, priority }) {
  try {
    const root = projectPath || findBeadsRoot(process.cwd());
    if (!root) {
      return { error: 'No beads project found' };
    }
    if (!title || !title.trim()) {
      return { error: 'Title is required' };
    }
    const args = ['create', `--title=${title.trim()}`];
    if (type && ['task', 'bug', 'feature'].includes(type)) {
      args.push(`--type=${type}`);
    }
    if (priority != null && [0, 1, 2, 3, 4].includes(Number(priority))) {
      args.push(`--priority=${priority}`);
    }
    const { stdout } = await execFileAsync('bd', args, {
      cwd: root,
      encoding: 'utf-8',
      timeout: 10000,
      env: extendedEnv,
    });
    return { success: true, output: stdout.trim() };
  } catch (error) {
    return { error: error.message };
  }
}

export const beadsService = {
  listBeadsPanes() {
    return beadsPanesCache;
  },

  getBeadsPane(id) {
    return beadsPanesCache.find(p => p.id === id);
  },

  createBeadsPane({ projectPath, position, size, device }) {
    const id = randomUUID();
    const beadsPane = {
      id,
      projectPath: projectPath || findBeadsRoot(process.cwd()),
      position: position || { x: 100, y: 100 },
      size: size || { width: 520, height: 500 },
      device: device || null,
      createdAt: new Date().toISOString(),
    };

    beadsPanesCache.push(beadsPane);
    beadsPanesStore.save(beadsPanesCache);
    return beadsPane;
  },

  updateBeadsPane(id, updates) {
    const index = beadsPanesCache.findIndex(p => p.id === id);
    if (index === -1) {
      throw new Error(`Beads pane not found: ${id}`);
    }

    const pane = beadsPanesCache[index];
    // Position/size now handled by cloud-only storage
    if (updates.projectPath) pane.projectPath = updates.projectPath;

    beadsPanesCache[index] = pane;
    beadsPanesStore.save(beadsPanesCache);
    return pane;
  },

  deleteBeadsPane(id) {
    const index = beadsPanesCache.findIndex(p => p.id === id);
    if (index !== -1) {
      beadsPanesCache.splice(index, 1);
      beadsPanesStore.save(beadsPanesCache);
    }
  },

  fetchIssues,
  fetchIssue,
  closeIssue,
  createIssue,
  findBeadsRoot,
};
