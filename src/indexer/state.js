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

  // Track which boards are in the current published curatorProfile
  publishedBoardSlugs: new Set(),
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
    state.feeds = new Map(Object.entries(data.feeds || {}));
    state.publishedBoardSlugs = new Set(data.publishedBoardSlugs || []);

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
    feeds: Object.fromEntries(state.feeds),
    publishedBoardSlugs: [...state.publishedBoardSlugs],
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
