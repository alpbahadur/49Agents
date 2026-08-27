import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/**
 * Creates a JSON-file-backed list store.
 *
 * Every pane service persists the same way: a single JSON file holding
 * `{ [key]: [...], version: 1 }`, created on demand, with read/write errors
 * logged and swallowed so a corrupt file never takes the agent down.
 *
 * @param {object}  options
 * @param {string}  options.file        Absolute path to the JSON file.
 * @param {string}  options.key         Property under which the list is stored.
 * @param {string}  options.loadError   Message logged when a read fails.
 * @param {string}  options.saveError   Message logged when a write fails.
 */
export function createJsonStore({ file, key, loadError, saveError }) {
  function ensureDataDir() {
    const dir = dirname(file);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  return {
    load() {
      try {
        ensureDataDir();
        if (!existsSync(file)) {
          return [];
        }
        const data = readFileSync(file, 'utf-8');
        const state = JSON.parse(data);
        return state[key] || [];
      } catch (error) {
        console.error(loadError, error);
        return [];
      }
    },

    save(items) {
      try {
        ensureDataDir();
        writeFileSync(file, JSON.stringify({ [key]: items, version: 1 }, null, 2));
      } catch (error) {
        console.error(saveError, error);
      }
    },
  };
}
