/**
 * State facade — delegates to SQLite repos.
 * Chain + Swarm are the source of truth; SQLite is the rebuildable local cache.
 */

export { initDb, closeDb, resetDb, inTransaction } from '../db/sqlite.js';

export {
  getMeta, setMeta,
  getLastProcessedBlock, setLastProcessedBlock,
  getRepublishGlobal, setRepublishGlobal,
  getRepublishProfile, setRepublishProfile,
} from '../db/repos/meta.js';

export { addBoard, getAllBoards, getKnownBoardSlugs } from '../db/repos/boards.js';
export { updateBoardRef as updateBoardMetadata } from '../db/repos/boards.js';

export { addSubmission, hasSubmission, getSubmissionsForBoard, getRootSubmissions, getRepliesForRoot } from '../db/repos/submissions.js';

export { applyVoteEvent, getVotesForSubmission, getVotesBatch } from '../db/repos/votes.js';


export { insertVoteEvent, getRecentDelta, getRecentDeltasBatch } from '../db/repos/vote-events.js';

export { getFeed, setFeed } from '../db/repos/feeds.js';

export { getPublishedKeys, setPublishedKeys, hasPublishedKey } from '../db/repos/published.js';

export { getRetrySubmissions, setRetrySubmissions } from '../db/repos/retries.js';

export { getRepublishBoards, setRepublishBoards, addRepublishBoard } from '../db/repos/republish-boards.js';
