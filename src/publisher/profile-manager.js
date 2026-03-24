/**
 * Profile manager — builds, publishes, and declares curatorProfile on-chain.
 * curatorProfile is immutable in v1: adding a board means a new object + fresh CuratorDeclared.
 */

import { Wallet, JsonRpcProvider, Interface } from 'ethers';
import config from '../config.js';
import { publishJSON } from '../swarm/client.js';
import { hexToBzz } from '../protocol/references.js';
import { buildCuratorProfile, validate } from '../protocol/objects.js';
import { getBoards, getFeed, getPublishedBoardSlugs, setPublishedBoardSlugs } from '../indexer/state.js';
import { getFeedBzzUrl } from './feed-manager.js';

const ABI = ['function declareCurator(string curatorProfileRef)'];
const iface = new Interface(ABI);
const provider = new JsonRpcProvider(config.rpcUrl);
const wallet = new Wallet(config.curatorPrivateKey, provider);

/**
 * Check if the curator profile needs to be re-published.
 * Returns true if new boards have been added since last publish.
 */
export function needsProfileUpdate() {
  const published = getPublishedBoardSlugs();
  for (const [slug] of getBoards()) {
    if (!published.has(slug)) return true;
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
  for (const [slug] of getBoards()) {
    const feedUrl = getFeedBzzUrl(`board-${slug}`);
    if (feedUrl) boardFeeds[slug] = feedUrl;
  }

  const globalFeedUrl = getFeedBzzUrl('global');
  if (!globalFeedUrl) {
    throw new Error('Cannot publish curatorProfile: global feed not yet created');
  }

  const profile = buildCuratorProfile({
    curator: config.curatorAddress,
    name: config.curatorName,
    description: config.curatorDescription,
    globalIndexFeed: globalFeedUrl,
    boardFeeds,
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

  // Track which boards are in this profile
  setPublishedBoardSlugs([...getBoards().keys()]);

  return bzzUrl;
}
