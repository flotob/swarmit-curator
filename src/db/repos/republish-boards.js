/**
 * Republish boards repository — boards needing feed republish.
 */

import { getDb } from '../sqlite.js';
import { replaceAll } from '../helpers.js';

export function getRepublishBoards() {
  return new Set(getDb().prepare('SELECT slug FROM republish_boards').all().map((r) => r.slug));
}

export function setRepublishBoards(slugs) {
  replaceAll('republish_boards', ['slug'], [...slugs].map((s) => [s]));
}

export function addRepublishBoard(slug) {
  getDb().prepare('INSERT OR IGNORE INTO republish_boards (slug) VALUES (?)').run(slug);
}
