import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv, bzz } from '../helpers/fixtures.js';

setupTestEnv();

const { initDb, closeDb, resetDb, addBoard, addSubmission, setFeed } = await import('../../src/indexer/state.js');
const { buildBoardIndexForBoard } = await import('../../src/indexer/board-indexer.js');
const { validateBoardIndex } = await import('swarmit-protocol');

before(() => initDb(':memory:'));
after(() => closeDb());

describe('buildBoardIndexForBoard', () => {
  beforeEach(() => resetDb());

  it('empty board produces valid boardIndex with empty entries', () => {
    addBoard('empty-board', { boardId: 'empty-board', slug: 'empty-board' });
    const index = buildBoardIndexForBoard('empty-board');
    assert.equal(index.entries.length, 0);
    assert.deepEqual(validateBoardIndex(index), []);
  });

  it('board with 3 posts sorted by announcement order (newest first)', () => {
    addBoard('sorted-board', { boardId: 'sorted-board', slug: 'sorted-board' });
    const refs = [bzz('aa'), bzz('bb'), bzz('cc')];
    addSubmission(refs[0], { boardId: 'sorted-board', kind: 'post', blockNumber: 100, logIndex: 0 });
    addSubmission(refs[1], { boardId: 'sorted-board', kind: 'post', blockNumber: 200, logIndex: 0 });
    addSubmission(refs[2], { boardId: 'sorted-board', kind: 'post', blockNumber: 150, logIndex: 0 });

    const index = buildBoardIndexForBoard('sorted-board');
    assert.equal(index.entries.length, 3);
    // Newest first: block 200, 150, 100
    assert.equal(index.entries[0].submissionId, refs[1]);
    assert.equal(index.entries[1].submissionId, refs[2]);
    assert.equal(index.entries[2].submissionId, refs[0]);
  });

  it('sorts by logIndex when blockNumber is equal', () => {
    addBoard('log-board', { boardId: 'log-board', slug: 'log-board' });
    const refs = [bzz('dd'), bzz('ee')];
    addSubmission(refs[0], { boardId: 'log-board', kind: 'post', blockNumber: 100, logIndex: 5 });
    addSubmission(refs[1], { boardId: 'log-board', kind: 'post', blockNumber: 100, logIndex: 10 });

    const index = buildBoardIndexForBoard('log-board');
    // Higher logIndex first (newest)
    assert.equal(index.entries[0].submissionId, refs[1]);
    assert.equal(index.entries[1].submissionId, refs[0]);
  });

  it('only includes kind: post, not replies', () => {
    addBoard('filter-board', { boardId: 'filter-board', slug: 'filter-board' });
    addSubmission(bzz('ff'), { boardId: 'filter-board', kind: 'post', blockNumber: 100, logIndex: 0 });
    addSubmission(bzz('f1'), {
      boardId: 'filter-board', kind: 'reply', blockNumber: 101, logIndex: 0,
      rootSubmissionId: bzz('ff'), parentSubmissionId: bzz('ff'),
    });

    const index = buildBoardIndexForBoard('filter-board');
    assert.equal(index.entries.length, 1);
  });

  it('includes threadIndexFeed when thread feed exists in state', () => {
    addBoard('feed-board', { boardId: 'feed-board', slug: 'feed-board' });
    const postRef = bzz('22');
    addSubmission(postRef, { boardId: 'feed-board', kind: 'post', blockNumber: 100, logIndex: 0 });
    setFeed(`thread-${postRef}`, 'ab'.repeat(32));

    const index = buildBoardIndexForBoard('feed-board');
    assert.ok(index.entries[0].threadIndexFeed);
    assert.ok(index.entries[0].threadIndexFeed.startsWith('bzz://'));
  });

  it('omits threadIndexFeed when thread feed not yet created', () => {
    addBoard('nofeed-board', { boardId: 'nofeed-board', slug: 'nofeed-board' });
    addSubmission(bzz('33'), { boardId: 'nofeed-board', kind: 'post', blockNumber: 100, logIndex: 0 });

    const index = buildBoardIndexForBoard('nofeed-board');
    assert.equal(index.entries[0].threadIndexFeed, undefined);
  });

  it('output passes validateBoardIndex', () => {
    addBoard('valid-board', { boardId: 'valid-board', slug: 'valid-board' });
    addSubmission(bzz('44'), { boardId: 'valid-board', kind: 'post', blockNumber: 100, logIndex: 0 });

    const index = buildBoardIndexForBoard('valid-board');
    assert.deepEqual(validateBoardIndex(index), []);
  });
});
