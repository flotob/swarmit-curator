/**
 * Swarm client — bee-js wrapper for fetch, publish, and feed operations.
 */

import { Bee, Utils } from '@ethersphere/bee-js';
import { Wallet } from 'ethers';
import config from '../config.js';

const bee = new Bee(config.beeUrl);
const curatorWallet = new Wallet(config.curatorPrivateKey);

// In-memory cache for immutable objects
const cache = new Map();

/**
 * Fetch an immutable JSON object from Swarm by reference.
 * @param {string} ref - bzz:// URL or bare hex
 * @returns {Promise<Object>}
 */
export async function fetchObject(ref) {
  const hex = ref.replace(/^bzz:\/\//, '').trim();
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`Invalid Swarm reference: ${ref}`);
  }

  if (cache.has(hex)) return cache.get(hex);

  const data = await bee.downloadData(hex);
  const obj = JSON.parse(new TextDecoder().decode(data));
  cache.set(hex, obj);
  return obj;
}

/**
 * Publish a JSON object to Swarm.
 * @param {Object} obj
 * @returns {Promise<string>} The reference hex (64 chars)
 */
export async function publishJSON(obj) {
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const result = await bee.uploadData(config.postageBatchId, data, {
    contentType: 'application/json',
    deferred: false,
  });
  return result.reference.toString();
}

/**
 * Create a feed topic from a name string.
 * @param {string} name
 * @returns {string} Topic hex
 */
function makeTopic(name) {
  return bee.makeFeedTopic(name);
}

/**
 * Create a feed and return its manifest reference.
 * Idempotent: same owner + topic = same manifest.
 * @param {string} feedName
 * @returns {Promise<string>} Feed manifest reference hex
 */
export async function createFeedManifest(feedName) {
  const topic = makeTopic(feedName);
  const owner = curatorWallet.address.slice(2); // Remove 0x prefix
  const manifest = await bee.createFeedManifest(config.postageBatchId, 'sequence', topic, owner);
  return manifest.reference.toString();
}

/**
 * Update a feed to point at a new content reference.
 * Signs the feed update with the curator's private key.
 * @param {string} feedName
 * @param {string} contentRef - The immutable reference to point to
 */
export async function updateFeed(feedName, contentRef) {
  const topic = makeTopic(feedName);
  const signer = Utils.makePrivateKeySigner(
    Uint8Array.from(Buffer.from(config.curatorPrivateKey.replace('0x', ''), 'hex'))
  );
  const writer = bee.makeFeedWriter('sequence', topic, signer);
  await writer.upload(config.postageBatchId, contentRef);
}

/**
 * Resolve a feed manifest to its latest content reference.
 * @param {string} feedManifestRef - Feed manifest hex reference
 * @returns {Promise<Object>} The latest JSON object the feed points to
 */
export async function resolveFeed(feedManifestRef) {
  const hex = feedManifestRef.replace(/^bzz:\/\//, '').trim();
  const data = await bee.downloadData(hex);
  return JSON.parse(new TextDecoder().decode(data));
}

/**
 * Get the canonical bzz:// URL for a reference.
 */
export function toBzzUrl(ref) {
  return `bzz://${ref.replace(/^bzz:\/\//, '').toLowerCase()}`;
}
