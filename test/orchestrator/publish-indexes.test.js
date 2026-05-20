import { slugToBoardId } from 'swarmit-protocol';
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv, bzz, VALID_BZZ, VALID_ADDRESS, trackConcurrency } from '../helpers/fixtures.js';

setupTestEnv();

// --- Mock external modules ---

const mockPublishAndUpdateFeed = mock.fn(async () => 'c'.repeat(64));
const mockNeedsProfileUpdate = mock.fn(() => false);
const mockPublishProfileToFeed = mock.fn(async () => {});
const mockEnsureDeclared = mock.fn(async () => {});

mock.module('../../src/chain/reader.js', {
  namedExports: {
    fetchEvents: mock.fn(async () => ({ boards: [], metadataUpdates: [], submissions: [], curators: [] })),
    getSafeBlockNumber: mock.fn(async () => 100),
  },
});

mock.module('../../src/swarm/client.js', {
  namedExports: {
    fetchObject: mock.fn(async () => ({})),
    clearCache: mock.fn(),
    publishJSON: mock.fn(async () => 'a'.repeat(64)),
    createFeedManifest: mock.fn(async () => 'b'.repeat(64)),
    updateFeed: mock.fn(async () => {}),
    isRetrievable: mock.fn(async () => true),
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
    publishProfileToFeed: mockPublishProfileToFeed,
    ensureDeclared: mockEnsureDeclared,
  },
});

const { publishIndexes, publishGlobalAndProfile } = await import('../../src/indexer/orchestrator.js');
const {
  initDb, closeDb, resetDb,
  addBoard, addSubmission,
  setRepublishBoards, getRepublishBoards,
  setRepublishGlobal, getRepublishGlobal,
  setRepublishProfile, getRepublishProfile,
  setRetrySubmissions,
} = await import('../../src/indexer/state.js');

import { before, after } from 'node:test';
before(() => initDb(':memory:'));
after(() => closeDb());

// --- Tests: publishIndexes ---

describe('publishIndexes', () => {
  beforeEach(() => {
    resetDb();
    mockPublishAndUpdateFeed.mock.resetCalls();
  });

  it('thread feeds published before boardIndex (call order)', async () => {
    addBoard('board-a', { boardId: slugToBoardId('board-a') });
    addSubmission(bzz('d1'), {
      boardId: 'board-a', kind: 'post', blockNumber: 100, logIndex: 0,
      rootSubmissionId: bzz('d1'),
    });

    const changedBoards = new Set(['board-a']);
    const changedThreads = new Set([bzz('d1')]);
    await publishIndexes(changedBoards, changedThreads);

    const calls = mockPublishAndUpdateFeed.mock.calls;
    assert.ok(calls.length >= 2);
    // Thread feeds must come before any board feeds
    const feedNames = calls.map((c) => c.arguments[0]);
    const firstBoardIdx = feedNames.findIndex((n) => n.startsWith('board-') || n.startsWith('best-board-'));
    const lastThreadIdx = feedNames.findLastIndex((n) => n.startsWith('thread-'));
    assert.ok(lastThreadIdx < firstBoardIdx, `thread feeds must be published before board feeds: ${feedNames.join(', ')}`);
  });

  it('republish queue boards are included', async () => {
    addBoard('board-b', { boardId: slugToBoardId('board-b') });
    setRepublishBoards(new Set(['board-b']));

    await publishIndexes(new Set(), new Set());

    // Board feed should be published even though not in changedBoards
    const calls = mockPublishAndUpdateFeed.mock.calls;
    assert.ok(calls.some(c => c.arguments[0] === 'board-board-b'));
  });

  it('single board publish failure adds to republishBoards', async () => {
    addBoard('board-ok', { boardId: slugToBoardId('board-ok') });
    addBoard('board-fail', { boardId: slugToBoardId('board-fail') });

    mockPublishAndUpdateFeed.mock.mockImplementation(async (feedName) => {
      if (feedName === 'board-board-fail') throw new Error('publish failed');
      return 'c'.repeat(64);
    });

    await publishIndexes(new Set(['board-ok', 'board-fail']), new Set());

    assert.ok(getRepublishBoards().has('board-fail'));
    assert.ok(!getRepublishBoards().has('board-ok'));
  });

  it('no changes + empty queue makes zero publish calls', async () => {
    await publishIndexes(new Set(), new Set());

    assert.equal(mockPublishAndUpdateFeed.mock.callCount(), 0);
  });

  it('publishes default board feeds in parallel (board + hot-board)', async () => {
    addBoard('board-par', { boardId: slugToBoardId('board-par') });
    addSubmission(bzz('p1'), {
      boardId: 'board-par', kind: 'post', blockNumber: 100, logIndex: 0,
      rootSubmissionId: bzz('p1'),
    });

    const tracker = trackConcurrency(mockPublishAndUpdateFeed);
    await publishIndexes(new Set(['board-par']), new Set([bzz('p1')]));

    // Phase 2 (board-board-par + hot-board-board-par) must run concurrently.
    assert.ok(tracker.max >= 2, `expected concurrent publishes; observed max in-flight = ${tracker.max}`);
  });

  it('publishes only default feeds (board + hot-board), not best/rising/controversial', async () => {
    addBoard('board-d', { boardId: slugToBoardId('board-d') });
    addSubmission(bzz('d2'), {
      boardId: 'board-d', kind: 'post', blockNumber: 100, logIndex: 0,
      rootSubmissionId: bzz('d2'),
    });

    await publishIndexes(new Set(['board-d']), new Set([bzz('d2')]));

    const feedNames = mockPublishAndUpdateFeed.mock.calls.map((c) => c.arguments[0]);
    assert.ok(feedNames.some((n) => n.startsWith('thread-')), 'thread feed must publish');
    assert.ok(feedNames.includes('board-board-d'), 'chronological board feed must publish');
    assert.ok(feedNames.includes('hot-board-board-d'), 'default (hot) board feed must publish');
    // The non-default ranked variants are deferred to publishRankedRefresh.
    assert.ok(!feedNames.some((n) => n.startsWith('best-board-')), 'best-board must NOT publish on event');
    assert.ok(!feedNames.some((n) => n.startsWith('rising-board-')), 'rising-board must NOT publish on event');
    assert.ok(!feedNames.some((n) => n.startsWith('controversial-board-')), 'controversial-board must NOT publish on event');
  });
});

// --- Tests: publishGlobalAndProfile ---

describe('publishGlobalAndProfile', () => {
  beforeEach(() => {
    resetDb();
    mockPublishAndUpdateFeed.mock.resetCalls();
    mockPublishProfileToFeed.mock.resetCalls();
    mockEnsureDeclared.mock.resetCalls();
    mockNeedsProfileUpdate.mock.mockImplementation(() => false);
    mockPublishAndUpdateFeed.mock.mockImplementation(async () => 'c'.repeat(64));
    mockPublishProfileToFeed.mock.mockImplementation(async () => {});
    mockEnsureDeclared.mock.mockImplementation(async () => {});
  });

  it('republishGlobal=true, success → sets to false', async () => {
    setRepublishGlobal(true);
    await publishGlobalAndProfile();
    assert.equal(getRepublishGlobal(), false);
  });

  it('republishGlobal=true, publish throws → stays true', async () => {
    setRepublishGlobal(true);
    mockPublishAndUpdateFeed.mock.mockImplementation(async () => { throw new Error('fail'); });
    await publishGlobalAndProfile();
    assert.equal(getRepublishGlobal(), true);
  });

  it('needsProfileUpdate=true → publishProfileToFeed + ensureDeclared called, republishProfile set false', async () => {
    mockNeedsProfileUpdate.mock.mockImplementation(() => true);
    await publishGlobalAndProfile();
    assert.equal(mockPublishProfileToFeed.mock.callCount(), 1);
    assert.equal(mockEnsureDeclared.mock.callCount(), 1);
    assert.equal(getRepublishProfile(), false);
  });

  it('republishProfile=true (needsProfileUpdate=false) → skips feed republish, retries declaration only', async () => {
    setRepublishProfile(true);
    mockNeedsProfileUpdate.mock.mockImplementation(() => false);
    await publishGlobalAndProfile();
    assert.equal(mockPublishProfileToFeed.mock.callCount(), 0); // profile already up-to-date
    assert.equal(mockEnsureDeclared.mock.callCount(), 1);       // declaration retry
    assert.equal(getRepublishProfile(), false);
  });

  it('publishProfileToFeed throws → republishProfile set true', async () => {
    mockNeedsProfileUpdate.mock.mockImplementation(() => true);
    mockPublishProfileToFeed.mock.mockImplementation(async () => { throw new Error('fail'); });
    await publishGlobalAndProfile();
    assert.equal(getRepublishProfile(), true);
  });

  it('global fails, profile succeeds → independent retry', async () => {
    setRepublishGlobal(true);
    mockNeedsProfileUpdate.mock.mockImplementation(() => true);
    mockPublishAndUpdateFeed.mock.mockImplementation(async () => { throw new Error('global fail'); });
    mockPublishProfileToFeed.mock.mockImplementation(async () => {});
    mockEnsureDeclared.mock.mockImplementation(async () => {});

    await publishGlobalAndProfile();

    assert.equal(getRepublishGlobal(), true);   // global still pending
    assert.equal(getRepublishProfile(), false);  // profile succeeded
  });

  it('publishes default global feeds in parallel (global + hot-global)', async () => {
    setRepublishGlobal(true);

    const tracker = trackConcurrency(mockPublishAndUpdateFeed);
    await publishGlobalAndProfile();

    assert.ok(tracker.max >= 2, `expected concurrent publishes; observed max in-flight = ${tracker.max}`);
  });

  it('publishes only default global feeds (global + hot-global), not best/rising/controversial', async () => {
    setRepublishGlobal(true);

    await publishGlobalAndProfile();

    const feedNames = mockPublishAndUpdateFeed.mock.calls.map((c) => c.arguments[0]);
    assert.ok(feedNames.includes('global'), 'chronological global feed must publish');
    assert.ok(feedNames.includes('hot-global'), 'default (hot) global feed must publish');
    assert.ok(!feedNames.includes('best-global'), 'best-global must NOT publish on event');
    assert.ok(!feedNames.includes('rising-global'), 'rising-global must NOT publish on event');
    assert.ok(!feedNames.includes('controversial-global'), 'controversial-global must NOT publish on event');
  });
});
