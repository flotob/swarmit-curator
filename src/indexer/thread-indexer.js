/**
 * Thread indexer — builds threadIndex per root submission from the reply tree.
 */

import { buildThreadIndex } from 'swarmit-protocol';
import { getRepliesForRoot } from './state.js';
import config from '../config.js';

/**
 * Build a threadIndex for a root submission.
 * @param {Object} rootSubmission - The root post submission entry (with submissionRef)
 * @returns {Object} A valid threadIndex protocol object
 */
export function buildThreadIndexForRoot(rootSubmission) {
  const rootRef = rootSubmission.submissionRef;
  const replies = getRepliesForRoot(rootRef);

  // Sort replies by announcement order
  replies.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return a.logIndex - b.logIndex;
  });

  // Build depth map: submissionRef → depth
  const depthMap = new Map();
  depthMap.set(rootRef, 0);

  for (const reply of replies) {
    const parentDepth = depthMap.get(reply.parentSubmissionId) ?? 0;
    depthMap.set(reply.submissionRef, parentDepth + 1);
  }

  // Build nodes: root + replies
  const nodes = [
    { submissionId: rootRef, parentSubmissionId: null, depth: 0 },
    ...replies.map((r) => ({
      submissionId: r.submissionRef,
      parentSubmissionId: r.parentSubmissionId,
      depth: depthMap.get(r.submissionRef) || 1,
    })),
  ];

  return buildThreadIndex({
    rootSubmissionId: rootRef,
    curator: config.curatorAddress,
    nodes,
  });
}
