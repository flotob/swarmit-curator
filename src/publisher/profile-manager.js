/**
 * Profile manager — builds, publishes, and declares curatorProfile on-chain.
 * curatorProfile is immutable in v1: adding a board means a new object + fresh CuratorDeclared.
 */

import { Wallet, JsonRpcProvider, Interface } from 'ethers';
import config from '../config.js';
import { publishJSON } from '../swarm/client.js';
import { hexToBzz } from '../protocol/references.js';
import { buildCuratorProfile, validate } from '../protocol/objects.js';
import { getAllBoards, getPublishedKeys, setPublishedKeys } from '../indexer/state.js';
import { getFeedBzzUrl } from './feed-manager.js';

const ABI = ['function declareCurator(string curatorProfileRef)'];
const iface = new Interface(ABI);
const provider = new JsonRpcProvider(config.rpcUrl);
const wallet = new Wallet(config.curatorPrivateKey, provider);

/**
 * Check if the curator profile needs to be re-published.
 * Returns true if there are boards with existing feeds that aren't in the published profile yet.
 * Boards without feeds (no submissions yet) are skipped — no point publishing a profile
 * for a board that has no data, and doing so would cause a runaway republish loop.
 */
export function needsProfileUpdate() {
  const published = getPublishedKeys();
  if (getFeedBzzUrl('best-global') && !published.has('view:best:global')) return true;
  for (const { slug } of getAllBoards()) {
    if (!published.has(`board:${slug}`) && getFeedBzzUrl(`board-${slug}`)) return true;
    if (getFeedBzzUrl(`best-board-${slug}`) && !published.has(`view:best:board:${slug}`)) return true;
  }
  return false;
}

/**
 * Build, validate, publish curatorProfile, and emit CuratorDeclared on-chain.
 * @returns {Promise<string>} The published curatorProfile bzz:// ref
 */
export async function publishAndDeclare() {
  // Build boardFeeds map: slug → feed manifest bzz:// URL
  const boardFeeds = {};
  for (const { slug } of getAllBoards()) {
    const feedUrl = getFeedBzzUrl(`board-${slug}`);
    if (feedUrl) boardFeeds[slug] = feedUrl;
  }

  const globalFeedUrl = getFeedBzzUrl('global');
  if (!globalFeedUrl) {
    throw new Error('Cannot publish curatorProfile: global feed not yet created');
  }

  // Build named-view feed maps
  const globalViewFeeds = {};
  globalViewFeeds.new = globalFeedUrl; // alias: new = default chronological
  const bestGlobalUrl = getFeedBzzUrl('best-global');
  if (bestGlobalUrl) globalViewFeeds.best = bestGlobalUrl;

  const boardViewFeeds = {};
  for (const slug of Object.keys(boardFeeds)) {
    const views = {};
    views.new = boardFeeds[slug]; // alias: new = default chronological
    const bestBoardUrl = getFeedBzzUrl(`best-board-${slug}`);
    if (bestBoardUrl) views.best = bestBoardUrl;
    boardViewFeeds[slug] = views;
  }

  const profile = buildCuratorProfile({
    curator: config.curatorAddress,
    name: config.curatorName,
    description: config.curatorDescription,
    globalIndexFeed: globalFeedUrl,
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
  const data = iface.encodeFunctionData('declareCurator', [bzzUrl]);
  const tx = await wallet.sendTransaction({
    to: config.contractAddress,
    data,
  });
  const receipt = await tx.wait();
  console.log(`[Profile] CuratorDeclared tx: ${receipt.hash} (block ${receipt.blockNumber})`);

  // Track boards + named-view markers that appear in this profile
  const publishedKeys = Object.keys(boardFeeds).map((slug) => `board:${slug}`);
  if (globalViewFeeds.best) publishedKeys.push('view:best:global');
  for (const slug of Object.keys(boardViewFeeds)) {
    if (boardViewFeeds[slug].best) publishedKeys.push(`view:best:board:${slug}`);
  }
  setPublishedKeys(publishedKeys);

  return bzzUrl;
}
