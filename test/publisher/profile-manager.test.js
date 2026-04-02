import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { VALID_ADDRESS } from '../helpers/fixtures.js';

// --- Load real ethers for Interface + keccak256/toUtf8Bytes ---
const { Interface: RealInterface, keccak256: realKeccak256, toUtf8Bytes: realToUtf8Bytes } = await import('ethers');

// Build expected calldata using the real ABI — if the ABI drifts, tests catch it
const declareCuratorIface = new RealInterface(['function declareCurator(string curatorProfileRef)']);

// --- Mock config, ethers, and client BEFORE importing profile-manager ---

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

const mockSendTransaction = mock.fn(async () => ({
  wait: async () => ({ hash: '0x' + 'ab'.repeat(32), blockNumber: 42 }),
}));

mock.module('ethers', {
  namedExports: {
    Wallet: class MockWallet {
      constructor() { this.address = VALID_ADDRESS; }
      sendTransaction(tx) { return mockSendTransaction(tx); }
    },
    JsonRpcProvider: class MockProvider {},
    // Real Interface — exercises the actual ABI for encodeFunctionData
    Interface: RealInterface,
    // Real keccak256/toUtf8Bytes — needed by references.js (transitively loaded)
    keccak256: realKeccak256,
    toUtf8Bytes: realToUtf8Bytes,
  },
});

const mockPublishJSON = mock.fn(async () => 'a'.repeat(64));

mock.module('../../src/swarm/client.js', {
  namedExports: {
    fetchObject: mock.fn(async () => ({})),
    clearCache: mock.fn(),
    publishJSON: mockPublishJSON,
    createFeedManifest: mock.fn(async () => 'b'.repeat(64)),
    updateFeed: mock.fn(async () => {}),
  },
});

const { needsProfileUpdate, publishAndDeclare } = await import('../../src/publisher/profile-manager.js');
const {
  initDb, closeDb, resetDb,
  addBoard, setFeed,
  getPublishedKeys, setPublishedKeys,
} = await import('../../src/indexer/state.js');

import { before, after } from 'node:test';
before(() => initDb(':memory:'));
after(() => closeDb());

// --- Tests ---

describe('needsProfileUpdate', () => {
  beforeEach(() => resetDb());

  it('no boards → false', () => {
    assert.equal(needsProfileUpdate(), false);
  });

  it('all boards already published → false', () => {
    addBoard('general', { boardId: 'general' });
    setFeed('board-general', 'c'.repeat(64));
    setPublishedKeys(['board:general']);
    assert.equal(needsProfileUpdate(), false);
  });

  it('new board added since last publish → true', () => {
    addBoard('general', { boardId: 'general' });
    addBoard('tech', { boardId: 'tech' });
    setFeed('board-tech', 'c'.repeat(64));
    setPublishedKeys(['board:general']);
    assert.equal(needsProfileUpdate(), true);
  });
});

describe('publishAndDeclare', () => {
  beforeEach(() => {
    resetDb();
    mockPublishJSON.mock.resetCalls();
    mockSendTransaction.mock.resetCalls();
    mockPublishJSON.mock.mockImplementation(async () => 'a'.repeat(64));
    mockSendTransaction.mock.mockImplementation(async () => ({
      wait: async () => ({ hash: '0x' + 'ab'.repeat(32), blockNumber: 42 }),
    }));
  });

  it('missing global feed → throws', async () => {
    addBoard('general', { boardId: 'general' });
    // No global feed set

    await assert.rejects(
      () => publishAndDeclare(),
      /global feed not yet created/,
    );

    assert.equal(mockPublishJSON.mock.callCount(), 0);
  });

  it('builds valid profile with correct boardFeeds, globalIndexFeed, publishes, sends tx', async () => {
    addBoard('general', { boardId: 'general' });
    addBoard('tech', { boardId: 'tech' });
    setFeed('board-general', 'cc'.repeat(32));
    setFeed('board-tech', 'dd'.repeat(32));
    setFeed('global', 'ee'.repeat(32));
    setFeed('best-global', 'ff'.repeat(32));
    setFeed('best-board-tech', 'ab'.repeat(32));

    const result = await publishAndDeclare();

    const expectedBzzUrl = `bzz://${'a'.repeat(64)}`;
    assert.equal(result, expectedBzzUrl);

    // Inspect the profile object passed to publishJSON
    const profile = mockPublishJSON.mock.calls[0].arguments[0];
    assert.equal(profile.curator, VALID_ADDRESS);
    assert.equal(profile.name, 'Test Curator');
    assert.equal(profile.description, 'A test curator');
    assert.equal(profile.globalIndexFeed, `bzz://${'ee'.repeat(32)}`);
    assert.equal(profile.boardFeeds.general, `bzz://${'cc'.repeat(32)}`);
    assert.equal(profile.boardFeeds.tech, `bzz://${'dd'.repeat(32)}`);

    // Verify on-chain tx: correct calldata and target contract
    const tx = mockSendTransaction.mock.calls[0].arguments[0];
    const expectedData = declareCuratorIface.encodeFunctionData('declareCurator', [expectedBzzUrl]);
    assert.equal(tx.data, expectedData);
    assert.equal(tx.to, TEST_CONFIG.contractAddress);

    // Verify published profile keys use structured naming
    const published = getPublishedKeys();
    assert.ok(published.has('board:general'));
    assert.ok(published.has('board:tech'));
    assert.ok(published.has('view:best:global'));
    assert.ok(published.has('view:best:board:tech'));
    assert.ok(!published.has('__best-global'));  // no legacy sentinels
  });
});
