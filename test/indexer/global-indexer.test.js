import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv, bzz } from '../helpers/fixtures.js';

setupTestEnv();

const { initDb, closeDb, resetDb, addBoard, addSubmission } = await import('../../src/indexer/state.js');
const { buildGlobalIndexFromState } = await import('../../src/indexer/global-indexer.js');
const { validateGlobalIndex } = await import('../../src/protocol/objects.js');

before(() => initDb(':memory:'));
after(() => closeDb());

describe('buildGlobalIndexFromState', () => {
  beforeEach(() => resetDb());

  it('no boards produces valid globalIndex with empty entries', () => {
    const index = buildGlobalIndexFromState();
    assert.equal(index.entries.length, 0);
    assert.deepEqual(validateGlobalIndex(index), []);
  });

  it('2 boards with posts includes entries from both, sorted newest first', () => {
    addBoard('board-a', {});
    addBoard('board-b', {});
    addSubmission(bzz('e1'), { boardId: 'board-a', kind: 'post', blockNumber: 100, logIndex: 0 });
    addSubmission(bzz('e2'), { boardId: 'board-b', kind: 'post', blockNumber: 200, logIndex: 0 });
    addSubmission(bzz('e3'), { boardId: 'board-a', kind: 'post', blockNumber: 150, logIndex: 0 });

    const index = buildGlobalIndexFromState();
    assert.equal(index.entries.length, 3);
    // Newest first: block 200, 150, 100
    assert.equal(index.entries[0].submissionId, bzz('e2'));
    assert.equal(index.entries[1].submissionId, bzz('e3'));
    assert.equal(index.entries[2].submissionId, bzz('e1'));
  });

  it('entries include boardId', () => {
    addBoard('board-c', {});
    addSubmission(bzz('e4'), { boardId: 'board-c', kind: 'post', blockNumber: 100, logIndex: 0 });

    const index = buildGlobalIndexFromState();
    assert.equal(index.entries[0].boardId, 'board-c');
  });

  it('only includes posts, not replies', () => {
    addBoard('board-d', {});
    addSubmission(bzz('e5'), { boardId: 'board-d', kind: 'post', blockNumber: 100, logIndex: 0 });
    addSubmission(bzz('e6'), {
      boardId: 'board-d', kind: 'reply', blockNumber: 101, logIndex: 0,
      rootSubmissionId: bzz('e5'), parentSubmissionId: bzz('e5'),
    });

    const index = buildGlobalIndexFromState();
    assert.equal(index.entries.length, 1);
  });

  it('output passes validateGlobalIndex', () => {
    addBoard('board-e', {});
    addSubmission(bzz('e7'), { boardId: 'board-e', kind: 'post', blockNumber: 100, logIndex: 0 });

    const index = buildGlobalIndexFromState();
    assert.deepEqual(validateGlobalIndex(index), []);
  });
});
