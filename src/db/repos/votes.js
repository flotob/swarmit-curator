/**
 * Votes repository — SQL-owned stale-event guard.
 */

import { getDb } from '../sqlite.js';

/**
 * Apply a vote event. Only updates if the event is newer than stored state.
 * @returns {boolean} true if state was actually changed
 */
export function applyVoteEvent({ submissionRef, upvotes, downvotes, blockNumber, logIndex }) {
  const score = upvotes - downvotes;
  const result = getDb().prepare(`
    INSERT INTO votes (submission_ref, upvotes, downvotes, score, updated_at_block, updated_at_log_index)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (submission_ref) DO UPDATE SET
      upvotes              = excluded.upvotes,
      downvotes            = excluded.downvotes,
      score                = excluded.score,
      updated_at_block     = excluded.updated_at_block,
      updated_at_log_index = excluded.updated_at_log_index
    WHERE
      excluded.updated_at_block > votes.updated_at_block
      OR (excluded.updated_at_block = votes.updated_at_block
          AND excluded.updated_at_log_index > votes.updated_at_log_index)
  `).run(submissionRef, upvotes, downvotes, score, blockNumber, logIndex);

  return result.changes > 0;
}

/**
 * Get vote totals for a submission.
 * @returns {{ upvotes, downvotes, score, updatedAtBlock, updatedAtLogIndex } | null}
 */
export function getVotesForSubmission(submissionRef) {
  const row = getDb().prepare('SELECT * FROM votes WHERE submission_ref = ?').get(submissionRef);
  if (!row) return null;
  return {
    upvotes: row.upvotes,
    downvotes: row.downvotes,
    score: row.score,
    updatedAtBlock: row.updated_at_block,
    updatedAtLogIndex: row.updated_at_log_index,
  };
}

/**
 * Batch query: get vote totals for multiple submissions.
 * @param {string[]} submissionRefs
 * @returns {Map<string, { upvotes, downvotes, score }>}
 */
export function getVotesBatch(submissionRefs) {
  if (submissionRefs.length === 0) return new Map();
  const db = getDb();
  const placeholders = submissionRefs.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT * FROM votes WHERE submission_ref IN (${placeholders})`).all(...submissionRefs);
  const result = new Map();
  for (const row of rows) {
    result.set(row.submission_ref, { upvotes: row.upvotes, downvotes: row.downvotes, score: row.score });
  }
  return result;
}
