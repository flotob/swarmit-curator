import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv, bzz, VALID_BZZ, VALID_ADDRESS } from '../helpers/fixtures.js';

setupTestEnv();

// --- Mock external modules ---

const mockPublishAndUpdateFeed = mock.fn(async () => 'c'.repeat(64));
const mockNeedsProfileUpdate = mock.fn(() => false);
const mockPublishAndDeclare = mock.fn(async () => {});

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
    publishAndDeclare: mockPublishAndDeclare,
  },
});

const { publishIndexes, publishGlobalAndProfile } = await import('../../src/indexer/orchestrator.js');
const {
  addBoard, addSubmission, getBoards, getSubmissions,
  setRepublishBoards, getRepublishBoards,
  setRepublishGlobal, getRepublishGlobal,
  setRepublishProfile, getRepublishProfile,
  setRetrySubmissions,
} = await import('../../src/indexer/state.js');

// --- Tests: publishIndexes ---

describe('publishIndexes', () => {
  beforeEach(() => {
    getBoards().clear();
    getSubmissions().clear();
    setRepublishBoards(new Set());
    setRetrySubmissions([]);
    mockPublishAndUpdateFeed.mock.resetCalls();
  });

  it('thread feeds published before boardIndex (call order)', async () => {
    addBoard('board-a', { boardId: 'board-a', slug: 'board-a' });
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
    addBoard('board-b', { boardId: 'board-b', slug: 'board-b' });
    setRepublishBoards(new Set(['board-b']));

    await publishIndexes(new Set(), new Set());

    // Board feed should be published even though not in changedBoards
    const calls = mockPublishAndUpdateFeed.mock.calls;
    assert.ok(calls.some(c => c.arguments[0] === 'board-board-b'));
  });

  it('single board publish failure adds to republishBoards', async () => {
    addBoard('board-ok', { boardId: 'board-ok', slug: 'board-ok' });
    addBoard('board-fail', { boardId: 'board-fail', slug: 'board-fail' });

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
});

// --- Tests: publishGlobalAndProfile ---

describe('publishGlobalAndProfile', () => {
  beforeEach(() => {
    getBoards().clear();
    getSubmissions().clear();
    setRepublishGlobal(false);
    setRepublishProfile(false);
    mockPublishAndUpdateFeed.mock.resetCalls();
    mockPublishAndDeclare.mock.resetCalls();
    mockNeedsProfileUpdate.mock.mockImplementation(() => false);
    mockPublishAndUpdateFeed.mock.mockImplementation(async () => 'c'.repeat(64));
    mockPublishAndDeclare.mock.mockImplementation(async () => {});
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

  it('needsProfileUpdate=true → publishAndDeclare called, republishProfile set false', async () => {
    mockNeedsProfileUpdate.mock.mockImplementation(() => true);
    await publishGlobalAndProfile();
    assert.equal(mockPublishAndDeclare.mock.callCount(), 1);
    assert.equal(getRepublishProfile(), false);
  });

  it('republishProfile=true (needsProfileUpdate=false) → publishAndDeclare still called', async () => {
    setRepublishProfile(true);
    mockNeedsProfileUpdate.mock.mockImplementation(() => false);
    await publishGlobalAndProfile();
    assert.equal(mockPublishAndDeclare.mock.callCount(), 1);
    assert.equal(getRepublishProfile(), false);
  });

  it('publishAndDeclare throws → republishProfile set true', async () => {
    mockNeedsProfileUpdate.mock.mockImplementation(() => true);
    mockPublishAndDeclare.mock.mockImplementation(async () => { throw new Error('fail'); });
    await publishGlobalAndProfile();
    assert.equal(getRepublishProfile(), true);
  });

  it('global fails, profile succeeds → independent retry', async () => {
    setRepublishGlobal(true);
    mockNeedsProfileUpdate.mock.mockImplementation(() => true);
    mockPublishAndUpdateFeed.mock.mockImplementation(async () => { throw new Error('global fail'); });
    mockPublishAndDeclare.mock.mockImplementation(async () => {});

    await publishGlobalAndProfile();

    assert.equal(getRepublishGlobal(), true);   // global still pending
    assert.equal(getRepublishProfile(), false);  // profile succeeded
  });
});
