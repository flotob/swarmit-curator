/**
 * Published profile keys repository.
 * Keys use type:scope naming: board:tech, view:best:global, view:best:board:tech
 */

import { getDb } from '../sqlite.js';
import { replaceAll } from '../helpers.js';

export function getPublishedKeys() {
  return new Set(getDb().prepare('SELECT key FROM published_profile_keys').all().map((r) => r.key));
}

export function setPublishedKeys(keys) {
  replaceAll('published_profile_keys', ['key'], keys.map((k) => [k]));
}

export function hasPublishedKey(key) {
  const row = getDb().prepare('SELECT 1 FROM published_profile_keys WHERE key = ?').get(key);
  return !!row;
}
