import { exec } from 'child_process';
import { promisify } from 'util';
import { readdirSync, statSync, readFileSync } from 'fs';
import { readdir, stat, open as fsOpen } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { escapeShellArg, validateWorkingDirectory, validatePositiveInt } from './sanitize.js';
import { loadTerminalState, saveTerminalState, removeTerminalFromStorage } from './storage.js';
import { config } from '../src/config.js';

// tmux command prefix for this instance. Non-default instances run their own
// tmux server (tmux -L <key>) so their terminals stay separate.
const TMUX = config.tmuxCommand;

const execAsync = promisify(exec);

// Claude session ID resolution: PID → sessionId via debug logs
const CLAUDE_DEBUG_DIR = join(homedir(), '.claude', 'debug');
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const SESSION_ID_CACHE = new Map(); // pid → { sessionId, resolvedAt }
const SESSION_NAME_CACHE = new Map(); // sessionId → { name, mtime }
const SESSION_ID_TTL = 15000; // 15 seconds

const MAX_OUTPUT_SIZE = 100 * 1024;

function truncateOutput(output) {
  if (output.length <= MAX_OUTPUT_SIZE) {
    return output;
  }
  const truncateAt = output.length - MAX_OUTPUT_SIZE;
  const nextNewline = output.indexOf('\n', truncateAt);
  const startIndex = nextNewline !== -1 ? nextNewline + 1 : truncateAt;
  return output.slice(startIndex);
}

// Get local hostname
let localHostname = 'localhost';
try {
  const { execSync } = await import('child_process');
  localHostname = execSync('hostname', { encoding: 'utf-8' }).trim();
} catch {}

const terminals = new Map();

// Location cache: cwd -> { location, timestamp }
const locationCache = new Map();
const LOCATION_CACHE_TTL = 30000; // 30 seconds

// Evict stale cache entries every 5 minutes to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of SESSION_ID_CACHE) {
    if (now - entry.resolvedAt > SESSION_ID_TTL) SESSION_ID_CACHE.delete(key);
  }
  for (const [key, entry] of SESSION_NAME_CACHE) {
    if (now - (entry.readAt || 0) > SESSION_ID_TTL) SESSION_NAME_CACHE.delete(key);
  }
  for (const [key, entry] of locationCache) {
    if (now - entry.timestamp > LOCATION_CACHE_TTL) locationCache.delete(key);
  }
}, 300000).unref();

/**
 * Resolve Claude session ID for a given PID by scanning debug log files.
 * Debug files are named <session-id>.txt and contain references to the PID
 * in temp file paths like: .claude.json.tmp.<PID>.<timestamp>
 * Uses a 15-second cache to avoid repeated filesystem scans.
 *
 * ASYNC: All file I/O is non-blocking to avoid event-loop stalls that
 * freeze terminal input streaming.
 */
async function resolveClaudeSessionId(pid) {
  if (!pid) return null;
  const pidStr = String(pid);

  // Check cache
  const cached = SESSION_ID_CACHE.get(pidStr);
  if (cached && Date.now() - cached.resolvedAt < SESSION_ID_TTL) {
    return cached.sessionId;
  }

  try {
    // List debug files, get stats in parallel (all async)
    const dirEntries = await readdir(CLAUDE_DEBUG_DIR);
    const txtFiles = dirEntries.filter(f => f.endsWith('.txt'));

    const fileInfos = await Promise.all(
      txtFiles.map(async f => {
        const fullPath = join(CLAUDE_DEBUG_DIR, f);
        try {
          const s = await stat(fullPath);
          return { name: f, mtime: s.mtimeMs, path: fullPath, size: s.size };
        } catch { return null; }
      })
    );

    const sortedFiles = fileInfos.filter(Boolean).sort((a, b) => b.mtime - a.mtime);

    const TAIL_SIZE = 16384;
    const needle = `tmp.${pidStr}.`;
    for (const file of sortedFiles) {
      try {
        // Only read last 16KB of file (PID reference is near the end)
        const fd = await fsOpen(file.path, 'r');
        try {
          const readSize = Math.min(file.size, TAIL_SIZE);
          const position = Math.max(0, file.size - TAIL_SIZE);
          const buffer = Buffer.alloc(readSize);
          const { bytesRead } = await fd.read(buffer, 0, readSize, position);
          const tail = buffer.slice(0, bytesRead).toString('utf8');
          if (tail.includes(needle)) {
            const sessionId = basename(file.name, '.txt');
            SESSION_ID_CACHE.set(pidStr, { sessionId, resolvedAt: Date.now() });
            return sessionId;
          }
        } finally {
          await fd.close();
        }
      } catch { continue; }
    }
  } catch {
    // Debug dir doesn't exist or isn't readable
  }

  SESSION_ID_CACHE.set(pidStr, { sessionId: null, resolvedAt: Date.now() });
  return null;
}

/**
 * Resolve session name for a given session ID by reading the transcript JSONL.
 * Looks for customTitle first, then falls back to first user message (firstPrompt).
 * Caches by session ID + file mtime, with a minimum re-read interval to avoid
 * thrashing on actively-written transcripts.
 *
 * ASYNC: All file I/O is non-blocking. Only reads targeted head/tail portions
 * (64KB each) instead of entire transcripts (which can be 30MB+), to avoid
 * event-loop stalls that freeze terminal input streaming.
 */
const SESSION_NAME_MIN_REREAD = 15000; // Don't re-read more often than every 15s

async function resolveClaudeSessionName(sessionId, cwd) {
  if (!sessionId) return null;

  try {
    // Check cache — skip re-read if populated recently, even if mtime changed.
    // Session names rarely change, so 15s staleness is acceptable.
    const cached = SESSION_NAME_CACHE.get(sessionId);
    if (cached && Date.now() - cached.readAt < SESSION_NAME_MIN_REREAD) {
      return cached.name;
    }

    // Find the transcript JSONL: ~/.claude/projects/<project-dir>/<sessionId>.jsonl
    const allDirs = await readdir(CLAUDE_PROJECTS_DIR);
    const projectDirs = [];
    for (const d of allDirs) {
      try {
        const s = await stat(join(CLAUDE_PROJECTS_DIR, d));
        if (s.isDirectory()) projectDirs.push(d);
      } catch {}
    }

    // Try to find matching project dir by cwd
    let transcriptPath = null;
    if (cwd) {
      const cwdKey = cwd.replace(/[/ ]/g, '-');
      for (const dir of projectDirs) {
        if (cwdKey === dir || cwdKey.startsWith(dir)) {
          const candidate = join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
          try { await stat(candidate); transcriptPath = candidate; break; } catch {}
        }
      }
    }

    // Fallback: search all project dirs
    if (!transcriptPath) {
      for (const dir of projectDirs) {
        const candidate = join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
        try { await stat(candidate); transcriptPath = candidate; break; } catch {}
      }
    }

    if (!transcriptPath) return null;

    const fileStat = await stat(transcriptPath);
    const mtime = fileStat.mtimeMs;

    // If mtime unchanged since last read, return cached result
    if (cached && cached.mtime === mtime) {
      return cached.name;
    }

    // Read targeted portions: tail for customTitle, head for firstPrompt
    const fd = await fsOpen(transcriptPath, 'r');
    let name = null;
    try {
      const fileSize = fileStat.size;
      const CHUNK_SIZE = 65536; // 64KB — enough for title/first-message

      // Search for customTitle in last 64KB (set via /rename, typically near end)
      if (fileSize > 0) {
        const readSize = Math.min(fileSize, CHUNK_SIZE);
        const position = Math.max(0, fileSize - CHUNK_SIZE);
        const buffer = Buffer.alloc(readSize);
        const { bytesRead } = await fd.read(buffer, 0, readSize, position);
        const tail = buffer.slice(0, bytesRead).toString('utf8');
        const tailLines = tail.split('\n');

        for (let i = tailLines.length - 1; i >= 0; i--) {
          const line = tailLines[i].trim();
          if (!line) continue;
          try {
            if (line.includes('"custom-title"')) {
              const obj = JSON.parse(line);
              if (obj.type === 'custom-title' && obj.customTitle) {
                name = obj.customTitle;
                break;
              }
            }
          } catch {}
        }
      }

      // Fallback: first meaningful user message in first 64KB
      if (!name && fileSize > 0) {
        const readSize = Math.min(fileSize, CHUNK_SIZE);
        const buffer = Buffer.alloc(readSize);
        const { bytesRead } = await fd.read(buffer, 0, readSize, 0);
        const head = buffer.slice(0, bytesRead).toString('utf8');
        const headLines = head.split('\n');

        for (const line of headLines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            if (trimmed.includes('"type":"user"')) {
              const obj = JSON.parse(trimmed);
              if (obj.type === 'user' && obj.message) {
                const msgContent = obj.message.content;
                let text = null;
                if (typeof msgContent === 'string') {
                  text = msgContent.trim();
                } else if (Array.isArray(msgContent)) {
                  for (const block of msgContent) {
                    if (block.type === 'text' && block.text) {
                      const t = block.text.trim();
                      if (t && !t.startsWith('<') && !t.startsWith('[')) {
                        text = t;
                        break;
                      }
                    }
                  }
                }
                if (text && text.startsWith('<')) text = null;
                if (text && text.startsWith('[')) text = null;
                if (text && text.length > 3 && text !== 'No prompt') {
                  name = text.slice(0, 100);
                  break;
                }
              }
            }
          } catch {}
        }
      }
    } finally {
      await fd.close();
    }

    SESSION_NAME_CACHE.set(sessionId, { name, mtime, readAt: Date.now() });
    return name;
  } catch {
    return null;
  }
}

let nextPosition = { x: 50, y: 50 };

function getNextPosition() {
  const pos = { ...nextPosition };
  nextPosition.x += 50;
  nextPosition.y += 30;
  if (nextPosition.x > 400) {
    nextPosition.x = 50;
  }
  if (nextPosition.y > 300) {
    nextPosition.y = 50;
  }
  return pos;
}

export class TmuxService {
  async discoverExistingTerminals() {
    try {
      const savedTerminals = loadTerminalState();

      // Set scroll speed to 2 lines per wheel tick
      await execAsync(`${TMUX} bind-key -T copy-mode WheelUpPane send-keys -X -N 2 scroll-up 2>/dev/null || true`);
      await execAsync(`${TMUX} bind-key -T copy-mode WheelDownPane send-keys -X -N 2 scroll-down 2>/dev/null || true`);
      await execAsync(`${TMUX} bind-key -T copy-mode-vi WheelUpPane send-keys -X -N 2 scroll-up 2>/dev/null || true`);
      await execAsync(`${TMUX} bind-key -T copy-mode-vi WheelDownPane send-keys -X -N 2 scroll-down 2>/dev/null || true`);

      const { stdout } = await execAsync(`${TMUX} list-sessions -F "#{session_name}" 2>/dev/null || true`);
      const sessions = stdout.trim().split('\n').filter(s => s.startsWith('tc2-'));

      for (const session of sessions) {
        if (!session) continue;

        const savedTerminal = savedTerminals.find(t => t.tmuxSession === session);
        const id = savedTerminal?.id || session.replace('tc2-', '');
        const position = savedTerminal?.position || getNextPosition();
        const size = savedTerminal?.size || { width: 600, height: 400 };
        const workingDir = savedTerminal?.workingDir || '~';
        const device = localHostname;

        // Ensure position and size have valid values
        const validPosition = {
          x: typeof position.x === 'number' ? position.x : 50,
          y: typeof position.y === 'number' ? position.y : 50
        };
        const validSize = {
          width: typeof size.width === 'number' ? size.width : 600,
          height: typeof size.height === 'number' ? size.height : 400
        };

        const terminal = {
          id,
          workingDir,
          device,
          tmuxSession: session,
          position: validPosition,
          size: validSize,
          fullOutput: '',
        };

        terminals.set(id, terminal);
        // Configure tmux for restored sessions
        await execAsync(`${TMUX} set-option -t ${escapeShellArg(session)} status off 2>/dev/null || true`);
        // mouse mode intentionally OFF — see createTerminal comment
        await execAsync(`${TMUX} set-option -t ${escapeShellArg(session)} mouse off 2>/dev/null || true`);
        await execAsync(`${TMUX} set-option -t ${escapeShellArg(session)} history-limit 50000 2>/dev/null || true`);
      }

      this.persistState();

    } catch (error) {
      console.error('Error discovering terminals:', error);
    }

    return Array.from(terminals.values());
  }

  persistState() {
    const terminalList = Array.from(terminals.values()).map(t => ({
      id: t.id,
      workingDir: t.workingDir,
      device: t.device || localHostname,
      tmuxSession: t.tmuxSession,
      position: t.position || { x: 50, y: 50 },
      size: t.size || { width: 600, height: 400 },
    }));
    saveTerminalState(terminalList);
  }

  async listTerminals() {
    return Array.from(terminals.values());
  }

  async createTerminal(workingDir = '~', position, device, size) {
    const id = uuidv4();
    const sessionName = `tc2-${id}`;
    const validatedDir = validateWorkingDirectory(workingDir);

    // Local only: create tmux session in the specified directory
    await execAsync(`${TMUX} new-session -d -s ${escapeShellArg(sessionName)} -c ${escapeShellArg(validatedDir)}`);

    // Configure tmux for this session
    await execAsync(`${TMUX} set-option -t ${escapeShellArg(sessionName)} status off 2>/dev/null || true`);
    // NOTE: mouse mode intentionally OFF — it disables xterm.js text selection.
    // Scroll-through-history is handled by forwarding wheel events as SGR sequences from the client.
    await execAsync(`${TMUX} set-option -t ${escapeShellArg(sessionName)} history-limit 50000 2>/dev/null || true`);

    const terminal = {
      id,
      workingDir,
      device: localHostname,
      tmuxSession: sessionName,
      position: position || getNextPosition(),
      size: size || { width: 600, height: 400 },
      fullOutput: '',
    };

    terminals.set(id, terminal);
    this.persistState();

    return terminal;
  }

  /**
   * Resume a terminal: creates a new tmux session for an existing terminal ID.
   * Used for reconnecting dead terminals — reuses the same pane in the frontend.
   */
  async resumeTerminal(terminalId, workingDir = '~', command = null) {
    const sessionName = `tc2-${terminalId}`;
    const validatedDir = validateWorkingDirectory(workingDir);

    // Kill old session if it still exists (cleanup)
    try {
      await execAsync(`${TMUX} kill-session -t ${escapeShellArg(sessionName)} 2>/dev/null`);
    } catch { /* session already dead */ }

    // Create fresh tmux session
    await execAsync(`${TMUX} new-session -d -s ${escapeShellArg(sessionName)} -c ${escapeShellArg(validatedDir)}`);
    await execAsync(`${TMUX} set-option -t ${escapeShellArg(sessionName)} status off 2>/dev/null || true`);
    await execAsync(`${TMUX} set-option -t ${escapeShellArg(sessionName)} history-limit 50000 2>/dev/null || true`);

    // Run command if provided (e.g. claude --resume <id>)
    if (command) {
      await execAsync(`${TMUX} send-keys -t ${escapeShellArg(sessionName)} ${escapeShellArg(command)} Enter`);
    }

    const terminal = {
      id: terminalId,
      workingDir,
      device: localHostname,
      tmuxSession: sessionName,
      position: { x: 0, y: 0 },
      size: { width: 600, height: 400 },
      fullOutput: '',
    };

    terminals.set(terminalId, terminal);
    this.persistState();

    return terminal;
  }

  async closeTerminal(terminalId) {
    const terminal = terminals.get(terminalId);
    if (!terminal) throw new Error('Terminal not found');

    try {
      await execAsync(`${TMUX} kill-session -t ${escapeShellArg(terminal.tmuxSession)}`);
    } catch {
      // Session might already be dead
    }

    terminals.delete(terminalId);
    removeTerminalFromStorage(terminalId);
  }

  async captureOutput(terminalId) {
    const terminal = terminals.get(terminalId);
    if (!terminal) throw new Error('Terminal not found');

    try {
      const { stdout } = await execAsync(
        `${TMUX} capture-pane -t ${escapeShellArg(terminal.tmuxSession)} -p -S -500`
      );
      return stdout;
    } catch {
      return '';
    }
  }

  async captureHistory(terminalId) {
    const terminal = terminals.get(terminalId);
    if (!terminal) return '';

    try {
      // Check if the pane is in alternate screen mode (vim, nano, htop, etc.)
      // TUI apps don't need scrollback history — skip capture entirely to
      // prevent stale scrollback that breaks scroll behavior after reattach.
      const { stdout: altOn } = await execAsync(
        `${TMUX} display-message -p -t ${escapeShellArg(terminal.tmuxSession)} '#{alternate_on}'`,
        { timeout: 2000 }
      );
      if (altOn.trim() === '1') {
        return '';
      }

      // -p = print to stdout, -S - = from start of history, -E -1 = stop
      // before the visible screen (ttyd sends the live screen naturally).
      // Intentionally no -e: that flag injects tmux cursor-positioning sequences
      // (\e[H, \e[?25h/l, \e[J etc.) that aren't part of the original pty
      // stream. Replaying them in xterm.js corrupts cursor position and leaves
      // stale '_' glyphs at the start of lines throughout the scrollback.
      // maxBuffer raised to 10MB — default 1MB silently truncates long histories
      const { stdout } = await execAsync(
        `${TMUX} capture-pane -t ${escapeShellArg(terminal.tmuxSession)} -p -S - -E -1`,
        { maxBuffer: 10 * 1024 * 1024, timeout: 3000 }
      );
      return stdout;
    } catch {
      return '';
    }
  }

  async resizeTerminal(terminalId, cols, rows, pixelWidth, pixelHeight) {
    const terminal = terminals.get(terminalId);
    if (!terminal) throw new Error('Terminal not found');

    try {
      const validCols = validatePositiveInt(cols, 500);
      const validRows = validatePositiveInt(rows, 500);
      await execAsync(`${TMUX} resize-pane -t ${escapeShellArg(terminal.tmuxSession)} -x ${validCols} -y ${validRows}`);
    } catch {
      // Resize might fail if terminal is detached
    }

    // Persist pixel dimensions so the pane size survives agent restart
    if (pixelWidth && pixelHeight) {
      terminal.size = { width: pixelWidth, height: pixelHeight };
      this.persistState();
    }
  }

  /**
   * Force tmux to redraw a terminal pane by nudging its size +1/-1 row.
   * This makes tmux resend the full screen content (including alternate screen
   * switch \e[?1049h) through ttyd, fixing stale terminals after relay reconnects.
   */
  async forceRedraw(terminalId, cols, rows) {
    const terminal = terminals.get(terminalId);
    if (!terminal || !cols || !rows) return;
    try {
      const session = escapeShellArg(terminal.tmuxSession);
      const validCols = validatePositiveInt(cols, 500);
      const validRows = validatePositiveInt(rows, 500);
      await execAsync(`${TMUX} resize-pane -t ${session} -x ${validCols} -y ${validRows + 1} 2>/dev/null || true`);
      await execAsync(`${TMUX} resize-pane -t ${session} -x ${validCols} -y ${validRows} 2>/dev/null || true`);
    } catch {
      // Redraw might fail if terminal is detached
    }
  }

  async scrollTerminal(terminalId, lines) {
    const terminal = terminals.get(terminalId);
    if (!terminal) return;
    const session = escapeShellArg(terminal.tmuxSession);
    const direction = lines < 0 ? 'scroll-up' : 'scroll-down';
    const count = Math.min(Math.abs(lines), 15);
    try {
      // Enter copy-mode with -e (auto-exit at bottom), then scroll
      await execAsync(`${TMUX} copy-mode -e -t ${session} 2>/dev/null || true`);
      for (let i = 0; i < count; i++) {
        await execAsync(`${TMUX} send-keys -t ${session} -X ${direction}`);
      }
    } catch {
      // Scroll might fail if terminal is detached
    }
  }

  getTerminal(terminalId) {
    return terminals.get(terminalId);
  }

  async getProcessInfo(terminalId) {
    const terminal = terminals.get(terminalId);
    if (!terminal) return null;

    try {
      const { stdout } = await execAsync(
        `${TMUX} display-message -t ${escapeShellArg(terminal.tmuxSession)} -p "#{pane_current_command}" 2>/dev/null`
      );
      const command = stdout.trim();
      return {
        command,
        isClaude: command === 'claude'
      };
    } catch {
      return null;
    }
  }

  async getAllProcessInfo() {
    const results = {};
    for (const [id, terminal] of terminals) {
      try {
        const { stdout } = await execAsync(
          `${TMUX} display-message -t ${escapeShellArg(terminal.tmuxSession)} -p "#{pane_current_command}" 2>/dev/null`
        );
        const command = stdout.trim();
        results[id] = { command, isClaude: command === 'claude' };
      } catch {
        results[id] = null;
      }
    }
    return results;
  }

  // Batch-fetch session info for all tc2 terminals in a single tmux call
  async batchGetSessionInfo() {
    const results = {};
    try {
      const { stdout } = await execAsync(
        `${TMUX} list-panes -a -F "#{session_name}|#{pane_current_command}|#{pane_current_path}|#{pane_active}|#{pane_pid}|#{alternate_on}" 2>/dev/null`
      );
      for (const line of stdout.trim().split('\n')) {
        if (!line || !line.startsWith('tc2-')) continue;
        const parts = line.split('|');
        if (parts.length < 6) continue;
        const [session, command, cwd, active, pid, altOn] = parts;
        if (active !== '1') continue; // Only active panes
        const id = session.replace('tc2-', '');
        if (!terminals.has(id)) continue;
        results[id] = { session, command, cwd, pid, isClaude: /^claude/i.test(command), alternateOn: altOn === '1' };
      }
    } catch {
      // Silently fail - returns empty results
    }
    return results;
  }

  // Location lookup with 30s cache keyed by cwd
  async getCachedLocation(cwd) {
    if (!cwd) return null;
    const cached = locationCache.get(cwd);
    if (cached && Date.now() - cached.timestamp < LOCATION_CACHE_TTL) {
      return cached.location;
    }
    const location = await this.detectClaudeLocation(cwd);
    locationCache.set(cwd, { location, timestamp: Date.now() });
    return location;
  }

  async detectClaudeLocation(cwd) {
    if (!cwd) return null;

    try {
      const { stdout: gitRoot } = await execAsync(
        `git -C ${escapeShellArg(cwd)} rev-parse --show-toplevel 2>/dev/null`
      );
      const repoPath = gitRoot.trim();

      if (repoPath) {
        const repoName = repoPath.split('/').pop();
        return { type: 'git', name: repoName, path: repoPath };
      }
    } catch {
      // Not a git repo, fall through
    }

    const parts = cwd.replace(/\/$/, '').split('/').filter(p => p);
    const lastTwo = parts.slice(-2).join('/');
    return { type: 'path', name: lastTwo || cwd, path: cwd };
  }

  /**
   * Detect Claude's state by parsing tmux pane content (screen scraping).
   * Examines the last 20 non-empty lines for known UI patterns.
   */
  detectClaudeState(paneContent) {
    const lines = paneContent.split('\n');
    // Strip trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    const lastLines = lines.slice(-20).join('\n');

    // Permission prompts — Claude Code's tool-use permission dialog.
    // The dialog always shows numbered choices including "2. Yes, ..." (e.g. "2. Yes, allow reading from home/...")
    // Matching on the numbered choice format avoids false positives from conversational text like
    // "do you want to..." or "Allow me to..." that Claude writes in normal output.
    if (/^\s*2\.\s+Yes,\s/m.test(lastLines)) {
      return 'permission';
    }

    // Question prompts — Claude is asking the user a question.
    // Patterns are anchored to line-start to avoid false positives from conversational
    // text (e.g. "When you press Enter → shell produces output" should NOT match).
    const questionPatterns = [
      /^\s*Press Enter/im,
      /Enter to select/i,
      /↑\/↓ to navigate/,
      /Esc to cancel/i,
      /\[use arrows/i,
    ];

    for (const pattern of questionPatterns) {
      if (pattern.test(lastLines)) {
        return 'question';
      }
    }

    if (/esc to interrupt/i.test(lastLines)) {
      return 'working';
    }

    // Idle: prompt with non-breaking space
    if (/^❯[\s\xa0](?![\d])/m.test(lastLines)) {
      return 'idle';
    }

    // Idle: Claude Code splash/welcome screen
    if (/⏵⏵\s*bypass permissions/i.test(lastLines)) {
      return 'idle';
    }

    return 'working';
  }

  /**
   * Get all Claude states by screen-scraping tmux panes (no hooks required).
   * Uses tmux capture-pane + detectClaudeState() for each Claude terminal.
   */
  async getAllClaudeStates() {
    const results = {};

    // Step 1: Single tmux call for all session commands + paths
    const sessionInfo = await this.batchGetSessionInfo();

    // Step 2: Process-based fallback for terminals not detected as Claude by command name.
    // On macOS, tmux may report the foreground process as 'node' instead of 'claude'.
    // Use pane_pid to inspect child process command lines for 'claude'.
    const nonClaudeIds = [];
    for (const [id] of terminals) {
      const info = sessionInfo[id];
      if (!info) {
        results[id] = { isClaude: false, state: null, cwd: null, alternateOn: false };
      } else if (!info.isClaude) {
        nonClaudeIds.push(id);
      }
    }

    if (nonClaudeIds.length > 0) {
      const fallbackChecks = nonClaudeIds.map(async (id) => {
        const info = sessionInfo[id];
        const pid = parseInt(info.pid, 10);
        if (isNaN(pid) || pid <= 0) return;
        try {
          // Get PIDs of direct child processes of the shell
          const { stdout: childOutput } = await execAsync(
            `pgrep -P ${pid} 2>/dev/null || true`
          );
          const childPids = childOutput.trim().split('\n').filter(p => /^\d+$/.test(p));
          if (childPids.length === 0) return;

          // Check command lines of child processes for 'claude'
          const { stdout: psOutput } = await execAsync(
            `ps -p ${childPids.join(',')} -o args= 2>/dev/null || true`
          );
          if (/claude/i.test(psOutput)) {
            info.isClaude = true;
          }
        } catch {
          // Process inspection failed — leave as non-Claude
        }
      });
      await Promise.all(fallbackChecks);
    }

    // Mark remaining non-Claude terminals
    for (const id of nonClaudeIds) {
      const info = sessionInfo[id];
      if (!info.isClaude) {
        results[id] = { isClaude: false, state: null, cwd: info.cwd || null, alternateOn: info.alternateOn };
      }
    }

    // Step 3: Resolve Claude terminal states via screen scraping in parallel
    const claudeEntries = Object.entries(sessionInfo).filter(([, info]) => info.isClaude);
    if (claudeEntries.length === 0) return results;

    const statePromises = claudeEntries.map(async ([id, info]) => {
      try {
        const terminal = terminals.get(id);
        const { stdout: paneContent } = await execAsync(
          `${TMUX} capture-pane -t ${escapeShellArg(terminal.tmuxSession)} -p 2>/dev/null`
        );
        const state = this.detectClaudeState(paneContent);
        const location = await this.getCachedLocation(info.cwd);
        const claudeSessionId = await this.resolveClaudeSessionForPane(info.pid);
        const claudeSessionName = await resolveClaudeSessionName(claudeSessionId, info.cwd);
        return [id, { isClaude: true, state, command: 'claude', location, cwd: info.cwd, claudeSessionId, claudeSessionName, alternateOn: info.alternateOn }];
      } catch {
        const location = await this.getCachedLocation(info.cwd);
        const claudeSessionId = await this.resolveClaudeSessionForPane(info.pid);
        const claudeSessionName = await resolveClaudeSessionName(claudeSessionId, info.cwd);
        return [id, { isClaude: true, state: 'working', command: 'claude', location, cwd: info.cwd, claudeSessionId, claudeSessionName, alternateOn: info.alternateOn }];
      }
    });

    const claudeResults = await Promise.all(statePromises);
    for (const [id, state] of claudeResults) {
      results[id] = state;
    }

    return results;
  }

  /**
   * Resolve the Claude session ID for a tmux pane by its shell PID.
   * The pane PID is the shell process; claude runs as a child of that shell.
   * We find the claude child PID, then resolve its session ID from debug logs.
   */
  async resolveClaudeSessionForPane(panePid) {
    if (!panePid) return null;
    const pid = parseInt(panePid, 10);
    if (isNaN(pid) || pid <= 0) return null;

    try {
      // Find child processes of the shell that are 'claude'
      const { stdout } = await execAsync(
        `pgrep -P ${pid} 2>/dev/null || true`
      );
      const childPids = stdout.trim().split('\n').filter(p => /^\d+$/.test(p));
      if (childPids.length === 0) {
        // Maybe the pane PID IS the claude process directly
        return await resolveClaudeSessionId(pid);
      }

      // Check which child is claude
      for (const cpid of childPids) {
        try {
          const { stdout: cmdline } = await execAsync(
            `ps -p ${cpid} -o comm= 2>/dev/null || true`
          );
          if (/claude/i.test(cmdline.trim())) {
            return await resolveClaudeSessionId(parseInt(cpid, 10));
          }
        } catch { continue; }
      }

      // Fallback: try the first child
      return await resolveClaudeSessionId(parseInt(childPids[0], 10));
    } catch {
      return null;
    }
  }
}

export const tmuxService = new TmuxService();
