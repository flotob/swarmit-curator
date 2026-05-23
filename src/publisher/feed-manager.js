/**
 * Feed manager — creates and updates Swarm feeds for board/thread/global indexes.
 */

import { createHash } from 'node:crypto';
import { createFeedManifest, updateFeed as updateSwarmFeed, publishJSON } from '../swarm/client.js';
import { hexToBzz, validate } from 'swarmit-protocol';
import { getFeed, setFeed, getMeta, setMeta, inTransaction } from '../indexer/state.js';

// Exported so stamp-rotation can purge them on POSTAGE_BATCH_ID change without
// the two modules silently drifting if a prefix is ever renamed here.
export const PUBLISH_HASH_PREFIX = 'last_published_hash:';
export const PUBLISH_REF_PREFIX = 'last_published_ref:';

/**
 * SHA-256 of the index object's JSON, excluding the volatile `updatedAt` field.
 * Same content (regardless of when it was rebuilt) hashes the same — that's what
 * makes the no-change skip work on timer-driven refreshes.
 *
 * Relies on the protocol-object builders (boardIndex, threadIndex, etc.) emitting
 * keys in a stable order — they do, because each is a literal-key constructor.
 */
function contentHash(indexObj) {
  const { updatedAt: _ignored, ...stable } = indexObj;
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

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

  // No-change skip: most timer-driven refreshes rebuild an index that is byte-
  // identical (modulo `updatedAt`) to the last one we published. Both the data
  // chunk and the feed-update SOC would be wasted writes — and on a finite-
  // capacity postage batch they're an actively bad idea.
  const hashKey = `${PUBLISH_HASH_PREFIX}${feedName}`;
  const refKey = `${PUBLISH_REF_PREFIX}${feedName}`;
  const hash = contentHash(indexObj);
  if (hash === getMeta(hashKey)) {
    return getMeta(refKey);
  }

  const contentRef = await publishJSON(indexObj);
  await ensureFeed(feedName);
  await updateSwarmFeed(feedName, contentRef);
  // Persist AFTER the feed update succeeds — a failed updateFeed leaves the
  // stored hash unchanged so the next attempt retries the write. The pair is
  // atomic so a crash between them can't leave the skip path returning a stale
  // ref for an up-to-date hash.
  inTransaction(() => {
    setMeta(hashKey, hash);
    setMeta(refKey, contentRef);
  });
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
