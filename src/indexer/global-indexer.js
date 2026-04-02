/**
 * Global indexer — builds globalIndex across all boards.
 */

import { buildGlobalIndex } from '../protocol/objects.js';
import { getSubmissionsForBoard, getBoards, getVotesForSubmission } from './state.js';
import config from '../config.js';

/**
 * Build a globalIndex with recent submissions from all boards.
 * @returns {Object} A valid globalIndex protocol object
 */
const byNewest = (a, b) => {
  if (b.blockNumber !== a.blockNumber) return b.blockNumber - a.blockNumber;
  return b.logIndex - a.logIndex;
};

const byBestThenNewest = (a, b) => {
  const scoreA = getVotesForSubmission(a.submissionRef)?.score ?? 0;
  const scoreB = getVotesForSubmission(b.submissionRef)?.score ?? 0;
  if (scoreB !== scoreA) return scoreB - scoreA;
  return byNewest(a, b);
};

function collectAllPosts() {
  const allPosts = [];
  for (const [slug] of getBoards()) {
    const posts = getSubmissionsForBoard(slug).filter((s) => s.kind === 'post');
    for (const post of posts) {
      allPosts.push({ ...post, boardId: slug });
    }
  }
  return allPosts;
}

function toGlobalEntries(posts) {
  return posts.map((post) => ({
    boardId: post.boardId,
    submissionId: post.submissionRef,
    submissionRef: post.submissionRef,
  }));
}

/**
 * Build a globalIndex (chronological, newest first).
 */
export function buildGlobalIndexFromState() {
  const allPosts = collectAllPosts();

  allPosts.sort(byNewest);

  return buildGlobalIndex({
    curator: config.curatorAddress,
    entries: toGlobalEntries(allPosts),
  });
}

/**
 * Build a "best" globalIndex (score descending, then newest first).
 */
export function buildBestGlobalIndex() {
  const allPosts = collectAllPosts();

  allPosts.sort(byBestThenNewest);

  return buildGlobalIndex({
    curator: config.curatorAddress,
    entries: toGlobalEntries(allPosts),
  });
}
