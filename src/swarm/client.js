// Process-wide Bee client; all curator modules share this instance.
// Kept as a module with named exports so tests can `mock.module('../../src/swarm/client.js', ...)`.

import { createBeeClient } from 'swarmit-protocol/swarm';
import config from '../config.js';

export const {
  fetchObject,
  clearCache,
  publishJSON,
  createFeedManifest,
  updateFeed,
} = createBeeClient({
  beeUrl: config.beeUrl,
  postageBatchId: config.postageBatchId,
  privateKey: config.curatorPrivateKey,
});
