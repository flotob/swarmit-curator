/**
 * Stamp-rotation handling.
 *
 * The feed-manager's no-change skip (WP2) assumes "if the content hash matches
 * what we published before, the network still has that chunk." That holds only
 * while the postage batch we used is still valid. When the operator rotates
 * POSTAGE_BATCH_ID — typically because the previous batch expired or its
 * bucket capacity was exhausted — every cached hash now points to a chunk
 * stamped under the old (expired) batch, and the skip path silently keeps the
 * curator from re-publishing dormant threads onto the new stamp.
 *
 * On startup we compare the current env batch ID against the one we recorded
 * last time. If they differ — including the first-ever boot of this code on an
 * existing DB, where the stored value is null but the publish-hash cache is
 * populated from prior batches — we:
 *   1. Purge the publish-hash cache so WP2's skip path can't suppress writes.
 *   2. Mark every known board + the global feed as needing republish so the
 *      next poll actively re-stamps them rather than waiting for lazy triggers.
 * Both steps are needed: (1) alone leaves dormant boards stale until they see
 * activity, and (2) alone is defeated by WP2's cached hash matching.
 * Treating null as a mismatch is what heals the existing fleet on first deploy;
 * a truly empty DB makes the whole sequence a no-op.
 */

import {
  getMeta, setMeta, clearMetaWithPrefix, inTransaction,
  getAllBoards, markBoardsDirty,
} from '../indexer/state.js';
import { PUBLISH_HASH_PREFIX, PUBLISH_REF_PREFIX } from './feed-manager.js';

export const ACTIVE_BATCH_META_KEY = 'active_batch_id';
const PURGE_PREFIXES = [PUBLISH_HASH_PREFIX, PUBLISH_REF_PREFIX];

/**
 * @param {string} currentBatchId - The postage batch ID the curator is booting with.
 * @returns {{rotated: boolean, previous: string|null, purged: number, markedBoards: number}}
 */
export function runStampRotationCheck(currentBatchId) {
  if (!currentBatchId) {
    throw new Error('runStampRotationCheck: currentBatchId is required');
  }

  const previous = getMeta(ACTIVE_BATCH_META_KEY);
  if (previous === currentBatchId) {
    return { rotated: false, previous, purged: 0, markedBoards: 0 };
  }

  // Group every write so a crash mid-rotation can't leave `active_batch_id`
  // lagging behind a partially-wiped cache or a half-marked republish queue.
  // The nested inTransaction inside markBoardsDirty is safe — better-sqlite3
  // collapses re-entry into the outer transaction.
  const slugs = getAllBoards().map((b) => b.slug);
  let purged = 0;
  inTransaction(() => {
    for (const p of PURGE_PREFIXES) purged += clearMetaWithPrefix(p);
    markBoardsDirty(slugs);
    setMeta(ACTIVE_BATCH_META_KEY, currentBatchId);
  });

  const reason = previous === null ? 'first run with this code' : `was ${previous.slice(0, 16)}...`;
  console.log(`[Curator] Postage batch rotation detected (${reason}); purged ${purged} cached publish keys, marked ${slugs.length} boards + global for republish — feeds will be re-stamped on next publish cycle`);

  return { rotated: true, previous, purged, markedBoards: slugs.length };
}
