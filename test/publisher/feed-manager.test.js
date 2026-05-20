import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv, VALID_BZZ, VALID_ADDRESS } from '../helpers/fixtures.js';
import { TYPES, slugToBoardId } from 'swarmit-protocol';

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
const { initDb, closeDb, resetDb, getFeed, setFeed } = await import('../../src/indexer/state.js');

import { before, after } from 'node:test';
before(() => initDb(':memory:'));
after(() => closeDb());

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
      boardId: slugToBoardId('test'),
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

  it('unchanged content (differing only in updatedAt) → skips publishJSON and updateFeed', async () => {
    const idx = {
      protocol: TYPES.GLOBAL_INDEX, curator: VALID_ADDRESS, updatedAt: 1000, entries: [],
    };

    await publishAndUpdateFeed('wp2-skip', idx, 'first');
    assert.equal(mockPublishJSON.mock.callCount(), 1);
    assert.equal(mockUpdateFeed.mock.callCount(), 1);

    // Same content, different updatedAt — must hit the no-change skip.
    await publishAndUpdateFeed('wp2-skip', { ...idx, updatedAt: 9999 }, 'second');
    assert.equal(mockPublishJSON.mock.callCount(), 1);
    assert.equal(mockUpdateFeed.mock.callCount(), 1);
  });

  it('changed content → publishes again', async () => {
    const idx1 = {
      protocol: TYPES.GLOBAL_INDEX, curator: VALID_ADDRESS, updatedAt: 0, entries: [],
    };
    const idx2 = {
      ...idx1,
      entries: [{ boardId: slugToBoardId('a'), boardSlug: 'a', submissionId: VALID_BZZ, submissionRef: VALID_BZZ }],
    };

    await publishAndUpdateFeed('wp2-change', idx1, 'first');
    await publishAndUpdateFeed('wp2-change', idx2, 'second');
    assert.equal(mockPublishJSON.mock.callCount(), 2);
    assert.equal(mockUpdateFeed.mock.callCount(), 2);
  });

  it('failed updateFeed does not persist hash → next call retries', async () => {
    const idx = {
      protocol: TYPES.GLOBAL_INDEX, curator: VALID_ADDRESS, updatedAt: 0, entries: [],
    };

    mockUpdateFeed.mock.mockImplementation(async () => { throw new Error('boom'); });
    await assert.rejects(() => publishAndUpdateFeed('wp2-retry', idx, 'fails'));
    assert.equal(mockUpdateFeed.mock.callCount(), 1);

    mockUpdateFeed.mock.mockImplementation(async () => {});
    await publishAndUpdateFeed('wp2-retry', idx, 'retry');
    // publishJSON called twice (no hash stored after the first failure), and
    // updateFeed retried — confirming the failed attempt did not poison state.
    assert.equal(mockPublishJSON.mock.callCount(), 2);
    assert.equal(mockUpdateFeed.mock.callCount(), 2);
  });

  it('skip path returns the previously-stored content ref', async () => {
    const idx = {
      protocol: TYPES.GLOBAL_INDEX, curator: VALID_ADDRESS, updatedAt: 0, entries: [],
    };
    mockPublishJSON.mock.mockImplementation(async () => 'a'.repeat(64));

    const first = await publishAndUpdateFeed('wp2-ret', idx, 'first');
    // Change the mock so any unintended publishJSON would produce a different
    // ref — the assertion below proves we didn't call it.
    mockPublishJSON.mock.mockImplementation(async () => 'b'.repeat(64));
    const second = await publishAndUpdateFeed('wp2-ret', { ...idx, updatedAt: 1 }, 'second');

    assert.equal(second, first);
    assert.equal(mockPublishJSON.mock.callCount(), 1);
  });

  it('identical content on a different feed name does not skip — keys are per-feed', async () => {
    const idx = {
      protocol: TYPES.GLOBAL_INDEX, curator: VALID_ADDRESS, updatedAt: 0, entries: [],
    };

    await publishAndUpdateFeed('wp2-iso-a', idx, 'a');
    await publishAndUpdateFeed('wp2-iso-b', idx, 'b');

    // Each feed's first call must publish — even with byte-identical content.
    assert.equal(mockPublishJSON.mock.callCount(), 2);
    assert.equal(mockUpdateFeed.mock.callCount(), 2);
  });

  it('failed publishJSON does not persist hash → next call retries', async () => {
    const idx = {
      protocol: TYPES.GLOBAL_INDEX, curator: VALID_ADDRESS, updatedAt: 0, entries: [],
    };

    mockPublishJSON.mock.mockImplementation(async () => { throw new Error('boom'); });
    await assert.rejects(() => publishAndUpdateFeed('wp2-pj-retry', idx, 'fails'));
    assert.equal(mockUpdateFeed.mock.callCount(), 0); // never reached updateFeed

    mockPublishJSON.mock.mockImplementation(async () => 'a'.repeat(64));
    await publishAndUpdateFeed('wp2-pj-retry', idx, 'retry');
    assert.equal(mockPublishJSON.mock.callCount(), 2);
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
