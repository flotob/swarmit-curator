/**
 * Vote events repository — individual vote history for time-aware ranking.
 */

import { getDb } from '../sqlite.js';

/**
 * Insert a vote event idempotently.
 * @param {{ submissionRef, voter, direction, previousDirection, blockNumber, logIndex, blockTimestampMs }} event
 */
export function insertVoteEvent({ submissionRef, voter, direction, previousDirection, blockNumber, logIndex, blockTimestampMs }) {
  const delta = direction - previousDirection;
  getDb().prepare(`
    INSERT OR IGNORE INTO vote_events
      (submission_ref, voter, direction, previous_direction, delta, block_number, log_index, block_timestamp_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(submissionRef, voter, direction, previousDirection, delta, blockNumber, logIndex, blockTimestampMs);
}

/**
 * Get the sum of vote deltas for a submission since a given time.
 * @param {string} submissionRef
 * @param {number} sinceMs - epoch ms cutoff
 * @returns {number}
 */
export function getRecentDelta(submissionRef, sinceMs) {
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(delta), 0) AS total
    FROM vote_events
    WHERE submission_ref = ? AND block_timestamp_ms >= ?
  `).get(submissionRef, sinceMs);
  return row.total;
}

/**
 * Batch query: get recent vote deltas for multiple submissions.
 * Avoids N+1 when preloading for ranking.
 * @param {string[]} submissionRefs
 * @param {number} sinceMs
 * @returns {Map<string, number>}
 */
export function getRecentDeltasBatch(submissionRefs, sinceMs) {
  if (submissionRefs.length === 0) return new Map();

  const db = getDb();
  const placeholders = submissionRefs.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT submission_ref, COALESCE(SUM(delta), 0) AS total
    FROM vote_events
    WHERE submission_ref IN (${placeholders}) AND block_timestamp_ms >= ?
    GROUP BY submission_ref
  `).all(...submissionRefs, sinceMs);

  const result = new Map();
  for (const row of rows) {
    result.set(row.submission_ref, row.total);
  }
  return result;
}
