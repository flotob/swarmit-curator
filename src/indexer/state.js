/**
 * Persistent state manager — rebuildable cache backed by JSON file.
 * Chain + Swarm are the source of truth; this is an optimization to avoid re-scanning.
 * Writes are atomic (write to temp file, then rename).
 */

import { readFile, writeFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import config from '../config.js';

/**
 * @typedef {Object} SubmissionEntry
 * @property {string} submissionRef - bzz:// ref
 * @property {string} boardId - board slug
 * @property {string} kind - 'post' or 'reply'
 * @property {string} contentRef - bzz:// ref to post/reply content
 * @property {string|null} parentSubmissionId - null for top-level posts
 * @property {string|null} rootSubmissionId - self for top-level posts
 * @property {string} author - Ethereum address
 * @property {number} blockNumber
 * @property {number} logIndex
 */

const state = {
  lastProcessedBlock: config.contractDeployBlock - 1,

  // board slug → { boardId, slug, boardRef, governance }
  boards: new Map(),

  // submissionRef (bzz://) → SubmissionEntry
  submissions: new Map(),

  // Feed manifest references (stable URLs)
  // feedName → manifest hex
  feeds: new Map(),

  // submissionRef (bzz://) → { upvotes, downvotes, score, updatedAtBlock, updatedAtLogIndex }
  votes: new Map(),

  // Track which boards are in the current published curatorProfile
  publishedBoardSlugs: new Set(),

  // Retry queues — persisted so restarts don't lose pending work
  retrySubmissions: [],       // { submissionRef, author, blockNumber, logIndex }
  republishBoards: new Set(), // board slugs needing feed republish
  republishGlobal: false,
  republishProfile: false,
};

/**
 * Load state from the JSON file. Returns false if no file exists.
 */
export async function loadState() {
  if (!existsSync(config.stateFile)) return false;

  try {
    const raw = await readFile(config.stateFile, 'utf-8');
    const data = JSON.parse(raw);

    state.lastProcessedBlock = data.lastProcessedBlock ?? state.lastProcessedBlock;
    state.boards = new Map(Object.entries(data.boards || {}));
    state.submissions = new Map(Object.entries(data.submissions || {}));
    state.votes = new Map(Object.entries(data.votes || {}));
    state.feeds = new Map(Object.entries(data.feeds || {}));
    state.publishedBoardSlugs = new Set(data.publishedBoardSlugs || []);
    state.retrySubmissions = data.retrySubmissions || [];
    state.republishBoards = new Set(data.republishBoards || []);
    state.republishGlobal = data.republishGlobal || false;
    state.republishProfile = data.republishProfile || false;

    return true;
  } catch (err) {
    console.warn(`[State] Failed to load ${config.stateFile}: ${err.message}. Starting fresh.`);
    return false;
  }
}

/**
 * Save state to the JSON file. Atomic write via temp file + rename.
 */
export async function saveState() {
  const data = {
    lastProcessedBlock: state.lastProcessedBlock,
    boards: Object.fromEntries(state.boards),
    submissions: Object.fromEntries(state.submissions),
    votes: Object.fromEntries(state.votes),
    feeds: Object.fromEntries(state.feeds),
    publishedBoardSlugs: [...state.publishedBoardSlugs],
    retrySubmissions: state.retrySubmissions,
    republishBoards: [...state.republishBoards],
    republishGlobal: state.republishGlobal,
    republishProfile: state.republishProfile,
  };

  const tmp = config.stateFile + '.tmp';
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, config.stateFile);
}

// Accessors

export function getLastProcessedBlock() {
  return state.lastProcessedBlock;
}

export function setLastProcessedBlock(block) {
  state.lastProcessedBlock = block;
}

export function getBoards() {
  return state.boards;
}

export function addBoard(slug, boardData) {
  state.boards.set(slug, boardData);
}

export function getKnownBoardSlugs() {
  return new Set(state.boards.keys());
}

export function getSubmissions() {
  return state.submissions;
}

export function addSubmission(submissionRef, entry) {
  state.submissions.set(submissionRef, entry);
}

export function getSubmissionsForBoard(boardSlug) {
  const results = [];
  for (const [ref, sub] of state.submissions) {
    if (sub.boardId === boardSlug) results.push({ ...sub, submissionRef: ref });
  }
  return results;
}

export function getRootSubmissions(boardSlug) {
  return getSubmissionsForBoard(boardSlug).filter((s) => s.kind === 'post');
}

export function getRepliesForRoot(rootSubmissionRef) {
  const results = [];
  for (const [ref, sub] of state.submissions) {
    if (sub.rootSubmissionId === rootSubmissionRef && sub.kind === 'reply') {
      results.push({ ...sub, submissionRef: ref });
    }
  }
  return results;
}

export function getVotes() {
  return state.votes;
}

export function getVotesForSubmission(submissionRef) {
  return state.votes.get(submissionRef) || null;
}

/**
 * Apply a decoded VoteSet event to vote state.
 * Ignores stale events (older block/logIndex than current state).
 */
export function applyVoteEvent(voteEvent) {
  const submissionRef = voteEvent.submissionRef;
  const existing = state.votes.get(submissionRef);

  if (existing) {
    const existingOrder = existing.updatedAtBlock * 1e6 + existing.updatedAtLogIndex;
    const eventOrder = voteEvent.blockNumber * 1e6 + voteEvent.logIndex;
    if (eventOrder <= existingOrder) return;
  }

  state.votes.set(submissionRef, {
    upvotes: voteEvent.upvotes,
    downvotes: voteEvent.downvotes,
    score: voteEvent.upvotes - voteEvent.downvotes,
    updatedAtBlock: voteEvent.blockNumber,
    updatedAtLogIndex: voteEvent.logIndex,
  });
}

export function getFeed(feedName) {
  return state.feeds.get(feedName) || null;
}

export function setFeed(feedName, manifestRef) {
  state.feeds.set(feedName, manifestRef);
}

export function getPublishedBoardSlugs() {
  return state.publishedBoardSlugs;
}

export function setPublishedBoardSlugs(slugs) {
  state.publishedBoardSlugs = new Set(slugs);
}

// Retry state accessors

export function getRetrySubmissions() { return state.retrySubmissions; }
export function setRetrySubmissions(subs) { state.retrySubmissions = subs; }

export function getRepublishBoards() { return state.republishBoards; }
export function setRepublishBoards(set) { state.republishBoards = set; }

export function getRepublishGlobal() { return state.republishGlobal; }
export function setRepublishGlobal(val) { state.republishGlobal = val; }

export function getRepublishProfile() { return state.republishProfile; }
export function setRepublishProfile(val) { state.republishProfile = val; }
