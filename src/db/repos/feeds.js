/**
 * Feeds repository — feed manifest references.
 */

import { getDb } from '../sqlite.js';

export function getFeed(feedName) {
  const row = getDb().prepare('SELECT manifest_ref FROM feeds WHERE feed_name = ?').get(feedName);
  return row ? row.manifest_ref : null;
}

export function setFeed(feedName, manifestRef) {
  getDb().prepare('INSERT OR REPLACE INTO feeds (feed_name, manifest_ref) VALUES (?, ?)').run(feedName, manifestRef);
}
