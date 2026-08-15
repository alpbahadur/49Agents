// ─── Pane Refresh Teardown ────────────────────────────────────────────────
// Git-graph, folder and beads panes each poll their agent on an interval and
// stash the timer id in a per-type Map keyed by pane id.
//
// Their render functions are re-entrant: loadPanesFromAgent re-renders every
// pane of an agent whenever that agent comes back online, and each render
// starts a fresh interval. Without this teardown the previous timer id is
// overwritten in the Map and becomes unreachable — it keeps firing forever,
// holding the detached pane subtree alive through its closure and polling the
// agent for a pane that is no longer in the document. Reconnect flaps then
// stack another orphan per pane each time.
//
// Kept in its own module because the three render functions live in two files
// that pane-creation.js already imports; putting the helper there would close
// a dependency cycle, and utils.js is documented as DOM-free.

/**
 * Stop a pane's refresh timer and drop its Map entry.
 *
 * Call at the top of a re-entrant render function, before the existing DOM
 * node is removed, and the render is then safe to run repeatedly for the same
 * pane id.
 *
 * @param {Map<string, {refreshInterval?: number}>} paneMap Per-type registry.
 * @param {string} paneId Pane being re-rendered.
 */
export function clearPaneRefresh(paneMap, paneId) {
  if (!paneMap) return;
  const info = paneMap.get(paneId);
  if (info?.refreshInterval) clearInterval(info.refreshInterval);
  paneMap.delete(paneId);
}
