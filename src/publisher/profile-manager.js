/**
 * Profile manager — builds, publishes, and declares curatorProfile on-chain.
 * curatorProfile is immutable in v1: adding a board means a new object + fresh CuratorDeclared.
 */

import { Wallet, JsonRpcProvider } from 'ethers';
import config from '../config.js';
import { publishJSON } from '../swarm/client.js';
import { hexToBzz, buildCuratorProfile, validate } from 'swarmit-protocol';
import { encode } from 'swarmit-protocol/chain';
import { getAllBoards, getPublishedKeys, setPublishedKeys } from '../indexer/state.js';
import { getFeedBzzUrl } from './feed-manager.js';

const provider = new JsonRpcProvider(config.rpcUrl);
const wallet = new Wallet(config.curatorPrivateKey, provider);

const VIEW_NAMES = ['best', 'hot', 'rising', 'controversial'];

/**
 * Check if the curator profile needs to be re-published.
 */
export function needsProfileUpdate() {
  const published = getPublishedKeys();

  for (const view of VIEW_NAMES) {
    if (getFeedBzzUrl(`${view}-global`) && !published.has(`view:${view}:global`)) return true;
  }

  for (const { slug } of getAllBoards()) {
    if (!published.has(`board:${slug}`) && getFeedBzzUrl(`board-${slug}`)) return true;
    for (const view of VIEW_NAMES) {
      if (getFeedBzzUrl(`${view}-board-${slug}`) && !published.has(`view:${view}:board:${slug}`)) return true;
    }
  }

  return false;
}

/**
 * Build, validate, publish curatorProfile, and emit CuratorDeclared on-chain.
 * Default feed = hot. Named views expose all 5 sort orders.
 * @returns {Promise<string>} The published curatorProfile bzz:// ref
 */
export async function publishAndDeclare() {
  // Board feeds: default = hot, fallback to chronological
  const boardFeeds = {};
  for (const { slug } of getAllBoards()) {
    const hotUrl = getFeedBzzUrl(`hot-board-${slug}`);
    const defaultUrl = hotUrl || getFeedBzzUrl(`board-${slug}`);
    if (defaultUrl) boardFeeds[slug] = defaultUrl;
  }

  // Global feed: default = hot, fallback to chronological
  const hotGlobalUrl = getFeedBzzUrl('hot-global');
  const chronologicalGlobalUrl = getFeedBzzUrl('global');
  const globalIndexFeed = hotGlobalUrl || chronologicalGlobalUrl;
  if (!globalIndexFeed) {
    throw new Error('Cannot publish curatorProfile: no global feed yet created');
  }

  // Named views — all 5 sort orders
  const globalViewFeeds = {};
  globalViewFeeds.new = chronologicalGlobalUrl;
  for (const view of VIEW_NAMES) {
    const url = getFeedBzzUrl(`${view}-global`);
    if (url) globalViewFeeds[view] = url;
  }

  const boardViewFeeds = {};
  for (const slug of Object.keys(boardFeeds)) {
    const views = {};
    views.new = getFeedBzzUrl(`board-${slug}`);
    for (const view of VIEW_NAMES) {
      const url = getFeedBzzUrl(`${view}-board-${slug}`);
      if (url) views[view] = url;
    }
    boardViewFeeds[slug] = views;
  }

  const profile = buildCuratorProfile({
    curator: config.curatorAddress,
    name: config.curatorName,
    description: config.curatorDescription,
    globalIndexFeed,
    boardFeeds,
    globalViewFeeds,
    boardViewFeeds,
  });

  const result = validate(profile);
  if (!result.valid) {
    throw new Error(`curatorProfile validation failed: ${result.errors.join(', ')}`);
  }

  const contentRef = await publishJSON(profile);
  const bzzUrl = hexToBzz(contentRef);
  console.log(`[Profile] Published curatorProfile: ${bzzUrl}`);

  // Emit CuratorDeclared on-chain
  const data = encode.declareCurator({ curatorProfileRef: bzzUrl });
  const tx = await wallet.sendTransaction({
    to: config.contractAddress,
    data,
  });
  const receipt = await tx.wait();
  console.log(`[Profile] CuratorDeclared tx: ${receipt.hash} (block ${receipt.blockNumber})`);

  // Track boards + all named-view markers that appear in this profile
  const publishedKeys = Object.keys(boardFeeds).map((slug) => `board:${slug}`);
  for (const view of VIEW_NAMES) {
    if (globalViewFeeds[view]) publishedKeys.push(`view:${view}:global`);
    for (const slug of Object.keys(boardViewFeeds)) {
      if (boardViewFeeds[slug][view]) publishedKeys.push(`view:${view}:board:${slug}`);
    }
  }
  setPublishedKeys(publishedKeys);

  return bzzUrl;
}
