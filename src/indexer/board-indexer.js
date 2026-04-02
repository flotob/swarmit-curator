/**
 * Board indexer — builds boardIndex per board, sorted by announcement order (newest first).
 */

import { buildBoardIndex } from '../protocol/objects.js';
import { hexToBzz } from '../protocol/references.js';
import { getRootSubmissions, getFeed, getVotesForSubmission } from './state.js';
import config from '../config.js';

const byNewest = (a, b) => {
  if (b.blockNumber !== a.blockNumber) return b.blockNumber - a.blockNumber;
  return b.logIndex - a.logIndex;
};

function buildEntry(post) {
  const entry = {
    submissionId: post.submissionRef,
    submissionRef: post.submissionRef,
  };
  const threadFeedName = `thread-${post.submissionRef}`;
  const threadFeed = getFeed(threadFeedName);
  if (threadFeed) {
    entry.threadIndexFeed = hexToBzz(threadFeed);
  }
  return entry;
}

/**
 * Build a boardIndex for a board (chronological, newest first).
 */
export function buildBoardIndexForBoard(boardSlug) {
  const posts = getRootSubmissions(boardSlug);

  posts.sort(byNewest);

  return buildBoardIndex({
    boardId: boardSlug,
    curator: config.curatorAddress,
    entries: posts.map(buildEntry),
  });
}

/**
 * Build a "best" boardIndex for a board (score descending, then newest first).
 */
export function buildBestBoardIndex(boardSlug) {
  const posts = getRootSubmissions(boardSlug);

  // Preload scores to avoid per-comparison DB queries
  const scores = new Map();
  for (const post of posts) {
    scores.set(post.submissionRef, getVotesForSubmission(post.submissionRef)?.score ?? 0);
  }

  posts.sort((a, b) => {
    const diff = scores.get(b.submissionRef) - scores.get(a.submissionRef);
    return diff !== 0 ? diff : byNewest(a, b);
  });

  return buildBoardIndex({
    boardId: boardSlug,
    curator: config.curatorAddress,
    entries: posts.map(buildEntry),
  });
}
