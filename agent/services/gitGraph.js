import { randomUUID } from 'crypto';
import { existsSync, readdirSync, statSync, realpathSync } from 'fs';
import { join, relative, resolve } from 'path';
import { homedir } from 'os';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { config } from '../src/config.js';
import { createJsonStore } from './jsonStore.js';
import { validateWorkingDirectory } from './sanitize.js';

const execAsync = promisify(exec);

const DATA_DIR = config.dataDir;
const GIT_GRAPHS_FILE = join(DATA_DIR, 'git-graphs.json');

const gitGraphsStore = createJsonStore({
  file: GIT_GRAPHS_FILE,
  key: 'gitGraphs',
  loadError: '[GitGraph] Error loading git graphs:',
  saveError: '[GitGraph] Error saving git graphs:',
});

let gitGraphsCache = gitGraphsStore.load();

/**
 * Fetch structured git graph data for a local repository (async).
 * Returns commit objects with parent hashes so the client can render an SVG graph.
 */
async function fetchGraphData(repoPath, maxCommits = 50, { ascii = false } = {}) {
  validateWorkingDirectory(resolve(repoPath));
  const opts = { cwd: repoPath, encoding: 'utf-8', timeout: 15000 };
  // Use a delimiter unlikely to appear in commit messages
  const SEP = '‡‡';
  const fmt = ['%h', '%p', '%an', '%s', '%D', '%at'].join(SEP);
  try {
    await execAsync('git rev-parse --is-inside-work-tree', opts);

    const queries = [
      execAsync('git branch --show-current', opts),
      execAsync('git diff --cached --name-only', opts),
      execAsync('git diff --name-only', opts),
      execAsync('git ls-files --others --exclude-standard', opts),
      execAsync(`git log --all --topo-order --format="${fmt}" -n ${maxCommits}`, opts).catch(() => ({ stdout: '' })),
    ];
    // ASCII mode: also fetch git's own graph output
    if (ascii) {
      queries.push(
        execAsync(`git log --all --graph --oneline --decorate --color=never -n ${maxCommits}`, opts).catch(() => ({ stdout: '' }))
      );
    }
    const [branchResult, stagedResult, unstagedResult, untrackedResult, logResult, asciiResult] = await Promise.all(queries);

    const branch = branchResult.stdout.trim();
    const staged = stagedResult.stdout.trim().split('\n').filter(Boolean).length;
    const unstaged = unstagedResult.stdout.trim().split('\n').filter(Boolean).length;
    const untracked = untrackedResult.stdout.trim().split('\n').filter(Boolean).length;
    const total = staged + unstaged + untracked;

    const commits = [];
    for (const line of logResult.stdout.trim().split('\n')) {
      if (!line) continue;
      const parts = line.split(SEP);
      if (parts.length < 6) continue;
      const [hash, parentStr, author, subject, refs, ts] = parts;
      commits.push({
        hash,
        parents: parentStr ? parentStr.split(' ').filter(Boolean) : [],
        author,
        subject,
        refs: refs || '',
        timestamp: parseInt(ts)
      });
    }

    const result = {
      branch,
      uncommitted: { total, staged, unstaged, untracked },
      clean: total === 0,
      commits,
      repoPath,
      timestamp: Date.now()
    };
    if (ascii && asciiResult) {
      result.asciiGraph = asciiResult.stdout;
    }
    return result;
  } catch (error) {
    return {
      error: error.message,
      repoPath,
      timestamp: Date.now()
    };
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '.worktrees', 'vendor', 'dist', 'build', '__pycache__', '.cache', '.npm', '.yarn', '.claude']);
const DEFAULT_MAX_DEPTH = 4;

/**
 * Recursively scan a directory for git repositories up to maxDepth (async).
 * Once a .git repo is found, we don't recurse into it (no repo-inside-repo).
 * @param {string} scanRoot - the root folder the scan started from (for relative name display)
 * @param {Function} [onFound] - optional callback(repo) called each time a repo is found
 */
async function scanDirForRepos(dir, repos, seen, currentDepth, maxDepth, scanRoot, onFound) {
  if (currentDepth > maxDepth) return;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch { return; }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (!stat.isDirectory()) continue;
      // Resolve symlinks so the same physical dir is never scanned twice
      let realPath;
      try { realPath = realpathSync(fullPath); } catch { realPath = fullPath; }
      if (seen.has(realPath)) continue;
      seen.add(realPath);

      const gitDir = join(fullPath, '.git');
      if (existsSync(gitDir)) {
        // Skip git worktrees — .git is a file (not directory) containing "gitdir: ..."
        const gitStat = statSync(gitDir);
        if (!gitStat.isDirectory()) continue;

        let branch = 'unknown';
        try {
          const result = await execAsync('git branch --show-current', { cwd: fullPath, encoding: 'utf-8', timeout: 5000 });
          branch = result.stdout.trim();
        } catch { /* ignore */ }
        const name = relative(scanRoot, fullPath) || entry;
        const repo = { path: fullPath, name, branch };
        repos.push(repo);
        if (onFound) onFound(repo);
        // Don't recurse into git repos — nested repos are unusual
      } else {
        // Not a git repo, keep searching deeper
        await scanDirForRepos(fullPath, repos, seen, currentDepth + 1, maxDepth, scanRoot, onFound);
      }
    } catch { /* skip entries we can't stat */ }
  }
}

/**
 * Scan for git repositories in common locations (local only, async)
 * @param {Function} [onFound] - optional callback(repo) for streaming results
 */
async function scanForRepos(onFound) {
  const home = homedir();
  const searchDirs = [
    home,
    join(home, 'Documents'),
    join(home, 'projects'),
    join(home, 'Music'),
    join(home, 'Music', '49Agents'),
  ];

  const repos = [];
  const seen = new Set();

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    await scanDirForRepos(dir, repos, seen, 1, DEFAULT_MAX_DEPTH, home, onFound);
  }

  return repos;
}

/**
 * Scan for git repositories in a specific folder (local only, async)
 * @param {Function} [onFound] - optional callback(repo) for streaming results
 */
async function scanReposInFolder(folderPath, onFound) {
  const repos = [];
  try {
    if (!existsSync(folderPath)) return repos;
    const seen = new Set();

    // Check if the folder itself is a git repo (skip worktrees where .git is a file)
    const selfGitDir = join(folderPath, '.git');
    if (existsSync(selfGitDir) && statSync(selfGitDir).isDirectory()) {
      let branch = 'unknown';
      try {
        const result = await execAsync('git branch --show-current', { cwd: folderPath, encoding: 'utf-8', timeout: 5000 });
        branch = result.stdout.trim();
      } catch { /* ignore */ }
      const name = folderPath.split('/').pop() || folderPath;
      const repo = { path: folderPath, name, branch };
      repos.push(repo);
      let realSelf;
      try { realSelf = realpathSync(folderPath); } catch { realSelf = folderPath; }
      seen.add(realSelf);
      if (onFound) onFound(repo);
    }

    // Recursively scan children up to DEFAULT_MAX_DEPTH levels
    await scanDirForRepos(folderPath, repos, seen, 1, DEFAULT_MAX_DEPTH, folderPath, onFound);
  } catch { /* skip */ }
  return repos;
}

export const gitGraphService = {
  listGitGraphs() {
    return gitGraphsCache;
  },

  getGitGraph(id) {
    return gitGraphsCache.find(g => g.id === id);
  },

  createGitGraph({ repoPath, position, size, device }) {
    validateWorkingDirectory(resolve(repoPath));
    const id = randomUUID();
    const name = repoPath.split('/').pop();
    const gitGraph = {
      id,
      repoPath,
      repoName: name,
      position: position || { x: 100, y: 100 },
      size: size || { width: 500, height: 450 },
      device: device || null,
      createdAt: new Date().toISOString()
    };

    gitGraphsCache.push(gitGraph);
    gitGraphsStore.save(gitGraphsCache);
    return gitGraph;
  },

  updateGitGraph(id, updates) {
    const index = gitGraphsCache.findIndex(g => g.id === id);
    if (index === -1) {
      throw new Error(`Git graph pane not found: ${id}`);
    }

    const gitGraph = gitGraphsCache[index];
    // Position/size now handled by cloud-only storage
    if (updates.repoPath) {
      validateWorkingDirectory(resolve(updates.repoPath));
      gitGraph.repoPath = updates.repoPath;
      gitGraph.repoName = updates.repoPath.split('/').pop();
    }

    gitGraphsCache[index] = gitGraph;
    gitGraphsStore.save(gitGraphsCache);
    return gitGraph;
  },

  deleteGitGraph(id) {
    const index = gitGraphsCache.findIndex(g => g.id === id);
    if (index !== -1) {
      gitGraphsCache.splice(index, 1);
      gitGraphsStore.save(gitGraphsCache);
    }
  },

  fetchGraphData,
  scanForRepos,
  scanReposInFolder
};
