// ─── Uploads ──────────────────────────────────────────────────────────────
// Receiving a file from the browser, one chunk at a time.
//
// Uploads are chunked because they have to be. Both relay sockets cap a
// message at 1MB (cloud/src/ws/relay.js), deliberately, to bound how much
// memory one message can claim. Chunks arrive base64-encoded inside a JSON
// request, which inflates them by a third, so a whole file in one message
// would cap out somewhere under a megabyte — not a credible replacement for
// SFTP, which is what prompted this (gh-30).
//
// Bytes go to a temp file beside the destination and are renamed into place
// only on commit. A rename within a directory is atomic, so a connection that
// drops mid-transfer leaves a stray temp file rather than a half-written file
// where a real one is expected. Anything abandoned is swept on a timer.

import { createWriteStream, existsSync, renameSync, statSync, unlinkSync } from 'fs';
import { dirname, join, basename, extname } from 'path';
import { randomBytes } from 'crypto';
import { validateWorkingDirectory } from './sanitize.js';

// 512KB of file per chunk. Base64 takes that to ~683KB, leaving room under the
// 1MB cap for JSON framing and the rest of the envelope.
export const CHUNK_SIZE = 512 * 1024;

// Agreed ceiling. Memory is flat regardless — chunks stream straight to disk —
// so this bounds how long one upload can occupy the relay, not how much it can
// allocate.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// An upload with no activity for this long is assumed dead and swept. Long
// enough to survive a slow link between chunks, short enough that a closed
// laptop does not leave temp files behind for the rest of the day.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

const uploads = new Map();
let sweepTimer = null;

function startSweeping() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, upload] of uploads) {
      if (now - upload.touchedAt > IDLE_TIMEOUT_MS) abortUpload(id);
    }
    if (uploads.size === 0) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, SWEEP_INTERVAL_MS);
  // Never hold the process open for a sweep.
  sweepTimer.unref?.();
}

// A destination that does not collide. Suffixes before the extension, so
// notes.md becomes notes-1.md rather than notes.md-1.
export function nextAvailablePath(filePath) {
  if (!existsSync(filePath)) return filePath;

  const dir = dirname(filePath);
  const ext = extname(filePath);
  const stem = basename(filePath, ext);

  for (let i = 1; i < 1000; i++) {
    const candidate = join(dir, `${stem}-${i}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error('Could not find an available filename');
}

/**
 * Open an upload. Validates the destination and resolves the collision policy
 * before a single byte is accepted, so a doomed upload fails immediately
 * rather than after the user has waited for a hundred chunks.
 *
 * @param {object} opts
 * @param {string} opts.path      destination file path
 * @param {number} opts.size      total bytes the client intends to send
 * @param {'error'|'overwrite'|'keep-both'} [opts.collision]
 */
export function beginUpload({ path: destPath, size, collision = 'error' } = {}) {
  if (!destPath) throw new Error('path is required');

  const totalBytes = Number(size);
  if (!Number.isFinite(totalBytes) || totalBytes < 0) {
    throw new Error('size must be a non-negative number');
  }
  if (totalBytes > MAX_UPLOAD_BYTES) {
    throw new Error(`File exceeds the ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB upload limit`);
  }

  // Same boundary as every other file operation: $HOME or /tmp. Upload is the
  // one operation that puts caller-chosen bytes on disk, so it gets no wider
  // reach than reading and renaming already have. The validator normalises
  // before checking and returns the resolved path, so a destination that
  // climbs out of a permitted root is refused here rather than written to.
  const resolved = validateWorkingDirectory(destPath);

  const dir = dirname(resolved);
  if (!existsSync(dir)) {
    throw new Error(`Destination directory does not exist: ${dir}`);
  }
  if (!statSync(dir).isDirectory()) {
    throw new Error(`Destination parent is not a directory: ${dir}`);
  }

  let finalPath = resolved;
  if (existsSync(resolved)) {
    if (statSync(resolved).isDirectory()) {
      throw new Error(`Destination is a directory: ${resolved}`);
    }
    if (collision === 'keep-both') finalPath = nextAvailablePath(resolved);
    else if (collision !== 'overwrite') {
      const err = new Error(`File already exists: ${resolved}`);
      err.code = 'EEXIST';
      throw err;
    }
  }

  const id = randomBytes(16).toString('hex');
  // Hidden and suffixed so a directory listing mid-upload does not show
  // something that looks like a real file, and so two uploads of the same
  // name cannot collide on the temp path.
  const tempPath = join(dir, `.${basename(finalPath)}.${id}.part`);

  const upload = {
    id,
    finalPath,
    tempPath,
    totalBytes,
    receivedBytes: 0,
    nextSeq: 0,
    touchedAt: Date.now(),
    stream: createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }),
    failed: null,
  };

  // A stream error has to be remembered rather than thrown from an async
  // callback nothing is awaiting; the next chunk or the commit reports it.
  upload.stream.on('error', (e) => { upload.failed = e; });

  uploads.set(id, upload);
  startSweeping();

  return { id, path: finalPath, chunkSize: CHUNK_SIZE };
}

/**
 * Append one chunk. Sequence numbers are checked rather than trusted: writes
 * are appends, so accepting an out-of-order chunk would silently corrupt the
 * file at an offset nobody notices until much later.
 */
export function appendChunk({ id, seq, data } = {}) {
  const upload = uploads.get(id);
  if (!upload) throw new Error('Unknown upload id');
  if (upload.failed) {
    const e = upload.failed;
    abortUpload(id);
    throw e;
  }

  if (Number(seq) !== upload.nextSeq) {
    throw new Error(`Out-of-order chunk: expected ${upload.nextSeq}, got ${seq}`);
  }
  if (typeof data !== 'string') {
    throw new Error('data must be a base64 string');
  }

  const buf = Buffer.from(data, 'base64');
  if (upload.receivedBytes + buf.length > upload.totalBytes) {
    abortUpload(id);
    throw new Error('Upload exceeded its declared size');
  }

  upload.stream.write(buf);
  upload.receivedBytes += buf.length;
  upload.nextSeq += 1;
  upload.touchedAt = Date.now();

  return { received: upload.receivedBytes, total: upload.totalBytes };
}

/**
 * Finish an upload: flush, then rename into place. The rename is what makes
 * the whole thing atomic from the destination's point of view.
 *
 * async so every failure arrives the same way. Validating synchronously and
 * only then returning a promise meant an unknown id threw where an incomplete
 * upload rejected, and a caller handling one form silently missed the other.
 */
export async function commitUpload({ id } = {}) {
  const upload = uploads.get(id);
  if (!upload) throw new Error('Unknown upload id');

  try {
    if (upload.failed) throw upload.failed;

    // A short file means chunks were lost, and renaming it into place would
    // present truncated data as complete.
    if (upload.receivedBytes !== upload.totalBytes) {
      throw new Error(`Incomplete upload: received ${upload.receivedBytes} of ${upload.totalBytes} bytes`);
    }

    return new Promise((resolve, reject) => {
      upload.stream.end((err) => {
        if (err) {
          abortUpload(id);
          reject(err);
          return;
        }
        try {
          renameSync(upload.tempPath, upload.finalPath);
          uploads.delete(id);
          resolve({
            success: true,
            path: upload.finalPath,
            fileName: basename(upload.finalPath),
            size: upload.receivedBytes,
          });
        } catch (e) {
          abortUpload(id);
          reject(e);
        }
      });
    });
  } catch (e) {
    abortUpload(id);
    throw e;
  }
}

/** Cancel an upload and remove its temp file. Safe to call more than once. */
export function abortUpload(id) {
  const upload = uploads.get(id);
  if (!upload) return { success: true };

  uploads.delete(id);
  try { upload.stream.destroy(); } catch { /* already gone */ }
  try { if (existsSync(upload.tempPath)) unlinkSync(upload.tempPath); } catch { /* nothing to clean */ }
  return { success: true };
}

// Exposed for tests; nothing in the running agent needs to see inside.
export function _activeUploadCount() { return uploads.size; }
