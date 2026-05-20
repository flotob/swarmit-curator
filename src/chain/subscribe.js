/**
 * WebSocket subscription to curator contract events. When a matching log
 * arrives, wake() cuts short any in-progress poll-loop sleep so the curator
 * reacts to new posts/votes without waiting POLL_INTERVAL.
 *
 * HTTP `RPC_URL` remains the authoritative data path for getSafeBlockNumber /
 * fetchEvents — the WS connection here is purely a wake signal. That keeps the
 * design backward-compatible: if `WSS_RPC_URL` is unset (or the WS connection
 * drops), the curator silently falls back to plain interval polling.
 */

import { WebSocketProvider } from 'ethers';
import config from '../config.js';
import { TOPICS } from 'swarmit-protocol/chain';

const EVENT_TOPICS = [
  TOPICS.BoardRegistered,
  TOPICS.BoardMetadataUpdated,
  TOPICS.SubmissionAnnounced,
  TOPICS.CuratorDeclared,
  TOPICS.VoteSet,
];

let wsProvider = null;
let pendingResolve = null;
// True iff a wake() arrived while no sleepInterruptible was in progress. The
// next sleep consumes it and returns immediately, so a WS event that lands
// between two sleeps doesn't get swallowed.
let wakePending = false;

/**
 * Sleep until `ms` elapses OR wake() is called, whichever comes first. If a
 * wake() arrived since the last sleep, this returns immediately and clears the
 * pending wake.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleepInterruptible(ms) {
  if (wakePending) {
    wakePending = false;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    pendingResolve = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

/**
 * Interrupt any in-progress sleepInterruptible. If nothing is sleeping the
 * wake is remembered (idempotently) and consumed by the next sleep, so a WS
 * event arriving mid-poll isn't lost.
 */
export function wake() {
  if (pendingResolve) {
    const f = pendingResolve;
    pendingResolve = null;
    f();
    return;
  }
  wakePending = true;
}

/** Test-only — reset wake state between tests so each starts clean. */
export function _resetForTest() {
  pendingResolve = null;
  wakePending = false;
}

/**
 * Subscribe to the curator contract's event logs over WebSocket. Each matching
 * log triggers wake().
 *
 * @returns {boolean} true if a subscription was set up, false if WSS_RPC_URL is
 *   unset and the loop should fall back to plain interval polling.
 */
export function startEventSubscription() {
  if (!config.wssRpcUrl) {
    console.log('[Chain] WSS_RPC_URL not set — event-driven wake disabled, polling only');
    return false;
  }
  wsProvider = new WebSocketProvider(config.wssRpcUrl);
  // topics[0] = logical-OR of the five curator event signature hashes.
  const filter = {
    address: config.contractAddress,
    topics: [EVENT_TOPICS],
  };
  wsProvider.on(filter, (log) => {
    console.log(`[Chain] WS log block ${log.blockNumber} tx ${log.transactionHash?.slice(0, 14)}…`);
    wake();
  });
  // Surface drops so the operator knows the low-latency path stopped working.
  // Reconnect logic isn't implemented — the curator falls back to interval
  // polling and waits for the next deploy/restart to re-subscribe.
  wsProvider.on('error', (err) => {
    console.error(`[Chain] WS provider error: ${err?.message ?? err}`);
  });
  const host = wsHostFor(config.wssRpcUrl);
  console.log(`[Chain] Subscribed to curator events via WS (${host})`);
  return true;
}

function wsHostFor(url) {
  try { return new URL(url).host; } catch { return url; }
}

export async function stopEventSubscription() {
  if (!wsProvider) return;
  try {
    await wsProvider.destroy();
  } catch (err) {
    console.error(`[Chain] Error closing WS provider: ${err.message}`);
  }
  wsProvider = null;
}
