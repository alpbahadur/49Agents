import { randomUUID } from 'crypto';
import { writeFileSync, existsSync } from 'fs';
import { join, basename, resolve } from 'path';
import { homedir } from 'os';
import { config } from '../src/config.js';
import { createJsonStore } from './jsonStore.js';
import { validateWorkingDirectory } from './sanitize.js';
import { readTextFileForTransport } from './fileRead.js';

const DATA_DIR = config.dataDir;
const FILE_PANES_FILE = join(DATA_DIR, 'file-panes.json');

// Get local hostname
let localHostname = 'localhost';
try {
  const { execSync } = await import('child_process');
  localHostname = execSync('hostname', { encoding: 'utf-8' }).trim();
} catch {}

/**
 * Expand ~ to home directory
 */
function expandPath(filePath) {
  if (filePath.startsWith('~/')) {
    return join(homedir(), filePath.slice(2));
  }
  if (filePath.startsWith('~')) {
    return join(homedir(), filePath.slice(1));
  }
  return filePath;
}

/**
 * Expand path and validate it is within allowed directories ($HOME, /tmp).
 * Prevents path traversal attacks via file pane operations.
 */
function expandAndValidatePath(filePath) {
  // The validator normalises, follows symlinks and returns the canonical path,
  // so use what it returns rather than validating one path and reading another.
  return validateWorkingDirectory(expandPath(filePath));
}

/**
 * Read file content from local disk only (no SSH/remote)
 */
function readFileContent(filePath) {
  const expandedPath = expandAndValidatePath(filePath);
  if (!existsSync(expandedPath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  // Refuses anything that could not be sent back over the relay, rather than
  // reading it and closing the agent's socket on the way out.
  return readTextFileForTransport(expandedPath);
}

/**
 * Write file content to local disk only (no SSH/remote)
 */
function writeFileContent(filePath, content) {
  const expandedPath = expandAndValidatePath(filePath);
  writeFileSync(expandedPath, content, 'utf-8');
}

const filePanesStore = createJsonStore({
  file: FILE_PANES_FILE,
  key: 'filePanes',
  loadError: '[FilePanes] Error loading file panes:',
  saveError: '[FilePanes] Error saving file panes:',
});

// In-memory cache
let filePanesCache = filePanesStore.load();

export const filePaneService = {
  /**
   * List all file panes (with fresh content from disk for path-based files)
   */
  listFilePanes() {
    return filePanesCache.map(fp => {
      // Virtual files (from native picker) have content stored directly
      if (!fp.filePath) {
        return { ...fp };
      }
      // Path-based files - read fresh content from local disk
      try {
        const content = readFileContent(fp.filePath);
        return { ...fp, content };
      } catch (e) {
        return { ...fp, content: `Error reading file: ${e.message}` };
      }
    });
  },

  /**
   * Get a file pane by ID (optionally refresh from disk)
   */
  getFilePane(id, refresh = false) {
    const fp = filePanesCache.find(fp => fp.id === id);
    if (!fp) return null;

    // Virtual files always return stored content
    if (!fp.filePath) {
      return { ...fp };
    }

    if (refresh) {
      try {
        const content = readFileContent(fp.filePath);
        return { ...fp, content };
      } catch (e) {
        return { ...fp, content: `Error reading file: ${e.message}` };
      }
    }
    return fp;
  },

  /**
   * Create a new file pane
   * Supports two modes:
   * 1. filePath provided - read content from local disk
   * 2. fileName + content provided - use provided content (for native file picker)
   */
  createFilePane({ filePath, fileName, content: providedContent, position, size }) {
    let content;
    let finalFileName;
    let finalFilePath;

    if (filePath) {
      // Mode 1: Read from local path
      content = readFileContent(filePath);
      finalFileName = basename(expandPath(filePath));
      finalFilePath = filePath;
    } else if (fileName && providedContent !== undefined) {
      // Mode 2: Content provided directly (from native file picker)
      content = providedContent;
      finalFileName = fileName;
      finalFilePath = null; // No server path - file lives client-side
    } else {
      throw new Error('Either filePath or (fileName + content) must be provided');
    }

    const id = randomUUID();
    const filePane = {
      id,
      fileName: finalFileName,
      filePath: finalFilePath,
      device: localHostname,
      content: finalFilePath ? undefined : content, // Store content only for virtual files
      position: position || { x: 100, y: 100 },
      size: size || { width: 600, height: 400 },
      createdAt: new Date().toISOString()
    };

    filePanesCache.push(filePane);
    filePanesStore.save(filePanesCache);

    return { ...filePane, content };
  },

  /**
   * Update a file pane
   */
  updateFilePane(id, updates) {
    const index = filePanesCache.findIndex(fp => fp.id === id);
    if (index === -1) {
      throw new Error(`File pane not found: ${id}`);
    }

    const filePane = filePanesCache[index];

    // Position/size now handled by cloud-only storage
    if (updates.content !== undefined) {
      if (filePane.filePath) {
        // Path-based file - write content to local file
        writeFileContent(filePane.filePath, updates.content);
      } else {
        // Virtual file - store content in pane data
        filePane.content = updates.content;
      }
    }

    filePanesCache[index] = filePane;
    filePanesStore.save(filePanesCache);

    return filePane;
  },

  /**
   * Delete a file pane
   */
  deleteFilePane(id) {
    const index = filePanesCache.findIndex(fp => fp.id === id);
    if (index !== -1) {
      filePanesCache.splice(index, 1);
      filePanesStore.save(filePanesCache);
    }
  }
};
