/**
 * Global indexer — builds globalIndex across all boards in various sort orders.
 */

import { buildGlobalIndex } from '../protocol/objects.js';
import { getRootSubmissions, getAllBoards } from './state.js';
import { byNewest, rankByBest, rankByHot, rankByRising, rankByControversial } from './ranking.js';
import config from '../config.js';

/**
 * Fetch all posts across all boards. Callers should pass this to all
 * global builders to avoid redundant DB queries.
 */
export function collectAllPosts() {
  const allPosts = [];
  for (const { slug } of getAllBoards()) {
    for (const post of getRootSubmissions(slug)) {
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

function buildIndex(posts) {
  return buildGlobalIndex({
    curator: config.curatorAddress,
    entries: toGlobalEntries(posts),
  });
}

export function buildGlobalIndexFromState(posts) {
  posts = posts || collectAllPosts();
  return buildIndex([...posts].sort(byNewest));
}

export function buildBestGlobalIndex(posts) {
  posts = posts || collectAllPosts();
  return buildIndex(rankByBest(posts));
}

export function buildHotGlobalIndex(posts, nowMs = Date.now()) {
  posts = posts || collectAllPosts();
  return buildIndex(rankByHot(posts, nowMs));
}

export function buildRisingGlobalIndex(posts, nowMs = Date.now()) {
  posts = posts || collectAllPosts();
  return buildIndex(rankByRising(posts, nowMs));
}

export function buildControversialGlobalIndex(posts) {
  posts = posts || collectAllPosts();
  return buildIndex(rankByControversial(posts));
}
