/**
 * Republish boards repository — boards needing feed republish.
 */

import { getDb, inTransaction } from '../sqlite.js';
import { replaceAll } from '../helpers.js';
import { setRepublishGlobal } from './meta.js';

export function getRepublishBoards() {
  return new Set(getDb().prepare('SELECT slug FROM republish_boards').all().map((r) => r.slug));
}

export function setRepublishBoards(slugs) {
  replaceAll('republish_boards', ['slug'], [...slugs].map((s) => [s]));
}

export function addRepublishBoard(slug) {
  getDb().prepare('INSERT OR IGNORE INTO republish_boards (slug) VALUES (?)').run(slug);
}

/**
 * Mark a set of boards + the global feed as needing republish, atomically.
 * Used wherever the curator wants the next poll cycle to re-publish a group
 * of feeds together: event-driven dirty marking, liveness sweeps, and the
 * stamp-rotation heal wave.
 */
export function markBoardsDirty(slugs) {
  inTransaction(() => {
    for (const slug of slugs) addRepublishBoard(slug);
    setRepublishGlobal(true);
  });
}
