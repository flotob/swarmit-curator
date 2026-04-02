/**
 * State facade — delegates to SQLite repos.
 * Maintains the same export names as the original Map/Set-based state.js
 * for backward compatibility during migration. Callers are updated in WP4.
 *
 * Chain + Swarm are the source of truth; SQLite is the rebuildable local cache.
 */

// Re-export DB lifecycle
export { initDb, closeDb, resetDb, inTransaction } from '../db/sqlite.js';

// --- Meta ---
export {
  getLastProcessedBlock, setLastProcessedBlock,
  getRepublishGlobal, setRepublishGlobal,
  getRepublishProfile, setRepublishProfile,
} from '../db/repos/meta.js';

// --- Boards ---
export { addBoard, getAllBoards, getKnownBoardSlugs } from '../db/repos/boards.js';
export { updateBoardRef as updateBoardMetadata } from '../db/repos/boards.js';

import { getAllBoards as _getAllBoards } from '../db/repos/boards.js';

/**
 * @deprecated Callers should use getAllBoards() which returns an array.
 * This shim returns a Map for backward compat with `for (const [slug, board] of getBoards())`.
 */
export function getBoards() {
  return new Map(_getAllBoards().map((b) => [b.slug, b]));
}

// --- Submissions ---
export { addSubmission, hasSubmission, getSubmissionsForBoard, getRootSubmissions, getRepliesForRoot } from '../db/repos/submissions.js';

import { hasSubmission as _hasSubmission } from '../db/repos/submissions.js';

/**
 * @deprecated Use hasSubmission(ref) instead.
 * Shim for backward compat with `getSubmissions().has(ref)`.
 */
export function getSubmissions() {
  return { has: (ref) => _hasSubmission(ref) };
}

// --- Votes ---
export { applyVoteEvent, getVotesForSubmission } from '../db/repos/votes.js';

// --- Feeds ---
export { getFeed, setFeed } from '../db/repos/feeds.js';

// --- Published profile keys ---
export { getPublishedKeys, setPublishedKeys, hasPublishedKey } from '../db/repos/published.js';

import { getPublishedKeys as _getPublishedKeys, setPublishedKeys as _setPublishedKeys } from '../db/repos/published.js';

/**
 * @deprecated Use getPublishedKeys() / hasPublishedKey() instead.
 */
export function getPublishedBoardSlugs() {
  return _getPublishedKeys();
}

/**
 * @deprecated Use setPublishedKeys() instead.
 */
export function setPublishedBoardSlugs(keys) {
  _setPublishedKeys(Array.isArray(keys) ? keys : [...keys]);
}

// --- Retry submissions ---
export { getRetrySubmissions, setRetrySubmissions } from '../db/repos/retries.js';

// --- Republish boards ---
export { getRepublishBoards, setRepublishBoards, addRepublishBoard } from '../db/repos/republish-boards.js';

// --- Stubs for removed functions ---

/**
 * @deprecated DB is initialized via initDb(). This is a no-op stub.
 */
export async function loadState() {
  return false;
}

/**
 * @deprecated Writes are immediate with SQLite. This is a no-op stub.
 */
export async function saveState() {
  // no-op — writes go directly to SQLite
}
