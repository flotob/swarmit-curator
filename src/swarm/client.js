// Process-wide Bee client; all curator modules share this instance.
// Kept as a module with named exports so tests can `mock.module('../../src/swarm/client.js', ...)`.

import { createBeeClient } from 'swarmit-protocol/swarm';
import { refToHex } from 'swarmit-protocol';
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

// Bee API base with any trailing slash stripped, so URL joins can't double up.
const beeBase = config.beeUrl.replace(/\/+$/, '');

// A stewardship check forces a network retrieval of every chunk in the content
// tree; this bounds a single probe so a hung retrieval can't stall a sweep.
const STEWARDSHIP_TIMEOUT_MS = 30_000;

/**
 * Check whether content is retrievable from the Swarm network.
 *
 * Uses Bee's `GET /stewardship/{ref}` endpoint. Unlike a plain download,
 * stewardship forces a network retrieval of every chunk in the content tree,
 * bypassing this node's local cache — so a cached-but-network-dead object reads
 * as dead. This is the cache-immune liveness signal the pruning sweeps rely on;
 * see docs/liveness-pruning-plan.md.
 *
 * Not part of the shared `createBeeClient` — kept curator-local for now.
 *
 * @param {string} ref - bzz:// URL or bare hex reference
 * @returns {Promise<boolean>} true iff the whole content tree is network-retrievable
 * @throws on invalid ref, transport error, timeout, or non-2xx response. Callers
 *   treat a throw as "could not determine" (the death sweep counts it a strike).
 */
export async function isRetrievable(ref) {
  const hex = refToHex(ref);
  if (!hex) throw new Error(`Invalid Swarm reference: ${ref}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STEWARDSHIP_TIMEOUT_MS);
  try {
    const res = await fetch(`${beeBase}/stewardship/${hex}`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      // Release the socket; an undrained body would linger until GC.
      res.body?.cancel().catch(() => {});
      throw new Error(`stewardship check for ${hex} failed: HTTP ${res.status}`);
    }
    const body = await res.json();
    return body.isRetrievable === true;
  } finally {
    clearTimeout(timer);
  }
}
