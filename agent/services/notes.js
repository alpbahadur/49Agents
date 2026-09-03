import { randomUUID } from 'crypto';
import { join } from 'path';
import { config } from '../src/config.js';
import { createJsonStore } from './jsonStore.js';

const DATA_DIR = config.dataDir;
const NOTES_FILE = join(DATA_DIR, 'notes.json');

const notesStore = createJsonStore({
  file: NOTES_FILE,
  key: 'notes',
  loadError: '[Notes] Error loading notes:',
  saveError: '[Notes] Error saving notes:',
});

// In-memory cache
let notesCache = notesStore.load();

export const noteService = {
  /**
   * List all notes
   */
  listNotes() {
    return notesCache;
  },

  /**
   * Get a note by ID
   */
  getNote(id) {
    return notesCache.find(n => n.id === id);
  },

  /**
   * Create a new note
   */
  createNote({ position, size }) {
    const id = randomUUID();
    const note = {
      id,
      content: '',
      fontSize: 16,
      position: position || { x: 100, y: 100 },
      size: size || { width: 200, height: 100 },
      createdAt: new Date().toISOString()
    };

    notesCache.push(note);
    notesStore.save(notesCache);

    return note;
  },

  /**
   * Update a note
   */
  updateNote(id, updates) {
    const index = notesCache.findIndex(n => n.id === id);
    if (index === -1) {
      throw new Error(`Note not found: ${id}`);
    }

    const note = notesCache[index];

    // Position/size now handled by cloud-only storage
    if (updates.content !== undefined) {
      note.content = updates.content;
    }
    if (updates.fontSize !== undefined) {
      note.fontSize = updates.fontSize;
    }
    if (updates.images !== undefined) {
      note.images = updates.images;
    }

    notesCache[index] = note;
    notesStore.save(notesCache);

    return note;
  },

  /**
   * Delete a note
   */
  deleteNote(id) {
    const index = notesCache.findIndex(n => n.id === id);
    if (index !== -1) {
      notesCache.splice(index, 1);
      notesStore.save(notesCache);
    }
  }
};
