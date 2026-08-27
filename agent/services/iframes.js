import { randomUUID } from 'crypto';
import { join } from 'path';
import { config } from '../src/config.js';
import { createJsonStore } from './jsonStore.js';

const DATA_DIR = config.dataDir;
const IFRAMES_FILE = join(DATA_DIR, 'iframes.json');

const iframesStore = createJsonStore({
  file: IFRAMES_FILE,
  key: 'iframes',
  loadError: '[Iframes] Error loading iframes:',
  saveError: '[Iframes] Error saving iframes:',
});

let iframesCache = iframesStore.load();

export const iframeService = {
  listIframes() {
    return iframesCache;
  },

  getIframe(id) {
    return iframesCache.find(f => f.id === id);
  },

  createIframe({ url, position, size }) {
    const id = randomUUID();
    const iframe = {
      id,
      url: url || '',
      position: position || { x: 100, y: 100 },
      size: size || { width: 800, height: 600 },
      createdAt: new Date().toISOString()
    };

    iframesCache.push(iframe);
    iframesStore.save(iframesCache);

    return iframe;
  },

  updateIframe(id, updates) {
    const index = iframesCache.findIndex(f => f.id === id);
    if (index === -1) {
      throw new Error(`Iframe not found: ${id}`);
    }

    const iframe = iframesCache[index];

    // Position/size now handled by cloud-only storage
    if (updates.url !== undefined) {
      iframe.url = updates.url;
    }

    iframesCache[index] = iframe;
    iframesStore.save(iframesCache);

    return iframe;
  },

  deleteIframe(id) {
    const index = iframesCache.findIndex(f => f.id === id);
    if (index !== -1) {
      iframesCache.splice(index, 1);
      iframesStore.save(iframesCache);
    }
  }
};
