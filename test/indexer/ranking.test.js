import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, resetDb } from '../../src/db/sqlite.js';
import { addSubmission } from '../../src/db/repos/submissions.js';
import { applyVoteEvent } from '../../src/db/repos/votes.js';
import { insertVoteEvent } from '../../src/db/repos/vote-events.js';
import { rankByBest, rankByHot, rankByRising, rankByControversial } from '../../src/indexer/ranking.js';

before(() => initDb(':memory:'));
after(() => closeDb());
beforeEach(() => resetDb());

// Fixed time for deterministic tests
const NOW = 1700100000000;
const HOUR = 3600000;

function addPost(ref, { boardSlug = 'gen', announcedAtMs = NOW - HOUR, blockNumber = 100, logIndex = 0 } = {}) {
  addSubmission(ref, { boardId: boardSlug, kind: 'post', contentRef: 'bzz://c', author: '0x1', blockNumber, logIndex, announcedAtMs });
  return { submissionRef: ref, boardId: boardSlug, kind: 'post', blockNumber, logIndex, announcedAtMs };
}

function vote(ref, up, down, block = 100) {
  applyVoteEvent({ submissionRef: ref, upvotes: up, downvotes: down, blockNumber: block, logIndex: 0 });
}

function voteEvent(ref, voter, dir, prevDir, blockTimestampMs) {
  insertVoteEvent({ submissionRef: ref, voter, direction: dir, previousDirection: prevDir, blockNumber: 100, logIndex: 0, blockTimestampMs });
}

// =============================================
// rankByBest
// =============================================

describe('rankByBest', () => {
  it('sorts by score descending', () => {
    const a = addPost('bzz://a');
    const b = addPost('bzz://b');
    const c = addPost('bzz://c');
    vote('bzz://a', 5, 1); // score 4
    vote('bzz://b', 10, 2); // score 8
    vote('bzz://c', 3, 0); // score 3

    const ranked = rankByBest([a, b, c]);
    assert.equal(ranked[0].submissionRef, 'bzz://b');
    assert.equal(ranked[1].submissionRef, 'bzz://a');
    assert.equal(ranked[2].submissionRef, 'bzz://c');
  });

  it('tie-breaks by newest first', () => {
    const a = addPost('bzz://a', { blockNumber: 100 });
    const b = addPost('bzz://b', { blockNumber: 200 });
    // Both score 0 (no votes)
    const ranked = rankByBest([a, b]);
    assert.equal(ranked[0].submissionRef, 'bzz://b'); // newer
  });
});

// =============================================
// rankByHot
// =============================================

describe('rankByHot', () => {
  it('newer post with same score ranks higher', () => {
    const old = addPost('bzz://old', { announcedAtMs: NOW - 48 * HOUR, blockNumber: 100 });
    const fresh = addPost('bzz://fresh', { announcedAtMs: NOW - 1 * HOUR, blockNumber: 200 });
    vote('bzz://old', 10, 0);
    vote('bzz://fresh', 10, 0);

    const ranked = rankByHot([old, fresh], NOW);
    assert.equal(ranked[0].submissionRef, 'bzz://fresh');
  });

  it('high-score old post can beat low-score new post', () => {
    const old = addPost('bzz://old', { announcedAtMs: NOW - 2 * HOUR, blockNumber: 100 });
    const fresh = addPost('bzz://fresh', { announcedAtMs: NOW - 0.5 * HOUR, blockNumber: 200 });
    vote('bzz://old', 100, 0);
    vote('bzz://fresh', 1, 0);

    const ranked = rankByHot([old, fresh], NOW);
    assert.equal(ranked[0].submissionRef, 'bzz://old');
  });

  it('includes all posts (never omits)', () => {
    const a = addPost('bzz://a');
    const b = addPost('bzz://b');
    // No votes at all
    const ranked = rankByHot([a, b], NOW);
    assert.equal(ranked.length, 2);
  });
});

// =============================================
// rankByRising
// =============================================

describe('rankByRising', () => {
  it('post with recent upvotes qualifies', () => {
    const post = addPost('bzz://a', { announcedAtMs: NOW - 2 * HOUR });
    vote('bzz://a', 5, 0);
    voteEvent('bzz://a', '0x1', 1, 0, NOW - HOUR); // recent upvote

    const ranked = rankByRising([post], NOW);
    assert.equal(ranked.length, 1);
  });

  it('post with no recent votes is omitted', () => {
    const post = addPost('bzz://a', { announcedAtMs: NOW - 2 * HOUR });
    vote('bzz://a', 5, 0);
    // Vote event is old (> 24h ago)
    voteEvent('bzz://a', '0x1', 1, 0, NOW - 25 * HOUR);

    const ranked = rankByRising([post], NOW);
    assert.equal(ranked.length, 0);
  });

  it('post older than 7 days is omitted', () => {
    const post = addPost('bzz://a', { announcedAtMs: NOW - 8 * 24 * HOUR });
    vote('bzz://a', 5, 0);
    voteEvent('bzz://a', '0x1', 1, 0, NOW - HOUR);

    const ranked = rankByRising([post], NOW);
    assert.equal(ranked.length, 0);
  });

  it('post with only downvotes (negative delta) is omitted', () => {
    const post = addPost('bzz://a', { announcedAtMs: NOW - 2 * HOUR });
    vote('bzz://a', 0, 5);
    voteEvent('bzz://a', '0x1', -1, 0, NOW - HOUR);

    const ranked = rankByRising([post], NOW);
    assert.equal(ranked.length, 0);
  });

  it('tie-breaks by total score then newest', () => {
    const a = addPost('bzz://a', { announcedAtMs: NOW - 2 * HOUR, blockNumber: 100 });
    const b = addPost('bzz://b', { announcedAtMs: NOW - 2 * HOUR, blockNumber: 200 });
    vote('bzz://a', 10, 0);
    vote('bzz://b', 5, 0);
    // Same recent delta
    voteEvent('bzz://a', '0x1', 1, 0, NOW - HOUR);
    voteEvent('bzz://b', '0x2', 1, 0, NOW - HOUR);

    const ranked = rankByRising([a, b], NOW);
    // Same risingScore (same delta, same age) → tie-break by total score
    assert.equal(ranked[0].submissionRef, 'bzz://a'); // higher total score
  });
});

// =============================================
// rankByControversial
// =============================================

describe('rankByControversial', () => {
  it('post with both upvotes and downvotes qualifies', () => {
    const post = addPost('bzz://a');
    vote('bzz://a', 10, 8);

    const ranked = rankByControversial([post]);
    assert.equal(ranked.length, 1);
  });

  it('post with only upvotes is omitted', () => {
    const post = addPost('bzz://a');
    vote('bzz://a', 10, 0);

    const ranked = rankByControversial([post]);
    assert.equal(ranked.length, 0);
  });

  it('post with only downvotes is omitted', () => {
    const post = addPost('bzz://a');
    vote('bzz://a', 0, 10);

    const ranked = rankByControversial([post]);
    assert.equal(ranked.length, 0);
  });

  it('post with no votes is omitted', () => {
    const post = addPost('bzz://a');

    const ranked = rankByControversial([post]);
    assert.equal(ranked.length, 0);
  });

  it('more balanced voting scores higher', () => {
    const balanced = addPost('bzz://balanced');
    const lopsided = addPost('bzz://lopsided');
    vote('bzz://balanced', 10, 10); // perfect balance, total 20, score = 20 * 1.0 = 20
    vote('bzz://lopsided', 20, 2); // low balance, total 22, score = 22 * 0.1 = 2.2

    const ranked = rankByControversial([balanced, lopsided]);
    assert.equal(ranked[0].submissionRef, 'bzz://balanced');
  });

  it('tie-breaks by newest first', () => {
    const a = addPost('bzz://a', { blockNumber: 100 });
    const b = addPost('bzz://b', { blockNumber: 200 });
    vote('bzz://a', 5, 5);
    vote('bzz://b', 5, 5);

    const ranked = rankByControversial([a, b]);
    assert.equal(ranked[0].submissionRef, 'bzz://b'); // newer
  });
});
