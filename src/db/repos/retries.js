/**
 * Retry submissions repository.
 */

import { getDb } from '../sqlite.js';
import { replaceAll } from '../helpers.js';

export function getRetrySubmissions() {
  return getDb().prepare('SELECT * FROM retry_submissions ORDER BY block_number, log_index').all().map((row) => ({
    submissionRef: row.submission_ref,
    author: row.author,
    blockNumber: row.block_number,
    logIndex: row.log_index,
  }));
}

export function setRetrySubmissions(subs) {
  replaceAll(
    'retry_submissions',
    ['submission_ref', 'author', 'block_number', 'log_index'],
    subs.map((s) => [s.submissionRef, s.author, s.blockNumber, s.logIndex]),
  );
}

export function addRetry(sub) {
  getDb().prepare(`
    INSERT OR IGNORE INTO retry_submissions (submission_ref, author, block_number, log_index)
    VALUES (?, ?, ?, ?)
  `).run(sub.submissionRef, sub.author, sub.blockNumber, sub.logIndex);
}

export function clearRetries() {
  getDb().prepare('DELETE FROM retry_submissions').run();
}
