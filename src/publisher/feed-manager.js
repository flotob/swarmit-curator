/**
 * Feed manager — creates and updates Swarm feeds for board/thread/global indexes.
 */

import { createFeedManifest, updateFeed as updateSwarmFeed, publishJSON } from '../swarm/client.js';
import { hexToBzz } from '../protocol/references.js';
import { getFeed, setFeed } from '../indexer/state.js';
import { validate } from '../protocol/objects.js';

/**
 * Ensure a feed exists for a given name. Returns the manifest reference.
 * Idempotent: creates on first call, returns cached ref on subsequent calls.
 * @param {string} feedName
 * @returns {Promise<string>} Feed manifest hex reference
 */
async function ensureFeed(feedName) {
  let manifestRef = getFeed(feedName);
  if (manifestRef) return manifestRef;

  manifestRef = await createFeedManifest(feedName);
  setFeed(feedName, manifestRef);
  console.log(`[Feeds] Created feed "${feedName}" → ${manifestRef}`);
  return manifestRef;
}

/**
 * Publish an index object and update its feed.
 * Validates the object before publishing.
 * @param {string} feedName
 * @param {Object} indexObj - A boardIndex, threadIndex, or globalIndex
 * @param {string} label - For logging
 * @returns {Promise<string>} The published content reference hex
 */
export async function publishAndUpdateFeed(feedName, indexObj, label) {
  // Validate before publish
  const result = validate(indexObj);
  if (!result.valid) {
    throw new Error(`${label} validation failed: ${result.errors.join(', ')}`);
  }

  const contentRef = await publishJSON(indexObj);
  await ensureFeed(feedName);
  await updateSwarmFeed(feedName, contentRef);
  console.log(`[Feeds] Updated "${feedName}" → ${contentRef} (${label})`);
  return contentRef;
}

/**
 * Get the bzz:// URL for a feed.
 * @param {string} feedName
 * @returns {string|null}
 */
export function getFeedBzzUrl(feedName) {
  const ref = getFeed(feedName);
  return ref ? hexToBzz(ref) : null;
}
