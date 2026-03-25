import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv, VALID_BZZ, VALID_ADDRESS } from '../helpers/fixtures.js';
import { TYPES } from '../../src/protocol/constants.js';

setupTestEnv();

// --- Mock swarm client ---

const mockPublishJSON = mock.fn(async () => 'a'.repeat(64));
const mockCreateFeedManifest = mock.fn(async () => 'b'.repeat(64));
const mockUpdateFeed = mock.fn(async () => {});

mock.module('../../src/swarm/client.js', {
  namedExports: {
    fetchObject: mock.fn(async () => ({})),
    clearCache: mock.fn(),
    publishJSON: mockPublishJSON,
    createFeedManifest: mockCreateFeedManifest,
    updateFeed: mockUpdateFeed,
  },
});

const { publishAndUpdateFeed, getFeedBzzUrl } = await import('../../src/publisher/feed-manager.js');
const { getFeed, setFeed } = await import('../../src/indexer/state.js');

describe('publishAndUpdateFeed', () => {
  beforeEach(() => {
    mockPublishJSON.mock.resetCalls();
    mockCreateFeedManifest.mock.resetCalls();
    mockUpdateFeed.mock.resetCalls();
    mockPublishJSON.mock.mockImplementation(async () => 'a'.repeat(64));
    mockCreateFeedManifest.mock.mockImplementation(async () => 'b'.repeat(64));
    mockUpdateFeed.mock.mockImplementation(async () => {});
  });

  it('valid object → publishJSON called, feed created, feed updated', async () => {
    const validIndex = {
      protocol: TYPES.BOARD_INDEX,
      boardId: 'test',
      curator: VALID_ADDRESS,
      updatedAt: Date.now(),
      entries: [],
    };

    const result = await publishAndUpdateFeed('test-feed', validIndex, 'test label');

    assert.equal(mockPublishJSON.mock.callCount(), 1);
    assert.equal(mockCreateFeedManifest.mock.callCount(), 1);
    assert.equal(mockUpdateFeed.mock.callCount(), 1);
    assert.equal(result, 'a'.repeat(64));
  });

  it('invalid object → throws before any Swarm call', async () => {
    const invalidObj = { protocol: 'garbage' };

    await assert.rejects(
      () => publishAndUpdateFeed('test-feed', invalidObj, 'bad object'),
      /validation failed/,
    );

    assert.equal(mockPublishJSON.mock.callCount(), 0);
  });

  it('feed creation is idempotent — second call reuses cached manifest', async () => {
    // Pre-populate feed in state
    setFeed('cached-feed', 'b'.repeat(64));

    const validIndex = {
      protocol: TYPES.GLOBAL_INDEX,
      curator: VALID_ADDRESS,
      updatedAt: Date.now(),
      entries: [],
    };

    await publishAndUpdateFeed('cached-feed', validIndex, 'cached');

    // createFeedManifest should NOT be called (feed already in state)
    assert.equal(mockCreateFeedManifest.mock.callCount(), 0);
    assert.equal(mockUpdateFeed.mock.callCount(), 1);
  });
});

describe('getFeedBzzUrl', () => {
  it('known feed → returns bzz:// URL', () => {
    setFeed('my-feed', 'ab'.repeat(32));
    const url = getFeedBzzUrl('my-feed');
    assert.ok(url.startsWith('bzz://'));
  });

  it('unknown feed → returns null', () => {
    const url = getFeedBzzUrl('nonexistent-feed');
    assert.equal(url, null);
  });
});
