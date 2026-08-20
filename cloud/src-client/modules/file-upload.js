// ─── File Upload ──────────────────────────────────────────────────────────
// Driving the agent's chunked upload protocol from the browser.
//
// Files are sliced client-side and sent one chunk per agent request, because
// the relay caps a message at 1MB and chunks travel base64-encoded inside JSON
// (see agent/services/uploads.js). The chunk size comes from the agent's begin
// response rather than being hardcoded here, so the two cannot disagree about
// it after an agent update.
//
// Chunks go out strictly in order and one at a time. The agent rejects an
// out-of-order sequence rather than writing at the wrong offset, so pipelining
// would need the agent to buffer and reorder; sequential is slower and cannot
// silently corrupt a file.

import { agentRequest } from './ws-transport.js';

const DEFAULT_CHUNK_SIZE = 512 * 1024;

export class UploadCancelled extends Error {
  constructor() {
    super('Upload cancelled');
    this.name = 'UploadCancelled';
  }
}

// Read one Blob slice as base64, without the data: prefix FileReader adds.
function sliceToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.readAsDataURL(blob);
  });
}

function joinPath(dir, name) {
  return `${String(dir).replace(/\/+$/, '')}/${name}`;
}

/**
 * Upload one file into a directory on the agent.
 *
 * @param {object} opts
 * @param {File}   opts.file
 * @param {string} opts.dir            destination directory on the agent
 * @param {string} [opts.agentId]
 * @param {'error'|'overwrite'|'keep-both'} [opts.collision]
 * @param {AbortSignal} [opts.signal]  cancels between chunks
 * @param {(p: {sent: number, total: number}) => void} [opts.onProgress]
 * @param {Function} [opts.request]    transport, injectable for tests
 * @returns {Promise<{path: string, fileName: string, size: number}>}
 */
export async function uploadFile({
  file, dir, agentId, collision = 'error', signal, onProgress, request = agentRequest,
}) {
  const destPath = joinPath(dir, file.name);

  // Collision policy and the size ceiling are resolved here, before any bytes
  // move, so a doomed upload fails at once rather than after the wait.
  const begin = await request(
    'POST', '/api/files/upload/begin',
    { path: destPath, size: file.size, collision },
    agentId,
  );

  const uploadId = begin.id;
  const chunkSize = begin.chunkSize || DEFAULT_CHUNK_SIZE;

  // From here on any failure has to take the agent's temp file with it, or an
  // abandoned upload sits in the user's directory until the idle sweep.
  const abort = () => {
    request('POST', '/api/files/upload/abort', { id: uploadId }, agentId)
      .catch(() => { /* best effort: the sweep is the backstop */ });
  };

  try {
    let sent = 0;
    let seq = 0;

    onProgress?.({ sent: 0, total: file.size });

    while (sent < file.size) {
      if (signal?.aborted) throw new UploadCancelled();

      const end = Math.min(sent + chunkSize, file.size);
      const data = await sliceToBase64(file.slice(sent, end));

      if (signal?.aborted) throw new UploadCancelled();

      await request('POST', '/api/files/upload/chunk', { id: uploadId, seq, data }, agentId);

      sent = end;
      seq += 1;
      onProgress?.({ sent, total: file.size });
    }

    const result = await request('POST', '/api/files/upload/commit', { id: uploadId }, agentId);
    return result;
  } catch (e) {
    abort();
    throw e;
  }
}

/**
 * Upload several files in sequence, reporting per-file outcomes rather than
 * failing the batch on the first error: one unwritable file should not discard
 * the rest of a drop.
 *
 * onCollision is asked for a policy when a file already exists, and may return
 * 'overwrite', 'keep-both' or 'skip'.
 */
export async function uploadFiles({
  files, dir, agentId, signal, onProgress, onCollision, onFileDone, request = agentRequest,
}) {
  const results = [];

  for (const file of Array.from(files)) {
    if (signal?.aborted) {
      results.push({ file, status: 'cancelled' });
      continue;
    }

    const attempt = async (collision) => uploadFile({
      file, dir, agentId, collision, signal, request,
      onProgress: (p) => onProgress?.({ file, ...p }),
    });

    try {
      let result;
      try {
        result = await attempt('error');
      } catch (e) {
        // The agent answers a collision with EEXIST specifically so this is a
        // question to put to the user rather than a failure to report.
        if (!isCollision(e)) throw e;
        const choice = onCollision ? await onCollision(file) : 'skip';
        if (choice === 'skip' || !choice) {
          results.push({ file, status: 'skipped' });
          onFileDone?.({ file, status: 'skipped' });
          continue;
        }
        result = await attempt(choice);
      }
      results.push({ file, status: 'done', result });
      onFileDone?.({ file, status: 'done', result });
    } catch (e) {
      const status = e instanceof UploadCancelled ? 'cancelled' : 'failed';
      results.push({ file, status, error: e });
      onFileDone?.({ file, status, error: e });
    }
  }

  return results;
}

// The relay surfaces an agent error as a message string, so the code has to be
// recovered from the text. Matching on 'already exists' as well as the code
// keeps this working if the envelope changes shape.
export function isCollision(e) {
  const msg = String(e?.message || '');
  return e?.code === 'EEXIST' || /EEXIST|already exists/i.test(msg);
}
