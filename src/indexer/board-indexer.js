/**
 * Board indexer — builds boardIndex per board in various sort orders.
 */

import { buildBoardIndex } from '../protocol/objects.js';
import { hexToBzz } from '../protocol/references.js';
import { getRootSubmissions, getFeed } from './state.js';
import { byNewest, rankByBest, rankByHot, rankByRising, rankByControversial } from './ranking.js';
import config from '../config.js';

function buildEntry(post) {
  const entry = {
    submissionId: post.submissionRef,
    submissionRef: post.submissionRef,
  };
  const threadFeed = getFeed(`thread-${post.submissionRef}`);
  if (threadFeed) entry.threadIndexFeed = hexToBzz(threadFeed);
  return entry;
}

function buildIndex(boardSlug, posts) {
  return buildBoardIndex({
    boardId: boardSlug,
    curator: config.curatorAddress,
    entries: posts.map(buildEntry),
  });
}

/**
 * Fetch posts once for a board. Callers should pass this to all builders
 * to avoid redundant DB queries.
 */
export function getPostsForBoard(boardSlug) {
  return getRootSubmissions(boardSlug);
}

export function buildBoardIndexForBoard(boardSlug, posts) {
  posts = posts || getPostsForBoard(boardSlug);
  return buildIndex(boardSlug, [...posts].sort(byNewest));
}

export function buildBestBoardIndex(boardSlug, posts) {
  posts = posts || getPostsForBoard(boardSlug);
  return buildIndex(boardSlug, rankByBest(posts));
}

export function buildHotBoardIndex(boardSlug, posts, nowMs = Date.now()) {
  posts = posts || getPostsForBoard(boardSlug);
  return buildIndex(boardSlug, rankByHot(posts, nowMs));
}

export function buildRisingBoardIndex(boardSlug, posts, nowMs = Date.now()) {
  posts = posts || getPostsForBoard(boardSlug);
  return buildIndex(boardSlug, rankByRising(posts, nowMs));
}

export function buildControversialBoardIndex(boardSlug, posts) {
  posts = posts || getPostsForBoard(boardSlug);
  return buildIndex(boardSlug, rankByControversial(posts));
}
