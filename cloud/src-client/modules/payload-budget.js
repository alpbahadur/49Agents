// ─── Payload Budget ───────────────────────────────────────────────────────
// How much can go into one relay message.
//
// cloud/src/ws/relay.js caps both sockets at 1MB, deliberately, to bound what
// a single message can claim. Exceeding it is not a failed request: the
// receiving socket closes, so the whole relay connection goes down and every
// pane with it. Confirmed against the running server — an oversized send comes
// back to the browser as a 1006 close.
//
// Nothing checked this. Pasting a phone photo or a full-screen screenshot into
// a note read it as a data URL, base64 inflating it by a third, and handed it
// straight to agentRequest — so a paste dropped the connection.
//
// The guard belongs here rather than at each call site: a limit enforced in one
// place cannot be forgotten by the next feature that sends something large.

// Mirror of maxPayload in cloud/src/ws/relay.js. If that changes, this has to.
export const RELAY_MAX_BYTES = 1024 * 1024;

// What a caller may actually spend. The rest covers the JSON envelope the
// payload is wrapped in — type, id, agentId, path, method — plus any
// multi-byte characters that make a string longer in bytes than in length.
export const RELAY_BUDGET_BYTES = 900 * 1024;

// Byte length rather than string length: a JSON string of multi-byte
// characters is longer on the wire than in memory, and the cap is on bytes.
export function jsonByteLength(value) {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return 0;
    return new TextEncoder().encode(json).length;
  } catch {
    // Circular or unserialisable: it will fail at send anyway, and reporting
    // it as oversized is the safer of the two wrong answers.
    return Infinity;
  }
}

export function fitsInRelay(value, budget = RELAY_BUDGET_BYTES) {
  return jsonByteLength(value) <= budget;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'an unknown size';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes} bytes`;
}

/**
 * Whether a set of images can be added to a note.
 *
 * Judged on the whole array, not on the new image alone: saving a note sends
 * every one of its images in a single request, so three 400KB images breach a
 * 1MB cap that none of them approaches individually.
 *
 * @param {string[]} existing  images already on the note
 * @param {string[]} incoming  data URLs about to be added
 */
export function checkImageBudget(existing = [], incoming = [], budget = RELAY_BUDGET_BYTES) {
  const existingBytes = jsonByteLength(existing);
  const combined = [...existing, ...incoming];
  const totalBytes = jsonByteLength(combined);

  if (totalBytes <= budget) {
    return { ok: true, totalBytes, budget };
  }

  // Distinguishing the two cases matters for what the user is told: one image
  // too large to ever attach is a different problem from a note that has run
  // out of room.
  const incomingBytes = jsonByteLength(incoming);
  const singleTooLarge = incoming.length === 1 && incomingBytes > budget;

  return {
    ok: false,
    totalBytes,
    existingBytes,
    incomingBytes,
    budget,
    reason: singleTooLarge ? 'image-too-large' : 'note-full',
  };
}

// The message a user should see, in terms of what they did rather than of
// relay internals.
export function describeImageRejection(check) {
  if (check.reason === 'image-too-large') {
    return `That image is ${formatBytes(check.incomingBytes)}, over the ${formatBytes(check.budget)} limit for a note. `
      + 'Save it to a file and open it in a file pane instead.';
  }
  return `Adding this would take the note's images to ${formatBytes(check.totalBytes)}, over the `
    + `${formatBytes(check.budget)} limit. Remove an image first.`;
}
