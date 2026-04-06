import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv, bzz, VALID_BZZ, VALID_BZZ_2, VALID_ADDRESS } from '../helpers/fixtures.js';
import { TYPES } from 'swarmit-protocol';

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
  getMeta,
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
      boardId: 'general',
      kind: 'post',
      contentRef: VALID_BZZ_2,
      author: { address: VALID_ADDRESS, userFeed: VALID_BZZ },
      createdAt: Date.now(),
    };
    const post = {
      protocol: TYPES.POST,
      author: { address: VALID_ADDRESS, userFeed: VALID_BZZ },
      title: 'T', body: { kind: 'markdown', text: 'x' },
      createdAt: Date.now(),
    };

    addBoard('general', { boardId: 'general', slug: 'general' });

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
    addBoard('general', { boardId: 'general', slug: 'general' });

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
      boardId: 'general', kind: 'reply',
      contentRef: VALID_BZZ_2,
      author: { address: VALID_ADDRESS, userFeed: VALID_BZZ },
      parentSubmissionId: parentBzz,
      rootSubmissionId: parentBzz,
      createdAt: Date.now(),
    };
    const replyContent = {
      protocol: TYPES.REPLY,
      author: { address: VALID_ADDRESS, userFeed: VALID_BZZ },
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
    addBoard('general', { boardId: 'general', slug: 'general' });

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
      boardId: 'general', kind: 'post',
      contentRef: VALID_BZZ_2,
      author: { address: VALID_ADDRESS, userFeed: VALID_BZZ },
      createdAt: Date.now(),
    };
    const post = {
      protocol: TYPES.POST,
      author: { address: VALID_ADDRESS, userFeed: VALID_BZZ },
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

  it('normal event-driven publish updates last_ranked_refresh_at, preventing immediate timed refresh', async () => {
    setLastProcessedBlock(99);
    mockGetSafeBlockNumber.mock.mockImplementation(async () => 100);
    addBoard('general', { boardId: 'general' });

    // A submission arrives → triggers event-driven publish with ranked feeds
    const ref = 'e1'.repeat(32);
    mockFetchEvents.mock.mockImplementation(async () => ({
      ...emptyEvents,
      submissions: [{ submissionRef: ref, author: VALID_ADDRESS, blockNumber: 100, logIndex: 0 }],
    }));
    const submission = {
      protocol: TYPES.SUBMISSION,
      boardId: 'general', kind: 'post',
      contentRef: VALID_BZZ_2,
      author: { address: VALID_ADDRESS, userFeed: VALID_BZZ },
      createdAt: Date.now(),
    };
    const post = {
      protocol: TYPES.POST,
      author: { address: VALID_ADDRESS, userFeed: VALID_BZZ },
      title: 'T', body: { kind: 'markdown', text: 'x' },
      createdAt: Date.now(),
    };
    let n = 0;
    mockFetchObject.mock.mockImplementation(async () => {
      n++;
      return n === 1 ? submission : post;
    });

    await pollOnce();

    // last_ranked_refresh_at should be set by the event-driven publish
    const lastRefresh = getMeta('last_ranked_refresh_at');
    assert.ok(lastRefresh, 'last_ranked_refresh_at should be set after event-driven ranked publish');
    assert.ok(parseInt(lastRefresh, 10) > 0);
  });

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
