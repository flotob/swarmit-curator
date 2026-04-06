/**
 * Profile manager — builds, publishes to a stable feed, and ensures
 * on-chain declaration points at the feed manifest.
 *
 * The curator profile is published to a Swarm feed (topic: CURATOR_PROFILE_FEED_NAME).
 * The on-chain CuratorDeclared event points at the feed manifest ref, not an
 * immutable content ref. Declaration happens once (or on migration); profile
 * updates are feed writes only — no gas, no chain churn.
 */

import { Wallet, JsonRpcProvider, zeroPadValue } from 'ethers';
import config from '../config.js';
import {
  buildCuratorProfile, validate,
  RECOMMENDED_RANKED_VIEW_NAMES,
  CURATOR_PROFILE_FEED_NAME,
} from 'swarmit-protocol';
import { iface, TOPICS, encode } from 'swarmit-protocol/chain';
import { getMeta, setMeta, getAllBoards } from '../indexer/state.js';
import { publishAndUpdateFeed, getFeedBzzUrl } from './feed-manager.js';

const provider = new JsonRpcProvider(config.rpcUrl);
const wallet = new Wallet(config.curatorPrivateKey, provider);

// --- Profile building ---

/**
 * Build the current curatorProfile from state. Pure function — no I/O.
 * Throws if no global feed exists yet (nothing to publish).
 * @returns {Object} Validated curatorProfile object
 */
export function buildProfile() {
  const boardFeeds = {};
  for (const { slug } of getAllBoards()) {
    const hotUrl = getFeedBzzUrl(`hot-board-${slug}`);
    const defaultUrl = hotUrl || getFeedBzzUrl(`board-${slug}`);
    if (defaultUrl) boardFeeds[slug] = defaultUrl;
  }

  const hotGlobalUrl = getFeedBzzUrl('hot-global');
  const chronologicalGlobalUrl = getFeedBzzUrl('global');
  const globalIndexFeed = hotGlobalUrl || chronologicalGlobalUrl;
  if (!globalIndexFeed) {
    throw new Error('Cannot build curatorProfile: no global feed yet created');
  }

  const globalViewFeeds = {};
  globalViewFeeds.new = chronologicalGlobalUrl;
  for (const view of RECOMMENDED_RANKED_VIEW_NAMES) {
    const url = getFeedBzzUrl(`${view}-global`);
    if (url) globalViewFeeds[view] = url;
  }

  const boardViewFeeds = {};
  for (const slug of Object.keys(boardFeeds)) {
    const views = {};
    views.new = getFeedBzzUrl(`board-${slug}`);
    for (const view of RECOMMENDED_RANKED_VIEW_NAMES) {
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

  return profile;
}

// --- Change detection ---

/**
 * Check if the curator profile content has changed since the last publish.
 * Uses JSON.stringify as a stable signature — the profile has no timestamps,
 * so identical logical content produces identical strings.
 */
export function needsProfileUpdate() {
  try {
    const profile = buildProfile();
    const currentSig = JSON.stringify(profile);
    const lastSig = getMeta('last_profile_signature', null);
    return currentSig !== lastSig;
  } catch {
    return false; // no global feed yet — nothing to publish
  }
}

// --- Feed publication ---

/**
 * Publish the current profile to the stable curator profile feed.
 * Uses the same feed machinery as board/global/thread feeds.
 * @returns {Promise<string>} Profile feed manifest bzz:// URL
 */
export async function publishProfileToFeed() {
  const profile = buildProfile();

  await publishAndUpdateFeed(CURATOR_PROFILE_FEED_NAME, profile, 'curatorProfile');

  setMeta('last_profile_signature', JSON.stringify(profile));
  console.log(`[Profile] Updated profile feed`);

  return getFeedBzzUrl(CURATOR_PROFILE_FEED_NAME);
}

// --- On-chain declaration ---

/**
 * Query the chain for this curator's latest CuratorDeclared event.
 * @returns {Promise<string|null>} The curatorProfileRef from the latest declaration, or null
 */
async function getLatestOwnDeclaration() {
  // Check cached declaration first — avoids an RPC round-trip on every publish cycle.
  const cached = getMeta('last_declared_ref', null);
  if (cached) return cached;

  const fromHex = '0x' + config.contractDeployBlock.toString(16);
  const curatorTopic = zeroPadValue(config.curatorAddress, 32);

  const logs = await provider.getLogs({
    address: config.contractAddress,
    topics: [TOPICS.CuratorDeclared, curatorTopic],
    fromBlock: fromHex,
    toBlock: 'latest',
  });

  if (logs.length === 0) return null;

  const last = logs[logs.length - 1];
  const parsed = iface.parseLog({ topics: last.topics, data: last.data });
  const ref = parsed.args.curatorProfileRef;

  // Cache so subsequent calls skip the RPC.
  setMeta('last_declared_ref', ref);
  return ref;
}

/**
 * Ensure the on-chain CuratorDeclared event points at the current profile
 * feed manifest. Sends a tx only if the declaration is missing or stale.
 */
export async function ensureDeclared() {
  const feedBzzUrl = getFeedBzzUrl(CURATOR_PROFILE_FEED_NAME);
  if (!feedBzzUrl) {
    throw new Error('Cannot ensure declaration: profile feed not yet created');
  }

  const latestDeclared = await getLatestOwnDeclaration();

  if (latestDeclared === feedBzzUrl) {
    console.log(`[Profile] Declaration already points at profile feed, skipping tx`);
    return;
  }

  const data = encode.declareCurator({ curatorProfileRef: feedBzzUrl });
  const tx = await wallet.sendTransaction({
    to: config.contractAddress,
    data,
  });
  const receipt = await tx.wait();
  console.log(`[Profile] CuratorDeclared tx: ${receipt.hash} (block ${receipt.blockNumber})`);

  // Update cache so the next ensureDeclared() call skips the RPC.
  setMeta('last_declared_ref', feedBzzUrl);
}
