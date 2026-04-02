/**
 * Ranking module — centralized formulas with batch-preloaded data.
 * All functions accept a posts array and return a sorted (possibly filtered) array.
 * Uses batch DB queries — no per-post or per-comparison queries.
 */

import { getVotesBatch, getRecentDeltasBatch } from './state.js';

export const byNewest = (a, b) => {
  if (b.blockNumber !== a.blockNumber) return b.blockNumber - a.blockNumber;
  return b.logIndex - a.logIndex;
};

function batchLoadVotes(posts) {
  const refs = posts.map((p) => p.submissionRef);
  return getVotesBatch(refs);
}

/**
 * Best: score descending, tie-break newest first.
 */
export function rankByBest(posts) {
  const votes = batchLoadVotes(posts);

  return [...posts].sort((a, b) => {
    const diff = (votes.get(b.submissionRef)?.score ?? 0) - (votes.get(a.submissionRef)?.score ?? 0);
    return diff !== 0 ? diff : byNewest(a, b);
  });
}

/**
 * Hot: score with age decay. Includes all posts.
 * hotScore = score / pow(ageHours + 2, 1.5)
 */
export function rankByHot(posts, nowMs) {
  const votes = batchLoadVotes(posts);
  const hotScores = new Map();

  for (const post of posts) {
    const score = votes.get(post.submissionRef)?.score ?? 0;
    const ageHours = (nowMs - (post.announcedAtMs || 0)) / 3600000;
    hotScores.set(post.submissionRef, score / Math.pow(ageHours + 2, 1.5));
  }

  return [...posts].sort((a, b) => {
    const diff = hotScores.get(b.submissionRef) - hotScores.get(a.submissionRef);
    return diff !== 0 ? diff : byNewest(a, b);
  });
}

/**
 * Rising: recent vote momentum with age decay. Filters to qualifying posts.
 * risingScore = recentDelta24h / pow(ageHours + 2, 1.8)
 * Only posts with recentDelta24h > 0 and age <= 7 days.
 */
export function rankByRising(posts, nowMs) {
  const sinceMs = nowMs - 24 * 60 * 60 * 1000;
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  const refs = posts.map((p) => p.submissionRef);
  const deltas = getRecentDeltasBatch(refs, sinceMs);
  const votes = batchLoadVotes(posts);

  const qualifying = [];
  const risingScores = new Map();

  for (const post of posts) {
    const announcedAtMs = post.announcedAtMs || 0;
    const ageMs = nowMs - announcedAtMs;
    if (ageMs > maxAgeMs) continue;

    const delta = deltas.get(post.submissionRef) || 0;
    if (delta <= 0) continue;

    const ageHours = ageMs / 3600000;
    risingScores.set(post.submissionRef, delta / Math.pow(ageHours + 2, 1.8));
    qualifying.push(post);
  }

  return qualifying.sort((a, b) => {
    const diff = risingScores.get(b.submissionRef) - risingScores.get(a.submissionRef);
    if (diff !== 0) return diff;
    const scoreDiff = (votes.get(b.submissionRef)?.score ?? 0) - (votes.get(a.submissionRef)?.score ?? 0);
    return scoreDiff !== 0 ? scoreDiff : byNewest(a, b);
  });
}

/**
 * Controversial: strong disagreement. Filters to posts with two-sided voting.
 * controversyScore = (upvotes + downvotes) * balance
 * balance = min(up, down) / max(up, down)
 */
export function rankByControversial(posts) {
  const votes = batchLoadVotes(posts);
  const qualifying = [];
  const controversyScores = new Map();

  for (const post of posts) {
    const v = votes.get(post.submissionRef);
    if (!v || v.upvotes === 0 || v.downvotes === 0) continue;

    const balance = Math.min(v.upvotes, v.downvotes) / Math.max(v.upvotes, v.downvotes);
    controversyScores.set(post.submissionRef, (v.upvotes + v.downvotes) * balance);
    qualifying.push(post);
  }

  return qualifying.sort((a, b) => {
    const diff = controversyScores.get(b.submissionRef) - controversyScores.get(a.submissionRef);
    return diff !== 0 ? diff : byNewest(a, b);
  });
}
