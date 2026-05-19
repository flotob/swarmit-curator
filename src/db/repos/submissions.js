/**
 * Submissions repository.
 */

import { getDb } from '../sqlite.js';

// Restricts a query to LIVE submissions (not pruned by the liveness sweeps).
const LIVE_CLAUSE = 'AND stale_since IS NULL';

export function addSubmission(submissionRef, { boardId, kind, contentRef = '', parentSubmissionId, rootSubmissionId, author = '', blockNumber = 0, logIndex = 0, announcedAtMs, ingestedAt = Date.now() }) {
  getDb().prepare(`
    INSERT OR IGNORE INTO submissions
      (submission_ref, board_slug, kind, content_ref, parent_submission_ref, root_submission_ref, author, block_number, log_index, announced_at_ms, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(submissionRef, boardId, kind, contentRef, parentSubmissionId || null, rootSubmissionId || null, author, blockNumber, logIndex, announcedAtMs ?? null, ingestedAt);
}

export function hasSubmission(submissionRef) {
  const row = getDb().prepare('SELECT 1 FROM submissions WHERE submission_ref = ?').get(submissionRef);
  return !!row;
}

function rowToEntry(row) {
  return {
    submissionRef: row.submission_ref,
    boardId: row.board_slug,
    kind: row.kind,
    contentRef: row.content_ref,
    parentSubmissionId: row.parent_submission_ref,
    rootSubmissionId: row.root_submission_ref,
    author: row.author,
    blockNumber: row.block_number,
    logIndex: row.log_index,
    announcedAtMs: row.announced_at_ms,
    unreachableStrikes: row.unreachable_strikes,
    staleSince: row.stale_since,
    ingestedAt: row.ingested_at,
  };
}

export function getSubmissionsForBoard(boardSlug, liveOnly = false) {
  return getDb().prepare(`
    SELECT * FROM submissions WHERE board_slug = ? ${liveOnly ? LIVE_CLAUSE : ''}
    ORDER BY block_number DESC, log_index DESC
  `).all(boardSlug).map(rowToEntry);
}

export function getRootSubmissions(boardSlug, liveOnly = false) {
  return getDb().prepare(`
    SELECT * FROM submissions WHERE board_slug = ? AND kind = 'post' ${liveOnly ? LIVE_CLAUSE : ''}
    ORDER BY block_number DESC, log_index DESC
  `).all(boardSlug).map(rowToEntry);
}

export function getRepliesForRoot(rootSubmissionRef, liveOnly = false) {
  return getDb().prepare(`
    SELECT * FROM submissions WHERE root_submission_ref = ? AND kind = 'reply' ${liveOnly ? LIVE_CLAUSE : ''}
    ORDER BY block_number ASC, log_index ASC
  `).all(rootSubmissionRef).map(rowToEntry);
}

/**
 * All live submissions (posts and replies) ingested at or before `graceCutoff`.
 * Drives the death sweep; the cutoff skips just-ingested rows, since ingestion
 * already verified their retrievability. Omit it to return every live row.
 */
export function getLiveSubmissions(graceCutoff = Number.MAX_SAFE_INTEGER) {
  return getDb().prepare(`
    SELECT * FROM submissions
    WHERE stale_since IS NULL AND ingested_at <= ?
    ORDER BY ingested_at ASC
  `).all(graceCutoff).map(rowToEntry);
}

/**
 * Stale submissions still worth re-checking for resurrection. `cutoff` is a
 * stale_since give-up boundary: rows that went stale at or before it are
 * abandoned and excluded. A cutoff of 0 means "never give up".
 */
export function getResurrectionCandidates(cutoff = 0) {
  return getDb().prepare(`
    SELECT * FROM submissions
    WHERE stale_since IS NOT NULL AND (? = 0 OR stale_since > ?)
    ORDER BY stale_since ASC
  `).all(cutoff, cutoff).map(rowToEntry);
}

/** Set the consecutive-failed-check counter for a submission. */
export function setStrikes(submissionRef, strikes) {
  getDb().prepare('UPDATE submissions SET unreachable_strikes = ? WHERE submission_ref = ?')
    .run(strikes, submissionRef);
}

/** Mark a submission stale (excluded from feeds) as of `staleSince`. */
export function markStale(submissionRef, staleSince) {
  getDb().prepare('UPDATE submissions SET stale_since = ? WHERE submission_ref = ?')
    .run(staleSince, submissionRef);
}

/** Clear stale + strike state — the submission is retrievable again. */
export function markLive(submissionRef) {
  getDb().prepare('UPDATE submissions SET unreachable_strikes = 0, stale_since = NULL WHERE submission_ref = ?')
    .run(submissionRef);
}
