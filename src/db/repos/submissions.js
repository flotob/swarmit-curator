/**
 * Submissions repository.
 */

import { getDb } from '../sqlite.js';

export function addSubmission(submissionRef, { boardId, kind, contentRef = '', parentSubmissionId, rootSubmissionId, author = '', blockNumber = 0, logIndex = 0, announcedAtMs }) {
  getDb().prepare(`
    INSERT OR IGNORE INTO submissions
      (submission_ref, board_slug, kind, content_ref, parent_submission_ref, root_submission_ref, author, block_number, log_index, announced_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(submissionRef, boardId, kind, contentRef, parentSubmissionId || null, rootSubmissionId || null, author, blockNumber, logIndex, announcedAtMs ?? null);
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
  };
}

export function getSubmissionsForBoard(boardSlug) {
  return getDb().prepare(`
    SELECT * FROM submissions WHERE board_slug = ?
    ORDER BY block_number DESC, log_index DESC
  `).all(boardSlug).map(rowToEntry);
}

export function getRootSubmissions(boardSlug) {
  return getDb().prepare(`
    SELECT * FROM submissions WHERE board_slug = ? AND kind = 'post'
    ORDER BY block_number DESC, log_index DESC
  `).all(boardSlug).map(rowToEntry);
}

export function getRepliesForRoot(rootSubmissionRef) {
  return getDb().prepare(`
    SELECT * FROM submissions WHERE root_submission_ref = ? AND kind = 'reply'
    ORDER BY block_number ASC, log_index ASC
  `).all(rootSubmissionRef).map(rowToEntry);
}
