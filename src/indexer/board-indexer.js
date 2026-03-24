/**
 * Board indexer — builds boardIndex per board, sorted by announcement order (newest first).
 */

import { buildBoardIndex } from '../protocol/objects.js';
import { hexToBzz } from '../protocol/references.js';
import { getRootSubmissions, getFeed } from './state.js';
import config from '../config.js';

/**
 * Build a boardIndex for a board.
 * @param {string} boardSlug
 * @returns {Object} A valid boardIndex protocol object
 */
export function buildBoardIndexForBoard(boardSlug) {
  const posts = getRootSubmissions(boardSlug);

  // Sort by announcement order: newest first (highest block, then highest logIndex)
  posts.sort((a, b) => {
    if (b.blockNumber !== a.blockNumber) return b.blockNumber - a.blockNumber;
    return b.logIndex - a.logIndex;
  });

  const entries = posts.map((post) => {
    const entry = {
      submissionId: post.submissionRef,
      submissionRef: post.submissionRef,
    };

    // Include threadIndexFeed if we have a thread feed for this post
    const threadFeedName = `thread-${post.submissionRef}`;
    const threadFeed = getFeed(threadFeedName);
    if (threadFeed) {
      entry.threadIndexFeed = hexToBzz(threadFeed);
    }

    return entry;
  });

  return buildBoardIndex({
    boardId: boardSlug,
    curator: config.curatorAddress,
    entries,
  });
}
