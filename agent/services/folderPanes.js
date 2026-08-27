import { randomUUID } from 'crypto';
import { join } from 'path';
import { config } from '../src/config.js';
import { createJsonStore } from './jsonStore.js';

const DATA_DIR = config.dataDir;
const FOLDER_PANES_FILE = join(DATA_DIR, 'folder-panes.json');

const folderPanesStore = createJsonStore({
  file: FOLDER_PANES_FILE,
  key: 'folderPanes',
  loadError: '[FolderPanes] Error loading folder panes:',
  saveError: '[FolderPanes] Error saving folder panes:',
});

let folderPanesCache = folderPanesStore.load();

export const folderPaneService = {
  listFolderPanes() {
    return folderPanesCache;
  },

  getFolderPane(id) {
    return folderPanesCache.find(f => f.id === id);
  },

  createFolderPane({ folderPath, position, size }) {
    const id = randomUUID();
    const folderPane = {
      id,
      folderPath: folderPath || '~',
      position: position || { x: 100, y: 100 },
      size: size || { width: 400, height: 500 },
      createdAt: new Date().toISOString()
    };

    folderPanesCache.push(folderPane);
    folderPanesStore.save(folderPanesCache);

    return folderPane;
  },

  updateFolderPane(id, updates) {
    const index = folderPanesCache.findIndex(f => f.id === id);
    if (index === -1) {
      throw new Error(`Folder pane not found: ${id}`);
    }

    const folderPane = folderPanesCache[index];

    if (updates.folderPath !== undefined) {
      folderPane.folderPath = updates.folderPath;
    }

    folderPanesCache[index] = folderPane;
    folderPanesStore.save(folderPanesCache);

    return folderPane;
  },

  deleteFolderPane(id) {
    const index = folderPanesCache.findIndex(f => f.id === id);
    if (index !== -1) {
      folderPanesCache.splice(index, 1);
      folderPanesStore.save(folderPanesCache);
    }
  }
};
