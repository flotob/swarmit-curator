/**
 * Swarm client — bee-js v11 wrapper for fetch, publish, and feed operations.
 */

import { Bee, Topic, PrivateKey } from '@ethersphere/bee-js';
import config from '../config.js';
import { refToHex, hexToBzz } from '../protocol/references.js';

const bee = new Bee(config.beeUrl);
const curatorSigner = new PrivateKey(config.curatorPrivateKey.replace(/^0x/, ''));

// In-memory cache for immutable objects — cleared after each poll loop
const cache = new Map();

/**
 * Fetch an immutable JSON object from Swarm by reference.
 * @param {string} ref - bzz:// URL or bare hex
 * @returns {Promise<Object>}
 */
export async function fetchObject(ref) {
  const hex = refToHex(ref);
  if (!hex) throw new Error(`Invalid Swarm reference: ${ref}`);

  if (cache.has(hex)) return cache.get(hex);

  const data = await bee.downloadData(hex);
  const obj = JSON.parse(new TextDecoder().decode(data));
  cache.set(hex, obj);
  return obj;
}

/**
 * Clear the fetch cache. Call after each poll loop iteration.
 */
export function clearCache() {
  cache.clear();
}

/**
 * Publish a JSON object to Swarm.
 * @param {Object} obj
 * @returns {Promise<string>} The reference hex (64 chars)
 */
export async function publishJSON(obj) {
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const result = await bee.uploadData(config.postageBatchId, data, {
    deferred: false,
  });
  return result.reference.toString();
}

/**
 * Create a feed manifest and return its reference.
 * Idempotent: same owner + topic = same manifest.
 * @param {string} feedName
 * @returns {Promise<string>} Feed manifest reference hex
 */
export async function createFeedManifest(feedName) {
  const topic = Topic.fromString(feedName);
  const owner = config.curatorAddress;
  const result = await bee.createFeedManifest(config.postageBatchId, topic, owner);
  return result.toString();
}

/**
 * Update a feed to point at a new content reference.
 * Signs the feed update with the curator's private key.
 * @param {string} feedName
 * @param {string} contentRef - The immutable reference hex to point to
 */
export async function updateFeed(feedName, contentRef) {
  const topic = Topic.fromString(feedName);
  const writer = bee.makeFeedWriter(topic, curatorSigner);
  await writer.uploadReference(config.postageBatchId, contentRef);
}

/**
 * Resolve a feed manifest to its latest content as JSON.
 * @param {string} feedManifestRef - Feed manifest hex reference
 * @returns {Promise<Object>} The latest JSON object the feed points to
 */
export async function resolveFeed(feedManifestRef) {
  const hex = refToHex(feedManifestRef);
  if (!hex) throw new Error(`Invalid feed manifest reference: ${feedManifestRef}`);
  const data = await bee.downloadData(hex);
  return JSON.parse(new TextDecoder().decode(data));
}
