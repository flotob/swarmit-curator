/**
 * Ingestion validator — validates fetched objects before indexing.
 * Rejects malformed objects, unknown boards, orphaned replies.
 */

import {
  isValidBzzRef,
  validateSubmission, validatePost, validateReply, validate,
} from 'swarmit-protocol';

/**
 * Validate a submission object fetched from Swarm.
 * @param {Object} submission
 * @param {Set<string>} knownBoards - Set of known board slugs
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateIngestedSubmission(submission, knownBoards) {
  const errors = validateSubmission(submission);

  // Check board is registered
  if (submission.boardId && !knownBoards.has(submission.boardId)) {
    errors.push(`board "${submission.boardId}" is not registered`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a content object (post or reply) fetched from Swarm.
 * @param {Object} content
 * @param {string} expectedKind - 'post' or 'reply'
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateIngestedContent(content, expectedKind) {
  if (!content || typeof content !== 'object') {
    return { valid: false, errors: ['content is null or not an object'] };
  }

  let errors;
  if (expectedKind === 'post') {
    errors = validatePost(content);
  } else if (expectedKind === 'reply') {
    errors = validateReply(content);
  } else {
    return { valid: false, errors: [`unexpected kind: ${expectedKind}`] };
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate reply parent/root consistency against known state.
 * @param {Object} submission - The reply submission
 * @param {(ref: string) => boolean} isKnown - predicate that returns true if a submission ref exists
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateReplyConsistency(submission, isKnown) {
  const errors = [];

  if (submission.kind !== 'reply') return { valid: true, errors: [] };

  const parentRef = submission.parentSubmissionId;
  const rootRef = submission.rootSubmissionId;

  if (!parentRef || !isValidBzzRef(parentRef)) {
    errors.push('reply missing valid parentSubmissionId');
  } else if (!isKnown(parentRef)) {
    errors.push(`parent submission ${parentRef} not found in state`);
  }

  if (!rootRef || !isValidBzzRef(rootRef)) {
    errors.push('reply missing valid rootSubmissionId');
  } else if (!isKnown(rootRef)) {
    errors.push(`root submission ${rootRef} not found in state`);
  }

  return { valid: errors.length === 0, errors };
}
