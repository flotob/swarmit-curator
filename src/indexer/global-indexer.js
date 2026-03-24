/**
 * Global indexer — builds globalIndex across all boards.
 */

import { buildGlobalIndex } from '../protocol/objects.js';
import { getSubmissionsForBoard, getBoards } from './state.js';
import config from '../config.js';

/**
 * Build a globalIndex with recent submissions from all boards.
 * @returns {Object} A valid globalIndex protocol object
 */
export function buildGlobalIndexFromState() {
  const allPosts = [];

  for (const [slug] of getBoards()) {
    const posts = getSubmissionsForBoard(slug).filter((s) => s.kind === 'post');
    for (const post of posts) {
      allPosts.push({ ...post, boardId: slug });
    }
  }

  // Sort by announcement order, newest first
  allPosts.sort((a, b) => {
    if (b.blockNumber !== a.blockNumber) return b.blockNumber - a.blockNumber;
    return b.logIndex - a.logIndex;
  });

  const entries = allPosts.map((post) => ({
    boardId: post.boardId,
    submissionId: post.submissionRef,
    submissionRef: post.submissionRef,
  }));

  return buildGlobalIndex({
    curator: config.curatorAddress,
    entries,
  });
}
