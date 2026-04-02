import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv, bzz } from '../helpers/fixtures.js';

setupTestEnv();

const { initDb, closeDb, resetDb, addSubmission } = await import('../../src/indexer/state.js');
const { buildThreadIndexForRoot } = await import('../../src/indexer/thread-indexer.js');
const { validateThreadIndex } = await import('../../src/protocol/objects.js');

before(() => initDb(':memory:'));
after(() => closeDb());

describe('buildThreadIndexForRoot', () => {
  beforeEach(() => resetDb());

  it('root post with no replies has 1 node (root at depth 0)', () => {
    const rootRef = bzz('a10000');
    addSubmission(rootRef, { boardId: 'b', kind: 'post', blockNumber: 1, logIndex: 0 });

    const index = buildThreadIndexForRoot({ submissionRef: rootRef });
    assert.equal(index.nodes.length, 1);
    assert.equal(index.nodes[0].submissionId, rootRef);
    assert.equal(index.nodes[0].depth, 0);
    assert.equal(index.nodes[0].parentSubmissionId, null);
  });

  it('root with 2 direct replies has 3 nodes, replies at depth 1', () => {
    const rootRef = bzz('a20000');
    const reply1 = bzz('a20001');
    const reply2 = bzz('a20002');

    addSubmission(rootRef, { boardId: 'b', kind: 'post', blockNumber: 1, logIndex: 0 });
    addSubmission(reply1, {
      boardId: 'b', kind: 'reply', parentSubmissionId: rootRef,
      rootSubmissionId: rootRef, blockNumber: 2, logIndex: 0,
    });
    addSubmission(reply2, {
      boardId: 'b', kind: 'reply', parentSubmissionId: rootRef,
      rootSubmissionId: rootRef, blockNumber: 3, logIndex: 0,
    });

    const index = buildThreadIndexForRoot({ submissionRef: rootRef });
    assert.equal(index.nodes.length, 3);
    assert.equal(index.nodes[0].depth, 0); // root
    assert.equal(index.nodes[1].depth, 1); // reply1
    assert.equal(index.nodes[2].depth, 1); // reply2
  });

  it('nested replies produce correct depth (reply to reply = depth 2)', () => {
    const rootRef = bzz('a30000');
    const reply1 = bzz('a30001');
    const nestedReply = bzz('a30002');

    addSubmission(rootRef, { boardId: 'b', kind: 'post', blockNumber: 1, logIndex: 0 });
    addSubmission(reply1, {
      boardId: 'b', kind: 'reply', parentSubmissionId: rootRef,
      rootSubmissionId: rootRef, blockNumber: 2, logIndex: 0,
    });
    addSubmission(nestedReply, {
      boardId: 'b', kind: 'reply', parentSubmissionId: reply1,
      rootSubmissionId: rootRef, blockNumber: 3, logIndex: 0,
    });

    const index = buildThreadIndexForRoot({ submissionRef: rootRef });
    assert.equal(index.nodes.length, 3);
    assert.equal(index.nodes[0].depth, 0); // root
    assert.equal(index.nodes[1].depth, 1); // reply to root
    assert.equal(index.nodes[2].depth, 2); // reply to reply
  });

  it('replies sorted by announcement order (ascending — oldest first)', () => {
    const rootRef = bzz('a40000');
    const reply1 = bzz('a40001');
    const reply2 = bzz('a40002');

    addSubmission(rootRef, { boardId: 'b', kind: 'post', blockNumber: 1, logIndex: 0 });
    addSubmission(reply1, {
      boardId: 'b', kind: 'reply', parentSubmissionId: rootRef,
      rootSubmissionId: rootRef, blockNumber: 10, logIndex: 0,
    });
    addSubmission(reply2, {
      boardId: 'b', kind: 'reply', parentSubmissionId: rootRef,
      rootSubmissionId: rootRef, blockNumber: 5, logIndex: 0,
    });

    const index = buildThreadIndexForRoot({ submissionRef: rootRef });
    // Ascending: block 5 before block 10
    assert.equal(index.nodes[1].submissionId, reply2);
    assert.equal(index.nodes[2].submissionId, reply1);
  });

  it('root node has parentSubmissionId: null', () => {
    const rootRef = bzz('a50000');
    addSubmission(rootRef, { boardId: 'b', kind: 'post', blockNumber: 1, logIndex: 0 });

    const index = buildThreadIndexForRoot({ submissionRef: rootRef });
    assert.equal(index.nodes[0].parentSubmissionId, null);
  });

  it('output passes validateThreadIndex', () => {
    const rootRef = bzz('a60000');
    const reply1 = bzz('a60001');

    addSubmission(rootRef, { boardId: 'b', kind: 'post', blockNumber: 1, logIndex: 0 });
    addSubmission(reply1, {
      boardId: 'b', kind: 'reply', parentSubmissionId: rootRef,
      rootSubmissionId: rootRef, blockNumber: 2, logIndex: 0,
    });

    const index = buildThreadIndexForRoot({ submissionRef: rootRef });
    assert.deepEqual(validateThreadIndex(index), []);
  });
});
