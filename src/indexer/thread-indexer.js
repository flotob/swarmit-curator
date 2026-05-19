/**
 * Thread indexer — builds threadIndex per root submission from the reply tree.
 */

import { buildThreadIndex } from 'swarmit-protocol';
import { getRepliesForRoot } from './state.js';
import config from '../config.js';

/**
 * Build a threadIndex for a root submission.
 *
 * Only live replies are included. A reply pruned by the liveness sweeps is
 * dropped, and so is any reply orphaned by a pruned ancestor — the whole
 * subtree below a missing reply is excluded.
 *
 * @param {Object} rootSubmission - The root post submission entry (with submissionRef)
 * @returns {Object} A valid threadIndex protocol object
 */
export function buildThreadIndexForRoot(rootSubmission) {
  const rootRef = rootSubmission.submissionRef;
  const replies = getRepliesForRoot(rootRef, true);

  // Announcement order — guarantees a reply's parent is processed before it.
  replies.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return a.logIndex - b.logIndex;
  });

  // `depth` doubles as the kept-node set: a reply is included only if its
  // parent has a depth (the root, or an already-kept reply). A missing parent
  // means a pruned ancestor — skipping the reply drops its subtree too, since
  // children are processed after parents.
  const depth = new Map([[rootRef, 0]]);
  const nodes = [{ submissionId: rootRef, parentSubmissionId: null, depth: 0 }];

  for (const reply of replies) {
    const parentDepth = depth.get(reply.parentSubmissionId);
    if (parentDepth === undefined) continue;
    depth.set(reply.submissionRef, parentDepth + 1);
    nodes.push({
      submissionId: reply.submissionRef,
      parentSubmissionId: reply.parentSubmissionId,
      depth: parentDepth + 1,
    });
  }

  return buildThreadIndex({
    rootSubmissionId: rootRef,
    curator: config.curatorAddress,
    nodes,
  });
}
