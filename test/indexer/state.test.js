import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { VALID_BZZ, VALID_BZZ_2, VALID_BZZ_3 } from '../helpers/fixtures.js';

import {
  initDb, closeDb, resetDb,
  getLastProcessedBlock, setLastProcessedBlock,
  addBoard, getAllBoards, getBoards, getKnownBoardSlugs,
  addSubmission, hasSubmission, getSubmissions, getSubmissionsForBoard,
  getRootSubmissions, getRepliesForRoot,
  applyVoteEvent, getVotesForSubmission,
  getFeed, setFeed,
  getRetrySubmissions, setRetrySubmissions,
  getRepublishBoards, setRepublishBoards,
  getRepublishGlobal, setRepublishGlobal,
  getRepublishProfile, setRepublishProfile,
  getPublishedBoardSlugs, setPublishedBoardSlugs,
  loadState, saveState,
} from '../../src/indexer/state.js';

before(() => initDb(':memory:'));
after(() => closeDb());
beforeEach(() => resetDb());

// =============================================
// DB lifecycle
// =============================================

describe('DB lifecycle', () => {
  it('resetDb clears all data', () => {
    addBoard('test', { boardId: 'test' });
    addSubmission(VALID_BZZ, { boardId: 'test', kind: 'post', contentRef: VALID_BZZ_2, author: '0x1', blockNumber: 1, logIndex: 0 });
    setLastProcessedBlock(100);
    resetDb();
    assert.equal(getAllBoards().length, 0);
    assert.equal(hasSubmission(VALID_BZZ), false);
    assert.equal(getLastProcessedBlock(), null);
  });

  it('loadState is a no-op stub', async () => {
    const result = await loadState();
    assert.equal(result, false);
  });

  it('saveState is a no-op stub', async () => {
    await saveState(); // should not throw
  });
});

// =============================================
// Meta (lastProcessedBlock, republish flags)
// =============================================

describe('meta state', () => {
  it('lastProcessedBlock returns null when not set', () => {
    assert.equal(getLastProcessedBlock(), null);
  });

  it('lastProcessedBlock round-trip', () => {
    setLastProcessedBlock(42);
    assert.equal(getLastProcessedBlock(), 42);
  });

  it('republishGlobal round-trip', () => {
    assert.equal(getRepublishGlobal(), false);
    setRepublishGlobal(true);
    assert.equal(getRepublishGlobal(), true);
  });

  it('republishProfile round-trip', () => {
    assert.equal(getRepublishProfile(), false);
    setRepublishProfile(true);
    assert.equal(getRepublishProfile(), true);
  });
});

// =============================================
// Boards (facade shims)
// =============================================

describe('boards facade', () => {
  it('addBoard + getAllBoards', () => {
    addBoard('general', { boardId: '0xabc', boardRef: 'ref', governance: { type: 'open' } });
    const boards = getAllBoards();
    assert.equal(boards.length, 1);
    assert.equal(boards[0].slug, 'general');
    assert.equal(boards[0].boardId, '0xabc');
  });

  it('getBoards returns Map for backward compat', () => {
    addBoard('tech', { boardId: '0x123' });
    const map = getBoards();
    assert.ok(map instanceof Map);
    assert.ok(map.has('tech'));
    const [slug, board] = [...map.entries()][0];
    assert.equal(slug, 'tech');
    assert.equal(board.boardId, '0x123');
  });

  it('getKnownBoardSlugs returns Set', () => {
    addBoard('a', { boardId: '1' });
    addBoard('b', { boardId: '2' });
    const slugs = getKnownBoardSlugs();
    assert.ok(slugs instanceof Set);
    assert.ok(slugs.has('a'));
    assert.ok(slugs.has('b'));
  });
});

// =============================================
// Submissions (facade shims)
// =============================================

describe('submissions facade', () => {
  it('addSubmission + hasSubmission', () => {
    addSubmission(VALID_BZZ, { boardId: 'test', kind: 'post', contentRef: VALID_BZZ_2, author: '0x1', blockNumber: 1, logIndex: 0 });
    assert.equal(hasSubmission(VALID_BZZ), true);
    assert.equal(hasSubmission(VALID_BZZ_2), false);
  });

  it('getSubmissions().has() backward compat', () => {
    addSubmission(VALID_BZZ, { boardId: 'test', kind: 'post', contentRef: VALID_BZZ_2, author: '0x1', blockNumber: 1, logIndex: 0 });
    assert.equal(getSubmissions().has(VALID_BZZ), true);
    assert.equal(getSubmissions().has(VALID_BZZ_2), false);
  });

  it('getSubmissionsForBoard filters correctly', () => {
    addSubmission(VALID_BZZ, { boardId: 'board-x', kind: 'post', contentRef: VALID_BZZ_2, author: '0x1', blockNumber: 1, logIndex: 0 });
    addSubmission(VALID_BZZ_2, { boardId: 'board-y', kind: 'post', contentRef: VALID_BZZ, author: '0x1', blockNumber: 2, logIndex: 0 });
    const results = getSubmissionsForBoard('board-x');
    assert.equal(results.length, 1);
    assert.equal(results[0].boardId, 'board-x');
  });

  it('getRootSubmissions excludes replies', () => {
    addSubmission(VALID_BZZ, { boardId: 'board-z', kind: 'post', contentRef: VALID_BZZ_2, author: '0x1', blockNumber: 1, logIndex: 0 });
    addSubmission(VALID_BZZ_2, { boardId: 'board-z', kind: 'reply', contentRef: VALID_BZZ, rootSubmissionId: VALID_BZZ, author: '0x1', blockNumber: 2, logIndex: 0 });
    const roots = getRootSubmissions('board-z');
    assert.equal(roots.length, 1);
    assert.equal(roots[0].kind, 'post');
  });

  it('getRepliesForRoot finds all replies', () => {
    addSubmission(VALID_BZZ, { boardId: 'board-w', kind: 'post', contentRef: VALID_BZZ_2, author: '0x1', blockNumber: 1, logIndex: 0 });
    addSubmission(VALID_BZZ_2, { boardId: 'board-w', kind: 'reply', contentRef: VALID_BZZ, rootSubmissionId: VALID_BZZ, author: '0x1', blockNumber: 2, logIndex: 0 });
    addSubmission(VALID_BZZ_3, { boardId: 'board-w', kind: 'reply', contentRef: VALID_BZZ, rootSubmissionId: VALID_BZZ, author: '0x1', blockNumber: 3, logIndex: 0 });
    const replies = getRepliesForRoot(VALID_BZZ);
    assert.equal(replies.length, 2);
  });
});

// =============================================
// Votes
// =============================================

describe('applyVoteEvent', () => {
  it('stores vote totals', () => {
    applyVoteEvent({ submissionRef: VALID_BZZ, upvotes: 3, downvotes: 1, blockNumber: 100, logIndex: 0 });
    const v = getVotesForSubmission(VALID_BZZ);
    assert.equal(v.upvotes, 3);
    assert.equal(v.downvotes, 1);
    assert.equal(v.score, 2);
    assert.equal(v.updatedAtBlock, 100);
  });

  it('updates with newer event', () => {
    applyVoteEvent({ submissionRef: VALID_BZZ, upvotes: 3, downvotes: 1, blockNumber: 100, logIndex: 0 });
    applyVoteEvent({ submissionRef: VALID_BZZ, upvotes: 4, downvotes: 1, blockNumber: 101, logIndex: 0 });
    assert.equal(getVotesForSubmission(VALID_BZZ).upvotes, 4);
  });

  it('ignores stale event (older block)', () => {
    applyVoteEvent({ submissionRef: VALID_BZZ, upvotes: 5, downvotes: 2, blockNumber: 200, logIndex: 0 });
    applyVoteEvent({ submissionRef: VALID_BZZ, upvotes: 1, downvotes: 0, blockNumber: 100, logIndex: 0 });
    assert.equal(getVotesForSubmission(VALID_BZZ).upvotes, 5);
  });

  it('ignores stale event (same block, older logIndex)', () => {
    applyVoteEvent({ submissionRef: VALID_BZZ, upvotes: 5, downvotes: 2, blockNumber: 200, logIndex: 5 });
    applyVoteEvent({ submissionRef: VALID_BZZ, upvotes: 1, downvotes: 0, blockNumber: 200, logIndex: 3 });
    assert.equal(getVotesForSubmission(VALID_BZZ).upvotes, 5);
  });

  it('ignores duplicate event', () => {
    applyVoteEvent({ submissionRef: VALID_BZZ, upvotes: 5, downvotes: 2, blockNumber: 200, logIndex: 5 });
    applyVoteEvent({ submissionRef: VALID_BZZ, upvotes: 99, downvotes: 99, blockNumber: 200, logIndex: 5 });
    assert.equal(getVotesForSubmission(VALID_BZZ).upvotes, 5);
  });

  it('returns null for unknown submission', () => {
    assert.equal(getVotesForSubmission(VALID_BZZ_2), null);
  });
});

// =============================================
// Feeds
// =============================================

describe('feeds', () => {
  it('get/set round-trip', () => {
    setFeed('global', 'ab'.repeat(32));
    assert.equal(getFeed('global'), 'ab'.repeat(32));
  });

  it('returns null for unknown', () => {
    assert.equal(getFeed('nope'), null);
  });
});

// =============================================
// Retry submissions
// =============================================

describe('retry submissions', () => {
  it('set + get round-trip', () => {
    setRetrySubmissions([{ submissionRef: VALID_BZZ, author: '0x1', blockNumber: 10, logIndex: 0 }]);
    assert.equal(getRetrySubmissions().length, 1);
    assert.equal(getRetrySubmissions()[0].submissionRef, VALID_BZZ);
  });

  it('replaces on set', () => {
    setRetrySubmissions([{ submissionRef: VALID_BZZ, author: '0x1', blockNumber: 10, logIndex: 0 }]);
    setRetrySubmissions([{ submissionRef: VALID_BZZ_2, author: '0x2', blockNumber: 11, logIndex: 0 }]);
    assert.equal(getRetrySubmissions().length, 1);
    assert.equal(getRetrySubmissions()[0].submissionRef, VALID_BZZ_2);
  });
});

// =============================================
// Republish boards
// =============================================

describe('republish boards', () => {
  it('get/set round-trip', () => {
    setRepublishBoards(new Set(['a', 'b']));
    const boards = getRepublishBoards();
    assert.ok(boards.has('a'));
    assert.ok(boards.has('b'));
    assert.equal(boards.size, 2);
  });
});

// =============================================
// Published board slugs (backward compat)
// =============================================

describe('published board slugs', () => {
  it('set + get round-trip', () => {
    setPublishedBoardSlugs(['board:tech', 'view:best:global']);
    const keys = getPublishedBoardSlugs();
    assert.ok(keys.has('board:tech'));
    assert.ok(keys.has('view:best:global'));
  });
});
