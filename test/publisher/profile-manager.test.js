import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { VALID_ADDRESS } from '../helpers/fixtures.js';

// --- Load real ethers for pass-through mock ---
const realEthers = await import('ethers');

// --- Mock config ---
const TEST_CONFIG = {
  rpcUrl: 'http://localhost:8545',
  contractAddress: '0x' + '0'.repeat(40),
  contractDeployBlock: 0,
  confirmations: 12,
  pollInterval: 30000,
  beeUrl: 'http://localhost:1633',
  postageBatchId: '0'.repeat(64),
  curatorPrivateKey: '0x' + '01'.repeat(32),
  curatorAddress: VALID_ADDRESS,
  curatorName: 'Test Curator',
  curatorDescription: 'A test curator',
  stateFile: '/tmp/test-state.json',
};

mock.module('../../src/config.js', { defaultExport: TEST_CONFIG });

// --- Mock ethers (pass-through real + mock Wallet/Provider) ---
const mockSendTransaction = mock.fn(async () => ({
  wait: async () => ({ hash: '0x' + 'ab'.repeat(32), blockNumber: 42 }),
}));

let mockGetLogs = mock.fn(async () => []);

mock.module('ethers', {
  namedExports: {
    ...realEthers,
    Wallet: class MockWallet {
      constructor() { this.address = VALID_ADDRESS; }
      sendTransaction(tx) { return mockSendTransaction(tx); }
    },
    JsonRpcProvider: class MockProvider {
      async getLogs(filter) { return mockGetLogs(filter); }
    },
  },
});

// --- Mock swarm client ---
const mockPublishAndUpdateFeed = mock.fn(async () => 'c'.repeat(64));
const mockGetFeedBzzUrl = mock.fn(() => null);

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
    getFeedBzzUrl: mockGetFeedBzzUrl,
  },
});

// --- Import module under test ---
const {
  buildProfile, needsProfileUpdate,
  publishProfileToFeed, ensureDeclared,
} = await import('../../src/publisher/profile-manager.js');
const {
  initDb, closeDb, resetDb, addBoard, setFeed, getMeta, setMeta,
} = await import('../../src/indexer/state.js');

import { before, after } from 'node:test';
before(() => initDb(':memory:'));
after(() => closeDb());

// --- Helpers ---

const FEED_MANIFEST_BZZ = `bzz://${'b'.repeat(64)}`;
const GLOBAL_FEED_BZZ = `bzz://${'d'.repeat(64)}`;
const OLD_IMMUTABLE_BZZ = `bzz://${'e'.repeat(64)}`;

function setupOneBoardWithFeeds() {
  resetDb();
  mockGetFeedBzzUrl.mock.mockImplementation((name) => {
    const feeds = {
      'global': GLOBAL_FEED_BZZ,
      'hot-global': GLOBAL_FEED_BZZ,
      'best-global': GLOBAL_FEED_BZZ,
      'hot-board-gen': GLOBAL_FEED_BZZ,
      'board-gen': GLOBAL_FEED_BZZ,
      'best-board-gen': GLOBAL_FEED_BZZ,
      'curator-profile-v1': FEED_MANIFEST_BZZ,
    };
    return feeds[name] || null;
  });
  addBoard('gen', { boardId: 'gen', slug: 'gen' });
  mockSendTransaction.mock.resetCalls();
  mockPublishAndUpdateFeed.mock.resetCalls();
  mockGetLogs.mock.resetCalls();
}

// ===========================================
// Test 1: Profile feed publish — no tx when declaration matches
// ===========================================

describe('publishProfileToFeed', () => {
  beforeEach(() => setupOneBoardWithFeeds());

  it('publishes profile to feed via publishAndUpdateFeed', async () => {
    await publishProfileToFeed();

    assert.equal(mockPublishAndUpdateFeed.mock.callCount(), 1);
    const [feedName, profile, label] = mockPublishAndUpdateFeed.mock.calls[0].arguments;
    assert.equal(feedName, 'curator-profile-v1');
    assert.equal(label, 'curatorProfile');
    assert.equal(profile.protocol, 'freedom-board/curator/v1');
    assert.equal(profile.curator, VALID_ADDRESS);
  });

  it('stores profile signature in meta after publish', async () => {
    await publishProfileToFeed();

    const sig = getMeta('last_profile_signature', null);
    assert.ok(sig);
    const profile = JSON.parse(sig);
    assert.equal(profile.curator, VALID_ADDRESS);
  });
});

// ===========================================
// Test 2: Initial declaration — no declaration exists
// ===========================================

describe('ensureDeclared — initial declaration', () => {
  beforeEach(() => {
    setupOneBoardWithFeeds();
    // No CuratorDeclared events on chain
    mockGetLogs.mock.mockImplementation(async () => []);
  });

  it('sends exactly one tx when no declaration exists', async () => {
    await ensureDeclared();

    assert.equal(mockSendTransaction.mock.callCount(), 1);
    const tx = mockSendTransaction.mock.calls[0].arguments[0];
    assert.equal(tx.to, TEST_CONFIG.contractAddress);
    assert.ok(tx.data.startsWith('0x')); // encoded declareCurator calldata
  });
});

// ===========================================
// Test 3: Migration from old immutable profile ref
// ===========================================

describe('ensureDeclared — migration from old immutable ref', () => {
  beforeEach(() => {
    setupOneBoardWithFeeds();
    // Chain returns an old immutable declaration
    const { Interface: RealInterface } = realEthers;
    const testIface = new RealInterface(['event CuratorDeclared(address indexed curator, string curatorProfileRef)']);
    const { data, topics } = testIface.encodeEventLog('CuratorDeclared', [VALID_ADDRESS, OLD_IMMUTABLE_BZZ]);
    mockGetLogs.mock.mockImplementation(async () => [{ topics, data, blockNumber: 100, index: 0 }]);
  });

  it('sends exactly one tx when declared ref differs from feed manifest', async () => {
    await ensureDeclared();

    assert.equal(mockSendTransaction.mock.callCount(), 1);
  });
});

// ===========================================
// Test 4: No-op when declaration already matches
// ===========================================

describe('ensureDeclared — already declared correctly', () => {
  beforeEach(() => {
    setupOneBoardWithFeeds();
    // Chain returns a declaration matching the current feed manifest
    const { Interface: RealInterface } = realEthers;
    const testIface = new RealInterface(['event CuratorDeclared(address indexed curator, string curatorProfileRef)']);
    const { data, topics } = testIface.encodeEventLog('CuratorDeclared', [VALID_ADDRESS, FEED_MANIFEST_BZZ]);
    mockGetLogs.mock.mockImplementation(async () => [{ topics, data, blockNumber: 100, index: 0 }]);
  });

  it('sends NO tx when declaration already points at feed manifest', async () => {
    await ensureDeclared();

    assert.equal(mockSendTransaction.mock.callCount(), 0);
  });
});

// ===========================================
// Test 5: Signature-based change detection
// ===========================================

describe('needsProfileUpdate — signature detection', () => {
  beforeEach(() => setupOneBoardWithFeeds());

  it('returns true when no previous signature stored', () => {
    assert.equal(needsProfileUpdate(), true);
  });

  it('returns false when profile matches stored signature', () => {
    const profile = buildProfile();
    setMeta('last_profile_signature', JSON.stringify(profile));
    assert.equal(needsProfileUpdate(), false);
  });

  it('returns true when curator name changes', () => {
    const profile = buildProfile();
    setMeta('last_profile_signature', JSON.stringify(profile));

    // Change name
    TEST_CONFIG.curatorName = 'Changed Curator Name';
    assert.equal(needsProfileUpdate(), true);

    // Restore
    TEST_CONFIG.curatorName = 'Test Curator';
  });

  it('returns true when curator description changes', () => {
    const profile = buildProfile();
    setMeta('last_profile_signature', JSON.stringify(profile));

    TEST_CONFIG.curatorDescription = 'Changed description';
    assert.equal(needsProfileUpdate(), true);

    TEST_CONFIG.curatorDescription = 'A test curator';
  });

  it('returns false when no global feed exists (nothing to publish)', () => {
    mockGetFeedBzzUrl.mock.mockImplementation(() => null);
    assert.equal(needsProfileUpdate(), false);
  });
});

describe('buildProfile — error cases', () => {
  it('throws when no global feed exists', () => {
    resetDb();
    mockGetFeedBzzUrl.mock.mockImplementation(() => null);
    addBoard('gen', { boardId: 'gen', slug: 'gen' });
    assert.throws(() => buildProfile(), /no global feed/);
  });
});

describe('ensureDeclared — error cases', () => {
  it('throws when profile feed not yet created', async () => {
    resetDb();
    mockGetFeedBzzUrl.mock.mockImplementation(() => null);
    await assert.rejects(() => ensureDeclared(), /profile feed not yet created/);
  });
});

// ===========================================
// Test 6: Republish retry semantics
// ===========================================

describe('publishProfileToFeed — retry semantics', () => {
  beforeEach(() => setupOneBoardWithFeeds());

  it('stores signature on success (enables change detection)', async () => {
    await publishProfileToFeed();
    const sig = getMeta('last_profile_signature', null);
    assert.ok(sig !== null);
  });

  it('throws on feed publish failure (caller sets republish flag)', async () => {
    mockPublishAndUpdateFeed.mock.mockImplementation(async () => { throw new Error('swarm down'); });

    await assert.rejects(
      () => publishProfileToFeed(),
      { message: /swarm down/ },
    );

    // Signature should NOT be updated on failure
    const sig = getMeta('last_profile_signature', null);
    assert.equal(sig, null);
  });
});
