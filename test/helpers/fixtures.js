/**
 * Shared test fixtures used by all test packages.
 */

import { TYPES } from 'swarmit-protocol';

// --- Valid hex references (64-char) ---
export const VALID_HEX = 'a'.repeat(64);
export const VALID_HEX_2 = 'b'.repeat(64);
export const VALID_HEX_3 = 'c'.repeat(64);
export const VALID_HEX_UPPER = 'A'.repeat(64);
export const VALID_HEX_MIXED = 'aAbBcCdD' + 'e'.repeat(56);

export const VALID_BZZ = `bzz://${VALID_HEX}`;
export const VALID_BZZ_2 = `bzz://${VALID_HEX_2}`;
export const VALID_BZZ_3 = `bzz://${VALID_HEX_3}`;

export const INVALID_HEX_SHORT = 'a'.repeat(63);
export const INVALID_HEX_LONG = 'a'.repeat(65);
export const INVALID_HEX_NONHEX = 'g'.repeat(64);
export const INVALID_BZZ_PATH = `bzz://${VALID_HEX}/path`;
export const INVALID_BZZ_UPPER = `bzz://${'A'.repeat(64)}`;

// --- Ethereum addresses ---
export const VALID_ADDRESS = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
export const VALID_ADDRESS_2 = '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF';

// --- Composite helpers ---
export const validAuthor = () => ({
  address: VALID_ADDRESS,
  userFeed: VALID_BZZ,
});

export const validBody = () => ({
  kind: 'markdown',
  text: 'Hello, world!',
});

// --- Known board slugs ---
export const BOARD_SLUGS = new Set(['general', 'tech', 'random']);

// --- Pre-built valid protocol objects (factory functions to avoid shared mutation) ---

export const validBoard = () => ({
  protocol: TYPES.BOARD,
  boardId: 'general',
  slug: 'general',
  title: 'General Discussion',
  description: 'A board for general topics',
  createdAt: Date.now(),
  governance: { type: 'open' },
});

export const validPost = () => ({
  protocol: TYPES.POST,
  author: validAuthor(),
  title: 'Test Post',
  body: validBody(),
  createdAt: Date.now(),
});

export const validReply = () => ({
  protocol: TYPES.REPLY,
  author: validAuthor(),
  body: validBody(),
  createdAt: Date.now(),
});

export const validSubmissionPost = () => ({
  protocol: TYPES.SUBMISSION,
  boardId: 'general',
  kind: 'post',
  contentRef: VALID_BZZ,
  author: validAuthor(),
  createdAt: Date.now(),
});

export const validSubmissionReply = () => ({
  protocol: TYPES.SUBMISSION,
  boardId: 'general',
  kind: 'reply',
  contentRef: VALID_BZZ,
  author: validAuthor(),
  parentSubmissionId: VALID_BZZ_2,
  rootSubmissionId: VALID_BZZ_3,
  createdAt: Date.now(),
});

export const validUserFeedIndex = () => ({
  protocol: TYPES.USER_FEED,
  author: VALID_ADDRESS,
  updatedAt: Date.now(),
  entries: [],
});

export const validBoardIndex = () => ({
  protocol: TYPES.BOARD_INDEX,
  boardId: 'general',
  curator: VALID_ADDRESS,
  updatedAt: Date.now(),
  entries: [],
});

export const validThreadIndex = () => ({
  protocol: TYPES.THREAD_INDEX,
  rootSubmissionId: VALID_BZZ,
  curator: VALID_ADDRESS,
  updatedAt: Date.now(),
  nodes: [],
});

export const validGlobalIndex = () => ({
  protocol: TYPES.GLOBAL_INDEX,
  curator: VALID_ADDRESS,
  updatedAt: Date.now(),
  entries: [],
});

export const validCuratorProfile = () => ({
  protocol: TYPES.CURATOR,
  curator: VALID_ADDRESS,
  name: 'Test Curator',
  description: 'A test curator',
  globalIndexFeed: VALID_BZZ,
});

// --- Chain event-like objects ---
export const chainEvent = (blockNumber, logIndex = 0) => ({
  blockNumber,
  logIndex,
});

// --- Helper to generate unique bzz refs ---
export const bzz = (hex) => `bzz://${hex.padEnd(64, '0')}`;

// --- Test environment setup for modules that depend on config.js ---
export function setupTestEnv() {
  process.env.RPC_URL = 'http://localhost:8545';
  process.env.CONTRACT_ADDRESS = '0x' + '0'.repeat(40);
  process.env.CONTRACT_DEPLOY_BLOCK = '0';
  process.env.BEE_URL = 'http://localhost:1633';
  process.env.POSTAGE_BATCH_ID = '0'.repeat(64);
  process.env.CURATOR_PRIVATE_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001';
  process.env.STATE_FILE = '/tmp/swarmit-curator-test-state.json';
}
