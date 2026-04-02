/**
 * Global indexer — builds globalIndex across all boards.
 */

import { buildGlobalIndex } from '../protocol/objects.js';
import { getRootSubmissions, getBoards, getVotesForSubmission } from './state.js';
import config from '../config.js';

const byNewest = (a, b) => {
  if (b.blockNumber !== a.blockNumber) return b.blockNumber - a.blockNumber;
  return b.logIndex - a.logIndex;
};

function collectAllPosts() {
  const allPosts = [];
  for (const [slug] of getBoards()) {
    const posts = getRootSubmissions(slug);
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

  // Preload scores to avoid per-comparison DB queries
  const scores = new Map();
  for (const post of allPosts) {
    scores.set(post.submissionRef, getVotesForSubmission(post.submissionRef)?.score ?? 0);
  }

  allPosts.sort((a, b) => {
    const diff = scores.get(b.submissionRef) - scores.get(a.submissionRef);
    return diff !== 0 ? diff : byNewest(a, b);
  });

  return buildGlobalIndex({
    curator: config.curatorAddress,
    entries: toGlobalEntries(allPosts),
  });
}
