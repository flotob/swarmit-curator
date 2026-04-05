import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Load the real ethers module once so we can pass everything through to
// the mock and only override the network-hitting provider. This keeps the
// mock robust against the library adding new ethers imports (ZeroHash, id, …).
const realEthers = await import('ethers');
const { Interface: RealInterface, getAddress } = realEthers;

// Same ABI as reader.js — kept in sync so topic-hash mismatches catch drift
const ABI = [
  'event BoardRegistered(bytes32 indexed boardId, string slug, string boardRef, address governance)',
  'event BoardMetadataUpdated(bytes32 indexed boardId, string boardRef)',
  'event SubmissionAnnounced(bytes32 indexed boardId, bytes32 indexed submissionId, bytes32 parentSubmissionId, bytes32 rootSubmissionId, address author)',
  'event CuratorDeclared(address indexed curator, string curatorProfileRef)',
  'event VoteSet(bytes32 indexed boardId, bytes32 indexed submissionId, address indexed voter, bytes32 rootSubmissionId, int8 direction, int8 previousDirection, uint64 upvotes, uint64 downvotes)',
];
const testIface = new RealInterface(ABI);

// Real topic hashes computed from the ABI
const TOPICS = {
  BoardRegistered: testIface.getEvent('BoardRegistered').topicHash,
  BoardMetadataUpdated: testIface.getEvent('BoardMetadataUpdated').topicHash,
  SubmissionAnnounced: testIface.getEvent('SubmissionAnnounced').topicHash,
  CuratorDeclared: testIface.getEvent('CuratorDeclared').topicHash,
  VoteSet: testIface.getEvent('VoteSet').topicHash,
};

// --- Mock config and ethers (real Interface, mock Provider) ---

const TEST_CONFIG = {
  rpcUrl: 'http://localhost:8545',
  contractAddress: '0x' + '0'.repeat(40),
  contractDeployBlock: 0,
  confirmations: 12,
  pollInterval: 30000,
  beeUrl: 'http://localhost:1633',
  postageBatchId: '0'.repeat(64),
  curatorPrivateKey: '0x' + '01'.repeat(32),
  curatorAddress: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
  stateFile: '/tmp/test-state.json',
};

mock.module('../../src/config.js', { defaultExport: TEST_CONFIG });

let mockGetBlockNumber = async () => 100;
let mockGetLogs = async () => [];

mock.module('ethers', {
  namedExports: {
    ...realEthers,
    JsonRpcProvider: class MockProvider {
      async getBlockNumber() { return mockGetBlockNumber(); }
      async getLogs(filter) { return mockGetLogs(filter); }
      async getBlock(blockNumber) { return { timestamp: Math.floor(blockNumber * 5 + 1700000000) }; }
    },
  },
});

const { fetchEvents, getSafeBlockNumber } = await import('../../src/chain/reader.js');

// --- Helpers ---

const BYTES32_ZERO = '0x' + '0'.repeat(64);
const BYTES32_A = '0x' + 'aa'.repeat(32);
const BYTES32_B = '0x' + 'bb'.repeat(32);
// Use a checksummed address so assertions match ethers' output
const TEST_ADDR = getAddress('0x' + '11'.repeat(20));

function makeLog(eventName, values, blockNumber = 100, index = 0) {
  // Use real Interface to ABI-encode the event log
  const { data, topics } = testIface.encodeEventLog(eventName, values);
  return { topics, data, blockNumber, index };
}

// --- Tests ---

describe('fetchEvents', () => {
  beforeEach(() => {
    mockGetLogs = async () => [];
  });

  it('empty range (fromBlock > toBlock) returns empty arrays', async () => {
    const result = await fetchEvents(200, 100);
    assert.deepEqual(result, { boards: [], metadataUpdates: [], submissions: [], curators: [], votes: [] });
  });

  it('BoardRegistered decoded correctly', async () => {
    mockGetLogs = async (filter) => {
      if (filter.topics[0] === TOPICS.BoardRegistered) {
        return [makeLog('BoardRegistered',
          [BYTES32_A, 'test-board', 'bzz://ref', TEST_ADDR],
          150, 3,
        )];
      }
      return [];
    };

    const result = await fetchEvents(100, 200);

    assert.equal(result.boards.length, 1);
    assert.equal(result.boards[0].slug, 'test-board');
    assert.equal(result.boards[0].boardId, BYTES32_A);
    assert.equal(result.boards[0].boardRef, 'bzz://ref');
    assert.equal(result.boards[0].governance, TEST_ADDR);
    assert.equal(result.boards[0].blockNumber, 150);
    assert.equal(result.boards[0].logIndex, 3);
  });

  it('BoardMetadataUpdated decoded correctly', async () => {
    mockGetLogs = async (filter) => {
      if (filter.topics[0] === TOPICS.BoardMetadataUpdated) {
        return [makeLog('BoardMetadataUpdated',
          [BYTES32_A, 'bzz://updated-ref'],
          160, 1,
        )];
      }
      return [];
    };

    const result = await fetchEvents(100, 200);

    assert.equal(result.metadataUpdates.length, 1);
    assert.equal(result.metadataUpdates[0].boardId, BYTES32_A);
    assert.equal(result.metadataUpdates[0].boardRef, 'bzz://updated-ref');
    assert.equal(result.metadataUpdates[0].blockNumber, 160);
  });

  it('SubmissionAnnounced with zero parent → null parentSubmissionId, submissionRef derived', async () => {
    mockGetLogs = async (filter) => {
      if (filter.topics[0] === TOPICS.SubmissionAnnounced) {
        return [makeLog('SubmissionAnnounced',
          [BYTES32_A, BYTES32_B, BYTES32_ZERO, BYTES32_B, TEST_ADDR],
          170, 2,
        )];
      }
      return [];
    };

    const result = await fetchEvents(100, 200);

    assert.equal(result.submissions.length, 1);
    assert.equal(result.submissions[0].submissionRef, `bzz://${'bb'.repeat(32)}`);
    assert.equal(result.submissions[0].submissionId, BYTES32_B);
    assert.equal(result.submissions[0].parentSubmissionId, null);
    assert.equal(result.submissions[0].rootSubmissionId, BYTES32_B);
    assert.equal(result.submissions[0].author, TEST_ADDR);
    assert.equal(result.submissions[0].blockNumber, 170);
    assert.equal(result.submissions[0].logIndex, 2);
  });

  it('SubmissionAnnounced with non-zero parent → kept as-is', async () => {
    mockGetLogs = async (filter) => {
      if (filter.topics[0] === TOPICS.SubmissionAnnounced) {
        return [makeLog('SubmissionAnnounced',
          [BYTES32_A, BYTES32_B, BYTES32_A, BYTES32_A, TEST_ADDR],
        )];
      }
      return [];
    };

    const result = await fetchEvents(100, 200);

    assert.equal(result.submissions[0].parentSubmissionId, BYTES32_A);
  });

  it('VoteSet decoded correctly with numeric normalization', async () => {
    mockGetLogs = async (filter) => {
      if (filter.topics[0] === TOPICS.VoteSet) {
        return [makeLog('VoteSet',
          [BYTES32_A, BYTES32_B, TEST_ADDR, BYTES32_A, 1, 0, 5, 2],
          200, 7,
        )];
      }
      return [];
    };

    const result = await fetchEvents(100, 200);

    assert.equal(result.votes.length, 1);
    assert.equal(result.votes[0].boardId, BYTES32_A);
    assert.equal(result.votes[0].submissionId, BYTES32_B);
    assert.equal(result.votes[0].submissionRef, `bzz://${'bb'.repeat(32)}`);
    assert.equal(result.votes[0].voter, TEST_ADDR);
    assert.equal(result.votes[0].rootSubmissionId, BYTES32_A);
    assert.equal(result.votes[0].direction, 1);
    assert.equal(result.votes[0].previousDirection, 0);
    assert.equal(result.votes[0].upvotes, 5);
    assert.equal(result.votes[0].downvotes, 2);
    assert.equal(result.votes[0].blockNumber, 200);
    assert.equal(result.votes[0].logIndex, 7);
    // Verify numeric types (not BigInt)
    assert.equal(typeof result.votes[0].direction, 'number');
    assert.equal(typeof result.votes[0].upvotes, 'number');
  });

  it('CuratorDeclared decoded correctly', async () => {
    mockGetLogs = async (filter) => {
      if (filter.topics[0] === TOPICS.CuratorDeclared) {
        return [makeLog('CuratorDeclared',
          [TEST_ADDR, 'bzz://profile-ref'],
          180, 5,
        )];
      }
      return [];
    };

    const result = await fetchEvents(100, 200);

    assert.equal(result.curators.length, 1);
    assert.equal(result.curators[0].curator, TEST_ADDR);
    assert.equal(result.curators[0].curatorProfileRef, 'bzz://profile-ref');
    assert.equal(result.curators[0].blockNumber, 180);
    assert.equal(result.curators[0].logIndex, 5);
  });
});

describe('getSafeBlockNumber', () => {
  it('applies confirmation depth (latest - confirmations)', async () => {
    mockGetBlockNumber = async () => 1000;
    const safe = await getSafeBlockNumber();
    assert.equal(safe, 1000 - TEST_CONFIG.confirmations);
  });

  it('returns 0 when latest < confirmations', async () => {
    mockGetBlockNumber = async () => 5;
    const safe = await getSafeBlockNumber();
    assert.equal(safe, 0);
  });
});
