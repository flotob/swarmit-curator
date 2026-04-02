import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, resetDb } from '../../src/db/sqlite.js';

// Repos
import { getMeta, setMeta, getLastProcessedBlock, setLastProcessedBlock, getRepublishGlobal, setRepublishGlobal, getRepublishProfile, setRepublishProfile } from '../../src/db/repos/meta.js';
import { addBoard, getBoard, getAllBoards, getKnownBoardSlugs, hasBoard, updateBoardRef } from '../../src/db/repos/boards.js';
import { addSubmission, hasSubmission, getSubmissionsForBoard, getRootSubmissions, getRepliesForRoot } from '../../src/db/repos/submissions.js';
import { applyVoteEvent, getVotesForSubmission } from '../../src/db/repos/votes.js';
import { getFeed, setFeed } from '../../src/db/repos/feeds.js';
import { getPublishedKeys, setPublishedKeys, hasPublishedKey } from '../../src/db/repos/published.js';
import { getRetrySubmissions, setRetrySubmissions, addRetry, clearRetries } from '../../src/db/repos/retries.js';
import { getRepublishBoards, setRepublishBoards, addRepublishBoard } from '../../src/db/repos/republish-boards.js';

before(() => initDb(':memory:'));
after(() => closeDb());
beforeEach(() => resetDb());

// =============================================
// Meta
// =============================================

describe('meta repo', () => {
  it('get/set round-trip', () => {
    setMeta('foo', 'bar');
    assert.equal(getMeta('foo'), 'bar');
  });

  it('returns fallback for missing key', () => {
    assert.equal(getMeta('missing', 'default'), 'default');
  });

  it('lastProcessedBlock returns null when not set', () => {
    assert.equal(getLastProcessedBlock(), null);
  });

  it('lastProcessedBlock round-trip', () => {
    setLastProcessedBlock(500);
    assert.equal(getLastProcessedBlock(), 500);
  });

  it('republishGlobal defaults to false', () => {
    assert.equal(getRepublishGlobal(), false);
  });

  it('republishGlobal round-trip', () => {
    setRepublishGlobal(true);
    assert.equal(getRepublishGlobal(), true);
    setRepublishGlobal(false);
    assert.equal(getRepublishGlobal(), false);
  });

  it('republishProfile round-trip', () => {
    setRepublishProfile(true);
    assert.equal(getRepublishProfile(), true);
  });
});

// =============================================
// Boards
// =============================================

describe('boards repo', () => {
  it('addBoard + getBoard round-trip', () => {
    addBoard('tech', { boardId: '0xabc', boardRef: 'bzz://ref', governance: { type: 'open' } });
    const b = getBoard('tech');
    assert.equal(b.slug, 'tech');
    assert.equal(b.boardId, '0xabc');
    assert.equal(b.boardRef, 'bzz://ref');
    assert.deepEqual(b.governance, { type: 'open' });
  });

  it('getBoard returns null for unknown', () => {
    assert.equal(getBoard('nope'), null);
  });

  it('getAllBoards returns array', () => {
    addBoard('a', { boardId: '1' });
    addBoard('b', { boardId: '2' });
    const all = getAllBoards();
    assert.equal(all.length, 2);
    assert.equal(all[0].slug, 'a');
  });

  it('getKnownBoardSlugs returns Set', () => {
    addBoard('x', { boardId: '1' });
    addBoard('y', { boardId: '2' });
    const slugs = getKnownBoardSlugs();
    assert.ok(slugs instanceof Set);
    assert.ok(slugs.has('x'));
    assert.ok(slugs.has('y'));
  });

  it('hasBoard', () => {
    assert.equal(hasBoard('z'), false);
    addBoard('z', { boardId: '1' });
    assert.equal(hasBoard('z'), true);
  });

  it('updateBoardRef', () => {
    addBoard('tech', { boardId: '0xabc', boardRef: 'old' });
    updateBoardRef('0xabc', 'new-ref');
    assert.equal(getBoard('tech').boardRef, 'new-ref');
  });

  it('addBoard upserts on conflict', () => {
    addBoard('tech', { boardId: '0xabc', boardRef: 'v1' });
    addBoard('tech', { boardId: '0xabc', boardRef: 'v2' });
    assert.equal(getAllBoards().length, 1);
    assert.equal(getBoard('tech').boardRef, 'v2');
  });
});

// =============================================
// Submissions
// =============================================

const SUB_A = {
  boardId: 'general', kind: 'post', contentRef: 'bzz://content',
  parentSubmissionId: null, rootSubmissionId: 'bzz://self',
  author: '0xaddr', blockNumber: 100, logIndex: 0,
};
const SUB_B = {
  boardId: 'general', kind: 'reply', contentRef: 'bzz://content2',
  parentSubmissionId: 'bzz://self', rootSubmissionId: 'bzz://self',
  author: '0xaddr', blockNumber: 101, logIndex: 0,
};

describe('submissions repo', () => {
  it('addSubmission + hasSubmission', () => {
    assert.equal(hasSubmission('bzz://self'), false);
    addSubmission('bzz://self', SUB_A);
    assert.equal(hasSubmission('bzz://self'), true);
  });

  it('addSubmission is idempotent (INSERT OR IGNORE)', () => {
    addSubmission('bzz://self', SUB_A);
    addSubmission('bzz://self', { ...SUB_A, author: '0xdifferent' });
    // Original author preserved
    const subs = getSubmissionsForBoard('general');
    assert.equal(subs[0].author, '0xaddr');
  });

  it('getSubmissionsForBoard returns all for that board', () => {
    addSubmission('bzz://a', { ...SUB_A, blockNumber: 100 });
    addSubmission('bzz://b', { ...SUB_B, blockNumber: 101 });
    addSubmission('bzz://c', { ...SUB_A, boardId: 'other', blockNumber: 102 });

    const subs = getSubmissionsForBoard('general');
    assert.equal(subs.length, 2);
    assert.ok(subs.every(s => s.boardId === 'general'));
  });

  it('getSubmissionsForBoard ordered newest first', () => {
    addSubmission('bzz://old', { ...SUB_A, blockNumber: 100, logIndex: 0 });
    addSubmission('bzz://new', { ...SUB_A, blockNumber: 200, logIndex: 0 });

    const subs = getSubmissionsForBoard('general');
    assert.equal(subs[0].blockNumber, 200);
    assert.equal(subs[1].blockNumber, 100);
  });

  it('getRootSubmissions returns only posts', () => {
    addSubmission('bzz://post', SUB_A);
    addSubmission('bzz://reply', SUB_B);

    const roots = getRootSubmissions('general');
    assert.equal(roots.length, 1);
    assert.equal(roots[0].kind, 'post');
  });

  it('getRepliesForRoot returns replies ordered oldest first', () => {
    addSubmission('bzz://root', SUB_A);
    addSubmission('bzz://r1', { ...SUB_B, blockNumber: 110 });
    addSubmission('bzz://r2', { ...SUB_B, blockNumber: 105 });

    const replies = getRepliesForRoot('bzz://self');
    assert.equal(replies.length, 2);
    assert.equal(replies[0].blockNumber, 105); // oldest first
    assert.equal(replies[1].blockNumber, 110);
  });

  it('rowToEntry maps all fields correctly', () => {
    addSubmission('bzz://test', SUB_A);
    const [entry] = getSubmissionsForBoard('general');
    assert.equal(entry.submissionRef, 'bzz://test');
    assert.equal(entry.boardId, 'general');
    assert.equal(entry.kind, 'post');
    assert.equal(entry.contentRef, 'bzz://content');
    assert.equal(entry.parentSubmissionId, null);
    assert.equal(entry.rootSubmissionId, 'bzz://self');
    assert.equal(entry.author, '0xaddr');
    assert.equal(entry.blockNumber, 100);
    assert.equal(entry.logIndex, 0);
  });
});

// =============================================
// Votes (SQL stale-event guard)
// =============================================

describe('votes repo', () => {
  it('insert new vote', () => {
    const changed = applyVoteEvent({ submissionRef: 'bzz://a', upvotes: 3, downvotes: 1, blockNumber: 100, logIndex: 0 });
    assert.equal(changed, true);
    const v = getVotesForSubmission('bzz://a');
    assert.equal(v.upvotes, 3);
    assert.equal(v.downvotes, 1);
    assert.equal(v.score, 2);
    assert.equal(v.updatedAtBlock, 100);
  });

  it('update with newer event', () => {
    applyVoteEvent({ submissionRef: 'bzz://a', upvotes: 3, downvotes: 1, blockNumber: 100, logIndex: 0 });
    const changed = applyVoteEvent({ submissionRef: 'bzz://a', upvotes: 5, downvotes: 2, blockNumber: 101, logIndex: 0 });
    assert.equal(changed, true);
    assert.equal(getVotesForSubmission('bzz://a').upvotes, 5);
  });

  it('ignores stale event (older block)', () => {
    applyVoteEvent({ submissionRef: 'bzz://a', upvotes: 5, downvotes: 2, blockNumber: 200, logIndex: 0 });
    const changed = applyVoteEvent({ submissionRef: 'bzz://a', upvotes: 1, downvotes: 0, blockNumber: 100, logIndex: 0 });
    assert.equal(changed, false);
    assert.equal(getVotesForSubmission('bzz://a').upvotes, 5);
  });

  it('ignores stale event (same block, older logIndex)', () => {
    applyVoteEvent({ submissionRef: 'bzz://a', upvotes: 5, downvotes: 2, blockNumber: 200, logIndex: 5 });
    const changed = applyVoteEvent({ submissionRef: 'bzz://a', upvotes: 1, downvotes: 0, blockNumber: 200, logIndex: 3 });
    assert.equal(changed, false);
    assert.equal(getVotesForSubmission('bzz://a').upvotes, 5);
  });

  it('ignores duplicate event (same block and logIndex)', () => {
    applyVoteEvent({ submissionRef: 'bzz://a', upvotes: 5, downvotes: 2, blockNumber: 200, logIndex: 5 });
    const changed = applyVoteEvent({ submissionRef: 'bzz://a', upvotes: 99, downvotes: 99, blockNumber: 200, logIndex: 5 });
    assert.equal(changed, false);
    assert.equal(getVotesForSubmission('bzz://a').upvotes, 5);
  });

  it('returns null for unknown submission', () => {
    assert.equal(getVotesForSubmission('bzz://unknown'), null);
  });
});

// =============================================
// Feeds
// =============================================

describe('feeds repo', () => {
  it('get/set round-trip', () => {
    setFeed('global', 'abc123');
    assert.equal(getFeed('global'), 'abc123');
  });

  it('returns null for unknown feed', () => {
    assert.equal(getFeed('nope'), null);
  });

  it('upserts on conflict', () => {
    setFeed('global', 'v1');
    setFeed('global', 'v2');
    assert.equal(getFeed('global'), 'v2');
  });
});

// =============================================
// Published profile keys
// =============================================

describe('published repo', () => {
  it('setPublishedKeys + getPublishedKeys', () => {
    setPublishedKeys(['board:tech', 'view:best:global']);
    const keys = getPublishedKeys();
    assert.ok(keys.has('board:tech'));
    assert.ok(keys.has('view:best:global'));
    assert.equal(keys.size, 2);
  });

  it('setPublishedKeys replaces all', () => {
    setPublishedKeys(['board:a']);
    setPublishedKeys(['board:b']);
    const keys = getPublishedKeys();
    assert.ok(!keys.has('board:a'));
    assert.ok(keys.has('board:b'));
  });

  it('hasPublishedKey', () => {
    setPublishedKeys(['board:tech']);
    assert.equal(hasPublishedKey('board:tech'), true);
    assert.equal(hasPublishedKey('board:other'), false);
  });
});

// =============================================
// Retry submissions
// =============================================

describe('retries repo', () => {
  const retry1 = { submissionRef: 'bzz://a', author: '0x1', blockNumber: 100, logIndex: 0 };
  const retry2 = { submissionRef: 'bzz://b', author: '0x2', blockNumber: 101, logIndex: 1 };

  it('setRetrySubmissions + getRetrySubmissions', () => {
    setRetrySubmissions([retry1, retry2]);
    const retries = getRetrySubmissions();
    assert.equal(retries.length, 2);
    assert.equal(retries[0].submissionRef, 'bzz://a');
    assert.equal(retries[1].submissionRef, 'bzz://b');
  });

  it('setRetrySubmissions replaces all', () => {
    setRetrySubmissions([retry1]);
    setRetrySubmissions([retry2]);
    const retries = getRetrySubmissions();
    assert.equal(retries.length, 1);
    assert.equal(retries[0].submissionRef, 'bzz://b');
  });

  it('addRetry appends', () => {
    addRetry(retry1);
    addRetry(retry2);
    assert.equal(getRetrySubmissions().length, 2);
  });

  it('addRetry is idempotent', () => {
    addRetry(retry1);
    addRetry(retry1);
    assert.equal(getRetrySubmissions().length, 1);
  });

  it('clearRetries empties table', () => {
    setRetrySubmissions([retry1, retry2]);
    clearRetries();
    assert.equal(getRetrySubmissions().length, 0);
  });
});

// =============================================
// Republish boards
// =============================================

describe('republish-boards repo', () => {
  it('get/set round-trip', () => {
    setRepublishBoards(new Set(['tech', 'general']));
    const boards = getRepublishBoards();
    assert.ok(boards.has('tech'));
    assert.ok(boards.has('general'));
  });

  it('setRepublishBoards replaces all', () => {
    setRepublishBoards(new Set(['a']));
    setRepublishBoards(new Set(['b']));
    const boards = getRepublishBoards();
    assert.ok(!boards.has('a'));
    assert.ok(boards.has('b'));
  });

  it('addRepublishBoard', () => {
    addRepublishBoard('tech');
    addRepublishBoard('tech'); // idempotent
    assert.equal(getRepublishBoards().size, 1);
  });
});
