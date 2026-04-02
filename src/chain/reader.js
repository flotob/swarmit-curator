/**
 * Chain event reader — polls Gnosis Chain for protocol events.
 * Uses confirmation depth to handle reorgs.
 */

import { JsonRpcProvider, Interface } from 'ethers';
import config from '../config.js';
import { bytes32ToRef } from '../protocol/references.js';

const ABI = [
  'event BoardRegistered(bytes32 indexed boardId, string slug, string boardRef, address governance)',
  'event BoardMetadataUpdated(bytes32 indexed boardId, string boardRef)',
  'event SubmissionAnnounced(bytes32 indexed boardId, bytes32 indexed submissionId, bytes32 parentSubmissionId, bytes32 rootSubmissionId, address author)',
  'event CuratorDeclared(address indexed curator, string curatorProfileRef)',
  'event VoteSet(bytes32 indexed boardId, bytes32 indexed submissionId, address indexed voter, bytes32 rootSubmissionId, int8 direction, int8 previousDirection, uint64 upvotes, uint64 downvotes)',
];

const iface = new Interface(ABI);

const TOPICS = {
  BoardRegistered: iface.getEvent('BoardRegistered').topicHash,
  BoardMetadataUpdated: iface.getEvent('BoardMetadataUpdated').topicHash,
  SubmissionAnnounced: iface.getEvent('SubmissionAnnounced').topicHash,
  CuratorDeclared: iface.getEvent('CuratorDeclared').topicHash,
  VoteSet: iface.getEvent('VoteSet').topicHash,
};

const BYTES32_ZERO = '0x' + '0'.repeat(64);

const provider = new JsonRpcProvider(config.rpcUrl);

/**
 * Get the latest safe block number (latest minus confirmations).
 */
export async function getSafeBlockNumber() {
  const latest = await provider.getBlockNumber();
  return Math.max(0, latest - config.confirmations);
}

/**
 * Fetch and decode all protocol events in a block range.
 * @param {number} fromBlock
 * @param {number} toBlock
 * @returns {Promise<{ boards: Array, metadataUpdates: Array, submissions: Array, curators: Array, votes: Array }>}
 */
export async function fetchEvents(fromBlock, toBlock) {
  if (fromBlock > toBlock) {
    return { boards: [], metadataUpdates: [], submissions: [], curators: [], votes: [] };
  }

  const fromHex = '0x' + fromBlock.toString(16);
  const toHex = '0x' + toBlock.toString(16);

  // Fetch all 5 event types in parallel
  const [boardLogs, metaLogs, subLogs, curatorLogs, voteLogs] = await Promise.all([
    provider.getLogs({ address: config.contractAddress, topics: [TOPICS.BoardRegistered], fromBlock: fromHex, toBlock: toHex }),
    provider.getLogs({ address: config.contractAddress, topics: [TOPICS.BoardMetadataUpdated], fromBlock: fromHex, toBlock: toHex }),
    provider.getLogs({ address: config.contractAddress, topics: [TOPICS.SubmissionAnnounced], fromBlock: fromHex, toBlock: toHex }),
    provider.getLogs({ address: config.contractAddress, topics: [TOPICS.CuratorDeclared], fromBlock: fromHex, toBlock: toHex }),
    provider.getLogs({ address: config.contractAddress, topics: [TOPICS.VoteSet], fromBlock: fromHex, toBlock: toHex }),
  ]);

  const boards = boardLogs.map((log) => {
    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
    return {
      boardId: parsed.args.boardId,
      slug: parsed.args.slug,
      boardRef: parsed.args.boardRef,
      governance: parsed.args.governance,
      blockNumber: log.blockNumber,
      logIndex: log.index,
    };
  });

  const metadataUpdates = metaLogs.map((log) => {
    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
    return {
      boardId: parsed.args.boardId,
      boardRef: parsed.args.boardRef,
      blockNumber: log.blockNumber,
      logIndex: log.index,
    };
  });

  const submissions = subLogs.map((log) => {
    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
    const parentId = parsed.args.parentSubmissionId;
    const rootId = parsed.args.rootSubmissionId;
    return {
      boardId: parsed.args.boardId,
      submissionId: parsed.args.submissionId,
      submissionRef: bytes32ToRef(parsed.args.submissionId),
      parentSubmissionId: parentId === BYTES32_ZERO ? null : parentId,
      rootSubmissionId: rootId,
      author: parsed.args.author,
      blockNumber: log.blockNumber,
      logIndex: log.index,
    };
  });

  const curators = curatorLogs.map((log) => {
    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
    return {
      curator: parsed.args.curator,
      curatorProfileRef: parsed.args.curatorProfileRef,
      blockNumber: log.blockNumber,
      logIndex: log.index,
    };
  });

  const votes = voteLogs.map((log) => {
    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
    return {
      boardId: parsed.args.boardId,
      submissionId: parsed.args.submissionId,
      submissionRef: bytes32ToRef(parsed.args.submissionId),
      voter: parsed.args.voter,
      rootSubmissionId: parsed.args.rootSubmissionId,
      direction: Number(parsed.args.direction),
      previousDirection: Number(parsed.args.previousDirection),
      upvotes: Number(parsed.args.upvotes),
      downvotes: Number(parsed.args.downvotes),
      blockNumber: log.blockNumber,
      logIndex: log.index,
    };
  });

  return { boards, metadataUpdates, submissions, curators, votes };
}
