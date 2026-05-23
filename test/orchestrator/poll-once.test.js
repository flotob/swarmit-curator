import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv, bzz, VALID_BZZ, VALID_BZZ_2, VALID_ADDRESS } from '../helpers/fixtures.js';
import { TYPES, slugToBoardId } from 'swarmit-protocol';

setupTestEnv();

// --- Mock external modules ---

const emptyEvents = { boards: [], metadataUpdates: [], submissions: [], curators: [], votes: [] };
const mockFetchEvents = mock.fn(async () => emptyEvents);
const mockFetchObject = mock.fn(async () => ({}));
const mockGetSafeBlockNumber = mock.fn(async () => 100);
const mockClearCache = mock.fn();
const mockPublishAndUpdateFeed = mock.fn(async () => 'c'.repeat(64));
const mockNeedsProfileUpdate = mock.fn(() => false);
const mockPublishAndDeclare = mock.fn(async () => {});
const mockIsRetrievable = mock.fn(async () => true);

mock.module('../../src/chain/reader.js', {
  namedExports: {
    fetchEvents: mockFetchEvents,
    getSafeBlockNumber: mockGetSafeBlockNumber,
  },
});

mock.module('../../src/swarm/client.js', {
  namedExports: {
    fetchObject: mockFetchObject,
    clearCache: mockClearCache,
    publishJSON: mock.fn(async () => 'a'.repeat(64)),
    createFeedManifest: mock.fn(async () => 'b'.repeat(64)),
    updateFeed: mock.fn(async () => {}),
    isRetrievable: mockIsRetrievable,
  },
});

mock.module('../../src/publisher/feed-manager.js', {
  namedExports: {
    publishAndUpdateFeed: mockPublishAndUpdateFeed,
    getFeedBzzUrl: mock.fn(() => null),
  },
});

mock.module('../../src/publisher/profile-manager.js', {
  namedExports: {
    needsProfileUpdate: mockNeedsProfileUpdate,
    publishProfileToFeed: mock.fn(async () => {}),
    ensureDeclared: mock.fn(async () => {}),
  },
});

const { pollOnce, MAX_BLOCKS_PER_POLL } = await import('../../src/indexer/orchestrator.js');
const {
  initDb, closeDb, resetDb,
  getLastProcessedBlock, setLastProcessedBlock,
  addBoard, addSubmission, hasSubmission,
  getRetrySubmissions, setRetrySubmissions,
  setRepublishBoards, getRepublishBoards,
  setRepublishGlobal, getRepublishGlobal,
  setRepublishProfile,
  getMeta, setMeta,
} = await import('../../src/indexer/state.js');

import { before, after } from 'node:test';
before(() => initDb(':memory:'));
after(() => closeDb());

// --- Helpers ---

function resetAll() {
  resetDb();
  setLastProcessedBlock(-1);

  mockFetchEvents.mock.resetCalls();
  mockFetchObject.mock.resetCalls();
  mockGetSafeBlockNumber.mock.resetCalls();
  mockClearCache.mock.resetCalls();
  mockPublishAndUpdateFeed.mock.resetCalls();
  mockPublishAndDeclare.mock.resetCalls();
  mockIsRetrievable.mock.resetCalls();
  mockIsRetrievable.mock.mockImplementation(async () => true);

  mockFetchEvents.mock.mockImplementation(async () => emptyEvents);
  mockFetchObject.mock.mockImplementation(async () => ({}));
  mockGetSafeBlockNumber.mock.mockImplementation(async () => 100);
  mockPublishAndUpdateFeed.mock.mockImplementation(async () => 'c'.repeat(64));
  mockNeedsProfileUpdate.mock.mockImplementation(() => false);
  mockPublishAndDeclare.mock.mockImplementation(async () => {});
}

// --- Tests ---

describe('pollOnce', () => {
  beforeEach(resetAll);

  it('new blocks with submissions → cursor advances to toBlock', async () => {
    setLastProcessedBlock(49);
    mockGetSafeBlockNumber.mock.mockImplementation(async () => 100);

    const ref = 'a'.repeat(64);
    const submission = {
      protocol: TYPES.SUBMISSION,
      boardId: slugToBoardId('general'),
      kind: 'post',
      contentRef: VALID_BZZ_2,
      author: { address: VALID_ADDRESS },
      createdAt: Date.now(),
    };
    const post = {
      protocol: TYPES.POST,
      author: { address: VALID_ADDRESS },
      title: 'T', body: { kind: 'markdown', text: 'x' },
      createdAt: Date.now(),
    };

    addBoard('general', { boardId: slugToBoardId('general') });

    mockFetchEvents.mock.mockImplementation(async () => ({
      ...emptyEvents,
      submissions: [{ submissionRef: ref, author: VALID_ADDRESS, blockNumber: 50, logIndex: 0 }],
    }));
    let n = 0;
    mockFetchObject.mock.mockImplementation(async () => {
      n++;
      return n === 1 ? submission : post;
    });

    const result = await pollOnce();

    assert.equal(result.idle, false);
    assert.equal(getLastProcessedBlock(), 100);
    assert.ok(hasSubmission(`bzz://${ref}`));
  });

  it('no new blocks + retry queue → retries drained, cursor NOT advanced', async () => {
    setLastProcessedBlock(100);
    mockGetSafeBlockNumber.mock.mockImplementation(async () => 100);
    addBoard('general', { boardId: slugToBoardId('general') });

    const parentRef = 'a1'.repeat(32);
    const replyRef = 'b2'.repeat(32);
    const parentBzz = `bzz://${parentRef}`;

    addSubmission(parentBzz, {
      boardId: 'general', kind: 'post', rootSubmissionId: parentBzz,
      blockNumber: 99, logIndex: 0,
    });

    setRetrySubmissions([{
      submissionRef: replyRef, author: VALID_ADDRESS, blockNumber: 100, logIndex: 1,
    }]);

    const replySubmission = {
      protocol: TYPES.SUBMISSION,
      boardId: slugToBoardId('general'), kind: 'reply',
      contentRef: VALID_BZZ_2,
      author: { address: VALID_ADDRESS },
      parentSubmissionId: parentBzz,
      rootSubmissionId: parentBzz,
      createdAt: Date.now(),
    };
    const replyContent = {
      protocol: TYPES.REPLY,
      author: { address: VALID_ADDRESS },
      body: { kind: 'markdown', text: 'r' },
      createdAt: Date.now(),
    };

    let n = 0;
    mockFetchObject.mock.mockImplementation(async () => {
      n++;
      return n === 1 ? replySubmission : replyContent;
    });

    const result = await pollOnce();

    assert.equal(result.idle, false);
    assert.equal(getLastProcessedBlock(), 100); // NOT advanced
    assert.ok(hasSubmission(`bzz://${replyRef}`));
    assert.equal(getRetrySubmissions().length, 0);
  });

  it('no new blocks + no pending work → returns idle', async () => {
    setLastProcessedBlock(100);
    mockGetSafeBlockNumber.mock.mockImplementation(async () => 100);

    const result = await pollOnce();

    assert.equal(result.idle, true);
    assert.equal(mockFetchEvents.mock.callCount(), 0);
  });

  it('publishGlobalAndProfile runs every iteration (not gated on changedBoards)', async () => {
    setLastProcessedBlock(99);
    mockGetSafeBlockNumber.mock.mockImplementation(async () => 100);
    // No submissions → no changedBoards → but republishGlobal is true
    setRepublishGlobal(true);

    await pollOnce();

    // Global should have been published even with no board changes
    assert.equal(getRepublishGlobal(), false);
  });

  it('block cursor advances after processEvents, before publish', async () => {
    setLastProcessedBlock(49);
    mockGetSafeBlockNumber.mock.mockImplementation(async () => 100);
    addBoard('general', { boardId: slugToBoardId('general') });

    // Make publishAndUpdateFeed throw — cursor should still be advanced
    mockPublishAndUpdateFeed.mock.mockImplementation(async () => { throw new Error('publish fail'); });

    // Add a submission so changedBoards is non-empty → publishIndexes runs
    const ref = 'f1'.repeat(32);
    mockFetchEvents.mock.mockImplementation(async () => ({
      ...emptyEvents,
      submissions: [{ submissionRef: ref, author: VALID_ADDRESS, blockNumber: 50, logIndex: 0 }],
    }));
    const submission = {
      protocol: TYPES.SUBMISSION,
      boardId: slugToBoardId('general'), kind: 'post',
      contentRef: VALID_BZZ_2,
      author: { address: VALID_ADDRESS },
      createdAt: Date.now(),
    };
    const post = {
      protocol: TYPES.POST,
      author: { address: VALID_ADDRESS },
      title: 'T', body: { kind: 'markdown', text: 'x' },
      createdAt: Date.now(),
    };
    let n = 0;
    mockFetchObject.mock.mockImplementation(async () => {
      n++;
      return n === 1 ? submission : post;
    });

    await pollOnce();

    // Cursor advanced despite publish failure
    assert.equal(getLastProcessedBlock(), 100);
    // Board is in republish queue for next iteration
    assert.ok(getRepublishBoards().has('general'));
  });

  it('event-driven publish does NOT bump last_ranked_refresh_at (timer-only writer)', async () => {
    setLastProcessedBlock(99);
    mockGetSafeBlockNumber.mock.mockImplementation(async () => 100);
    addBoard('general', { boardId: slugToBoardId('general') });

    // Park the ranked timer in the recent past so the timed refresh does NOT
    // fire — this test isolates the event-driven path from the timer one.
    const PARKED = String(Date.now());
    setMeta('last_ranked_refresh_at', PARKED);

    const ref = 'e1'.repeat(32);
    mockFetchEvents.mock.mockImplementation(async () => ({
      ...emptyEvents,
      submissions: [{ submissionRef: ref, author: VALID_ADDRESS, blockNumber: 100, logIndex: 0 }],
    }));
    const submission = {
      protocol: TYPES.SUBMISSION,
      boardId: slugToBoardId('general'), kind: 'post',
      contentRef: VALID_BZZ_2,
      author: { address: VALID_ADDRESS },
      createdAt: Date.now(),
    };
    const post = {
      protocol: TYPES.POST,
      author: { address: VALID_ADDRESS },
      title: 'T', body: { kind: 'markdown', text: 'x' },
      createdAt: Date.now(),
    };
    let n = 0;
    mockFetchObject.mock.mockImplementation(async () => {
      n++;
      return n === 1 ? submission : post;
    });

    await pollOnce();

    // Event-driven publish must not have written the timer key; it's unchanged.
    assert.equal(getMeta('last_ranked_refresh_at'), PARKED);
  });

  it('publishRankedRefresh still fires when its timer is due, even with event-driven changes', async () => {
    setLastProcessedBlock(99);
    mockGetSafeBlockNumber.mock.mockImplementation(async () => 100);
    addBoard('general', { boardId: slugToBoardId('general') });

    // Timer is due (last_ranked_refresh_at unset → treated as 0).
    const ref = 'e2'.repeat(32);
    mockFetchEvents.mock.mockImplementation(async () => ({
      ...emptyEvents,
      submissions: [{ submissionRef: ref, author: VALID_ADDRESS, blockNumber: 100, logIndex: 0 }],
    }));
    const submission = {
      protocol: TYPES.SUBMISSION,
      boardId: slugToBoardId('general'), kind: 'post',
      contentRef: VALID_BZZ_2,
      author: { address: VALID_ADDRESS },
      createdAt: Date.now(),
    };
    const post = {
      protocol: TYPES.POST,
      author: { address: VALID_ADDRESS },
      title: 'T', body: { kind: 'markdown', text: 'x' },
      createdAt: Date.now(),
    };
    let n = 0;
    mockFetchObject.mock.mockImplementation(async () => {
      n++;
      return n === 1 ? submission : post;
    });

    await pollOnce();

    // The timed refresh fired despite event-driven changes — that's the WP3
    // regression fix: don't let a busy poll starve best/rising/controversial.
    const lastRefresh = parseInt(getMeta('last_ranked_refresh_at') || '0', 10);
    assert.ok(lastRefresh > 0, 'publishRankedRefresh should fire when timer is due even with event-driven changes');
  });

  // Liveness sweeps are no longer triggered by pollOnce — they run on their
  // own scheduler (see test/indexer/liveness-orchestration.test.js). pollOnce
  // only drains the resulting `republish_boards` queue, which is covered by
  // the "republish queue boards are included" cases in publish-indexes.test.js.

  it('MAX_BLOCKS_PER_POLL caps toBlock', async () => {
    setLastProcessedBlock(-1);
    const hugeBlock = MAX_BLOCKS_PER_POLL + 5000;
    mockGetSafeBlockNumber.mock.mockImplementation(async () => hugeBlock);

    await pollOnce();

    // Should process at most MAX_BLOCKS_PER_POLL blocks
    assert.equal(getLastProcessedBlock(), MAX_BLOCKS_PER_POLL - 1);
    // fetchEvents called with (0, MAX_BLOCKS_PER_POLL - 1)
    const [from, to] = mockFetchEvents.mock.calls[0].arguments;
    assert.equal(from, 0);
    assert.equal(to, MAX_BLOCKS_PER_POLL - 1);
  });
});
