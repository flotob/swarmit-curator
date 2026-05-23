/**
 * Meta repository — scalar key-value state.
 */

import { getDb } from '../sqlite.js';

export function getMeta(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
}

/**
 * Delete every meta row whose key starts with `prefix`. Returns the number of
 * rows removed. The prefix is matched literally — SQL LIKE wildcards in it are
 * escaped.
 */
export function clearMetaWithPrefix(prefix) {
  // `_` and `%` are LIKE wildcards — escape them so a prefix like
  // `last_published_hash:` matches literally.
  const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
  const result = getDb()
    .prepare("DELETE FROM meta WHERE key LIKE ? ESCAPE '\\'")
    .run(`${escaped}%`);
  return result.changes;
}

export function getLastProcessedBlock() {
  const val = getMeta('last_processed_block');
  return val !== null ? parseInt(val, 10) : null;
}

export function setLastProcessedBlock(block) {
  setMeta('last_processed_block', block);
}

export function getRepublishGlobal() {
  return getMeta('republish_global') === 'true';
}

export function setRepublishGlobal(val) {
  setMeta('republish_global', val ? 'true' : 'false');
}

export function getRepublishProfile() {
  return getMeta('republish_profile') === 'true';
}

export function setRepublishProfile(val) {
  setMeta('republish_profile', val ? 'true' : 'false');
}
