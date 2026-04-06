import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv, bzz, VALID_BZZ, VALID_BZZ_2, VALID_BZZ_3, VALID_ADDRESS } from '../helpers/fixtures.js';
import { TYPES } from 'swarmit-protocol';

setupTestEnv();

// --- Mock external modules before importing orchestrator ---

const emptyEvents = { boards: [], metadataUpdates: [], submissions: [], curators: [], votes: [] };
const mockFetchEvents = mock.fn(async () => emptyEvents);
const mockFetchObject = mock.fn(async () => ({}));

mock.module('../../src/chain/reader.js', {
  namedExports: {
    fetchEvents: mockFetchEvents,
    getSafeBlockNumber: mock.fn(async () => 100),
  },
});

mock.module('../../src/swarm/client.js', {
  namedExports: {
    fetchObject: mockFetchObject,
    clearCache: mock.fn(),
    publishJSON: mock.fn(async () => 'a'.repeat(64)),
    createFeedManifest: mock.fn(async () => 'b'.repeat(64)),
    updateFeed: mock.fn(async () => {}),
  },
});

mock.module('../../src/publisher/feed-manager.js', {
  namedExports: {
    publishAndUpdateFeed: mock.fn(async () => 'c'.repeat(64)),
    getFeedBzzUrl: mock.fn(() => null),
  },
});

mock.module('../../src/publisher/profile-manager.js', {
  namedExports: {
    needsProfileUpdate: mock.fn(() => false),
    publishProfileToFeed: mock.fn(async () => {}),
    ensureDeclared: mock.fn(async () => {}),
  },
});

const { processEvents } = await import('../../src/indexer/orchestrator.js');
const {
  initDb, closeDb, resetDb,
  addBoard, addSubmission, hasSubmission, getAllBoards,
  getRetrySubmissions, setRetrySubmissions, getSubmissionsForBoard,
} = await import('../../src/indexer/state.js');

import { before, after } from 'node:test';
before(() => initDb(':memory:'));
after(() => closeDb());

// --- Helpers ---

function makeSubmissionEvent(ref, opts = {}) {
  return {
    submissionRef: ref,
    author: opts.author || VALID_ADDRESS,
    blockNumber: opts.blockNumber || 100,
    logIndex: opts.logIndex || 0,
    blockTimestampMs: opts.blockTimestampMs || null,
  };
}

function makeValidSubmission(boardId = 'general', kind = 'post', overrides = {}) {
  return {
    protocol: TYPES.SUBMISSION,
    boardId,
    kind,
    contentRef: VALID_BZZ_2,
    author: { address: VALID_ADDRESS, userFeed: VALID_BZZ },
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeValidPost() {
  return {
    protocol: TYPES.POST,
    author: { address: VALID_ADDRESS, userFeed: VALID_BZZ },
    title: 'Test Post',
    body: { kind: 'markdown', text: 'Hello' },
    createdAt: Date.now(),
  };
}

function makeValidReply() {
  return {
    protocol: TYPES.REPLY,
    author: { address: VALID_ADDRESS, userFeed: VALID_BZZ },
    body: { kind: 'markdown', text: 'Reply' },
    createdAt: Date.now(),
  };
}

// --- Tests ---

describe('processEvents', () => {
  beforeEach(() => {
    resetDb();
    mockFetchEvents.mock.resetCalls();
    mockFetchObject.mock.resetCalls();
    addBoard('general', { boardId: 'general' });
  });

  it('new valid post is added to state and returned in changedBoards/changedThreads', async () => {
    const ref = 'a'.repeat(64);
    const submission = makeValidSubmission();
    const post = makeValidPost();

    mockFetchEvents.mock.mockImplementation(async () => ({
      ...emptyEvents,
      submissions: [makeSubmissionEvent(ref)],
    }));
    mockFetchObject.mock.mockImplementation(async (r) => {
      if (r === ref) return submission;
      return post;
    });

    const result = await processEvents(100, 200);

    const bzzRef = `bzz://${ref}`;
    assert.ok(hasSubmission(bzzRef));
    assert.ok(result.changedBoards.has('general'));
    assert.ok(result.changedThreads.has(bzzRef)); // root ref = self for posts
  });

  it('board registration event adds board to state', async () => {
    mockFetchEvents.mock.mockImplementation(async () => ({
      ...emptyEvents,
      boards: [{ slug: 'new-board', boardId: '0xabc', boardRef: 'ref', governance: '0x0' }],
    }));

    await processEvents(100, 200);

    const boards = getAllBoards();
    const newBoard = boards.find(b => b.slug === 'new-board');
    assert.ok(newBoard);
    assert.equal(newBoard.boardId, '0xabc');
  });

  it('duplicate submission (already in state) is skipped', async () => {
    const ref = 'b'.repeat(64);
    const bzzRef = `bzz://${ref}`;
    addSubmission(bzzRef, { boardId: 'general', kind: 'post' });

    mockFetchEvents.mock.mockImplementation(async () => ({
      ...emptyEvents,
      submissions: [makeSubmissionEvent(ref)],
    }));

    await processEvents(100, 200);

    // fetchObject should not be called — submission was skipped
    assert.equal(mockFetchObject.mock.callCount(), 0);
    assert.ok(hasSubmission(bzzRef)); // pre-existing submission still there
  });

  it('invalid submissionRef (bad hex) is dropped permanently', async () => {
    mockFetchEvents.mock.mockImplementation(async () => ({
      ...emptyEvents,
      submissions: [makeSubmissionEvent('not-valid-hex')],
    }));

    await processEvents(100, 200);

    assert.equal(hasSubmission(`bzz://not-valid-hex`), false);
    assert.equal(getRetrySubmissions().length, 0);
  });

  it('malformed submission (fails validation) is dropped permanently', async () => {
    const ref = 'c'.repeat(64);
    mockFetchEvents.mock.mockImplementation(async () => ({
      ...emptyEvents,
      submissions: [makeSubmissionEvent(ref)],
    }));
    mockFetchObject.mock.mockImplementation(async () => ({ protocol: 'wrong' }));

    await processEvents(100, 200);

    assert.equal(hasSubmission(`bzz://${ref}`), false);
    assert.equal(getRetrySubmissions().length, 0);
  });

  it('invalid content (fails content validation) is dropped permanently', async () => {
    const ref = 'd'.repeat(64);
    const submission = makeValidSubmission();

    mockFetchEvents.mock.mockImplementation(async () => ({
      ...emptyEvents,
      submissions: [makeSubmissionEvent(ref)],
    }));
    let callCount = 0;
    mockFetchObject.mock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return submission;
      return { protocol: TYPES.POST }; // invalid content (missing title, body, etc.)
    });

    await processEvents(100, 200);

    assert.equal(hasSubmission(`bzz://${ref}`), false);
    assert.equal(getRetrySubmissions().length, 0);
  });

  it('orphaned reply (parent not in state) goes to retry queue', async () => {
    const ref = 'e'.repeat(64);
    const submission = makeValidSubmission('general', 'reply', {
      parentSubmissionId: VALID_BZZ_2,
      rootSubmissionId: VALID_BZZ_3,
    });
    const reply = makeValidReply();

    mockFetchEvents.mock.mockImplementation(async () => ({
      ...emptyEvents,
      submissions: [makeSubmissionEvent(ref)],
    }));
    let callCount = 0;
    mockFetchObject.mock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return submission;
      return reply;
    });

    await processEvents(100, 200);

    assert.equal(hasSubmission(`bzz://${ref}`), false);
    assert.equal(getRetrySubmissions().length, 1);
    assert.equal(getRetrySubmissions()[0].submissionRef, ref);
  });

  it('transient fetch error goes to retry queue', async () => {
    const ref = 'f'.repeat(64);

    mockFetchEvents.mock.mockImplementation(async () => ({
      ...emptyEvents,
      submissions: [makeSubmissionEvent(ref)],
    }));
    mockFetchObject.mock.mockImplementation(async () => {
      throw new Error('network timeout');
    });

    await processEvents(100, 200);

    assert.equal(hasSubmission(`bzz://${ref}`), false);
    assert.equal(getRetrySubmissions().length, 1);
  });

  it('retry drain: orphan succeeds after parent ingested', async () => {
    const parentRef = 'a1'.repeat(32);
    const replyRef = 'b2'.repeat(32);
    const parentBzz = `bzz://${parentRef}`;
    const replyBzz = `bzz://${replyRef}`;

    // First: ingest parent post
    addSubmission(parentBzz, {
      boardId: 'general', kind: 'post', rootSubmissionId: parentBzz,
      blockNumber: 99, logIndex: 0,
    });

    // Put reply in retry queue
    setRetrySubmissions([makeSubmissionEvent(replyRef, { blockNumber: 100 })]);

    const replySubmission = makeValidSubmission('general', 'reply', {
      parentSubmissionId: parentBzz,
      rootSubmissionId: parentBzz,
    });
    const replyContent = makeValidReply();

    // Empty new events — only retry queue items processed
    mockFetchEvents.mock.mockImplementation(async () => emptyEvents);
    let callCount = 0;
    mockFetchObject.mock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return replySubmission;
      return replyContent;
    });

    await processEvents(200, 199); // empty range, drain retries only

    assert.ok(hasSubmission(replyBzz));
    assert.equal(getRetrySubmissions().length, 0);
  });

  it('processEvents does not advance block cursor', async () => {
    const { getLastProcessedBlock, setLastProcessedBlock } = await import('../../src/indexer/state.js');
    setLastProcessedBlock(50);
    mockFetchEvents.mock.mockImplementation(async () => emptyEvents);

    await processEvents(51, 100);

    assert.equal(getLastProcessedBlock(), 50); // unchanged
  });

  it('submission targeting a board registered in the same batch succeeds', async () => {
    // Board 'new-board' is NOT in the DB — it arrives in the same batch as the submission
    const ref = 'ab'.repeat(32);
    const submission = makeValidSubmission('new-board');
    const post = makeValidPost();

    mockFetchEvents.mock.mockImplementation(async () => ({
      ...emptyEvents,
      boards: [{ slug: 'new-board', boardId: '0xnew', boardRef: 'ref', governance: '0x0' }],
      submissions: [makeSubmissionEvent(ref)],
    }));
    let n = 0;
    mockFetchObject.mock.mockImplementation(async () => {
      n++;
      return n === 1 ? submission : post;
    });

    await processEvents(100, 200);

    assert.ok(hasSubmission(`bzz://${ref}`));
  });

  it('reply whose parent is accepted earlier in the same batch succeeds', async () => {
    const parentRef = 'ca'.repeat(32);
    const replyRef = 'cb'.repeat(32);
    const parentBzz = `bzz://${parentRef}`;

    const parentSubmission = makeValidSubmission('general', 'post');
    const parentContent = makeValidPost();
    const replySubmission = makeValidSubmission('general', 'reply', {
      parentSubmissionId: parentBzz,
      rootSubmissionId: parentBzz,
    });
    const replyContent = makeValidReply();

    // Both arrive as new events in the same batch — parent first
    mockFetchEvents.mock.mockImplementation(async () => ({
      ...emptyEvents,
      submissions: [
        makeSubmissionEvent(parentRef, { blockNumber: 100, logIndex: 0 }),
        makeSubmissionEvent(replyRef, { blockNumber: 100, logIndex: 1 }),
      ],
    }));
    let n = 0;
    mockFetchObject.mock.mockImplementation(async () => {
      n++;
      if (n === 1) return parentSubmission;
      if (n === 2) return parentContent;
      if (n === 3) return replySubmission;
      return replyContent;
    });

    await processEvents(100, 200);

    assert.ok(hasSubmission(parentBzz));
    assert.ok(hasSubmission(`bzz://${replyRef}`));
    assert.equal(getRetrySubmissions().length, 0);
  });

  it('retried submission preserves blockTimestampMs through retry', async () => {
    const ref = 'da'.repeat(32);
    const bzzRef = `bzz://${ref}`;
    const TIMESTAMP = 1700000500000;

    // Put submission in retry queue WITH a timestamp
    setRetrySubmissions([makeSubmissionEvent(ref, { blockNumber: 50, blockTimestampMs: TIMESTAMP })]);

    const submission = makeValidSubmission('general', 'post');
    const post = makeValidPost();

    // Empty new events — only retry queue processed
    mockFetchEvents.mock.mockImplementation(async () => emptyEvents);
    let n = 0;
    mockFetchObject.mock.mockImplementation(async () => {
      n++;
      return n === 1 ? submission : post;
    });

    await processEvents(100, 99);

    assert.ok(hasSubmission(bzzRef));
    // Verify the stored submission has the correct announcedAtMs
    const subs = getSubmissionsForBoard('general');
    const stored = subs.find((s) => s.submissionRef === bzzRef);
    assert.equal(stored.announcedAtMs, TIMESTAMP);
  });

  it('processEvents applies VoteSet totals to state', async () => {
    const { getVotesForSubmission } = await import('../../src/indexer/state.js');
    const subRef = `bzz://${'a1'.repeat(32)}`;

    mockFetchEvents.mock.mockImplementation(async () => ({
      ...emptyEvents,
      votes: [{
        submissionRef: subRef,
        submissionId: '0x' + 'a1'.repeat(32),
        voter: VALID_ADDRESS,
        rootSubmissionId: '0x' + 'a1'.repeat(32),
        direction: 1,
        previousDirection: 0,
        upvotes: 3,
        downvotes: 1,
        blockNumber: 60,
        logIndex: 0,
      }],
    }));

    await processEvents(50, 100);

    const v = getVotesForSubmission(subRef);
    assert.ok(v);
    assert.equal(v.upvotes, 3);
    assert.equal(v.downvotes, 1);
    assert.equal(v.score, 2);
  });
});
