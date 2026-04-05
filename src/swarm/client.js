/**
 * Swarm client — thin adapter over swarmit-protocol's createBeeClient.
 *
 * Wraps the library's factory-based client in the curator's historical
 * free-function API shape so existing consumers (orchestrator, feed-manager,
 * profile-manager) and test `mock.module(...)` call sites continue to work
 * unchanged. Behavior is equivalent to the library's client.
 */

import { createBeeClient } from 'swarmit-protocol/swarm';
import config from '../config.js';

const bee = createBeeClient({
  beeUrl: config.beeUrl,
  postageBatchId: config.postageBatchId,
  privateKey: config.curatorPrivateKey,
});

export const fetchObject = (ref) => bee.fetchObject(ref);
export const clearCache = () => bee.clearCache();
export const publishJSON = (obj) => bee.publishJSON(obj);
export const createFeedManifest = (feedName) => bee.createFeedManifest(feedName);
export const updateFeed = (feedName, contentRef) => bee.updateFeed(feedName, contentRef);
export const resolveFeed = (feedManifestHex) => bee.resolveFeed(feedManifestHex);
