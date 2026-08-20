// ─── File Reads ───────────────────────────────────────────────────────────
// Reading a file's text for transport back to the browser.
//
// A response travels the same relay as a request and hits the same 1MB
// maxPayload (cloud/src/ws/relay.js). Nothing checked this: GET /api/files/read
// read the whole file and returned it in one message, so a large file did not
// merely fail to open — it exceeded the cap on the agent's own socket, and the
// cloud closes a socket that overruns it. The agent dropped offline, taking
// every pane with it, for the sin of opening a log file.
//
// The limit is deliberately symmetric with writing. Saving a file pane sends
// its whole content in one request, so a file that cannot be sent back cannot
// be saved either. Streaming reads in chunks without doing the same for writes
// would let someone open a file they could never save — a worse outcome than
// declining to open it.

import { readFileSync, statSync } from 'fs';

// Never read a file larger than this into memory at all. The precise check
// below needs the content in hand, and that must not mean loading a multi-
// gigabyte file to find out it is too big.
export const STAT_LIMIT_BYTES = 8 * 1024 * 1024;

// What the serialised content may occupy. Mirrors the client's relay budget in
// src-client/modules/payload-budget.js, less room for the rest of the response
// envelope — fileName, filePath, device.
export const CONTENT_BUDGET_BYTES = 880 * 1024;

// Byte length of the JSON encoding, which is what actually travels. Both JSON
// escaping and multi-byte characters make this larger than the file on disk,
// so the file's own size is too rough a proxy: a file of quotes and newlines
// nearly doubles, and one of CJK text triples per character.
export function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

export class FileTooLargeError extends Error {
  constructor(bytes, limit) {
    const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)}MB`;
    super(
      `File is too large to open (${mb(bytes)}); the limit is about ${mb(limit)}. `
      + 'Open it in a terminal instead.',
    );
    this.name = 'FileTooLargeError';
    this.code = 'EFBIG';
  }
}

/**
 * Read a file as text, refusing anything that could not be sent back.
 *
 * Checked in two stages: the file's size on disk first, so an enormous file is
 * declined without being read, then the size of its JSON encoding, which is
 * what the cap actually applies to.
 */
export function readTextFileForTransport(resolvedPath) {
  const { size } = statSync(resolvedPath);
  if (size > STAT_LIMIT_BYTES) {
    throw new FileTooLargeError(size, CONTENT_BUDGET_BYTES);
  }

  const content = readFileSync(resolvedPath, 'utf-8');

  const encoded = jsonByteLength(content);
  if (encoded > CONTENT_BUDGET_BYTES) {
    // Reported against the encoded size, since that is the number that
    // breached the limit — a file can be under it on disk and over it here.
    throw new FileTooLargeError(encoded, CONTENT_BUDGET_BYTES);
  }

  return content;
}
