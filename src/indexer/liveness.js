/**
 * Liveness sweeps — periodically re-check that indexed content is still
 * retrievable from Swarm, pruning submissions that have gone and restoring
 * any that come back. See docs/liveness-pruning-plan.md.
 *
 * Sweeps run on their own scheduler (`startLivenessScheduler`) entirely
 * decoupled from `pollOnce`. They write pruned/restored boards into the
 * republish queue, which the next poll cycle drains. This isolation is
 * load-bearing: probes can stewardship-timeout for up to 30s each, and the
 * event-ingestion loop must never wait for that.
 *
 * Probes within a single sweep run with bounded parallelism — a Bee-friendly
 * worker pool, not unbounded fan-out — so a 48-row sweep finishes in seconds
 * rather than minutes.
 */

import { isRetrievable } from '../swarm/client.js';
import config from '../config.js';
import {
  getMeta, setMeta, inTransaction,
  getLiveSubmissions, getResurrectionCandidates,
  setStrikes, markStale, markLive, markBoardsDirty,
} from './state.js';

/**
 * Run `fn` over `items` with at most `limit` calls in flight. Worker-pool
 * pattern: N workers each pull the next index off a shared counter, so a
 * slow probe doesn't stall the others — fast probes keep finishing while
 * the slow one runs out its timeout.
 */
async function mapWithConcurrency(items, limit, fn) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Probe a content reference. Any error (timeout, transport, non-2xx) is treated
 * as "not retrievable" — a liveness check must never throw out of the sweep.
 */
async function probe(contentRef) {
  try {
    return await isRetrievable(contentRef);
  } catch {
    return false;
  }
}

/**
 * Death sweep — re-check live submissions and prune those that have become
 * unretrievable. A submission is pruned after `livenessStrikeThreshold`
 * consecutive failed checks; one success resets its strike count. Submissions
 * ingested within `livenessIngestGrace` are skipped, since ingestion already
 * verified them.
 *
 * Probes run in parallel (`PROBE_CONCURRENCY`); the strike/mark writes are
 * applied serially afterwards so SQLite never sees concurrent transactions
 * from this sweep.
 *
 * @param {number} [now] - current time in ms (injectable for tests)
 * @returns {Promise<{ changedBoards: Set<string> }>} boards whose live set changed
 */
export async function runDeathSweep(now = Date.now()) {
  const threshold = config.livenessStrikeThreshold;
  const submissions = getLiveSubmissions(now - config.livenessIngestGrace);
  const changedBoards = new Set();
  let pruned = 0;

  const reachable = await mapWithConcurrency(submissions, config.livenessProbeConcurrency,
    (sub) => probe(sub.contentRef));

  // One transaction for the whole batch: collapses N×UPDATE fsyncs into one,
  // and — more importantly — makes each row's strike/markStale pair atomic so
  // a crash mid-loop can't leave a row at the threshold but not yet stale.
  inTransaction(() => {
    for (let i = 0; i < submissions.length; i++) {
      const sub = submissions[i];
      if (reachable[i]) {
        if (sub.unreachableStrikes !== 0) setStrikes(sub.submissionRef, 0);
        continue;
      }
      const strikes = Math.min(sub.unreachableStrikes + 1, threshold);
      setStrikes(sub.submissionRef, strikes);
      if (strikes >= threshold) {
        markStale(sub.submissionRef, now);
        changedBoards.add(sub.boardId);
        pruned += 1;
      }
    }
  });

  if (submissions.length > 0) {
    console.log(`[Liveness] Death sweep: checked ${submissions.length}, pruned ${pruned}`);
  }
  return { changedBoards };
}

/**
 * Resurrection sweep — re-check already-pruned submissions and restore any that
 * are retrievable again. Submissions stale longer than
 * `livenessRecheckGiveUpAfter` are abandoned and skipped (a cutoff of 0 means
 * never give up). Gated on `config.livenessRecheckDead`.
 *
 * @param {number} [now] - current time in ms (injectable for tests)
 * @returns {Promise<{ changedBoards: Set<string> }>} boards whose live set changed
 */
export async function runResurrectionSweep(now = Date.now()) {
  const giveUpAfter = config.livenessRecheckGiveUpAfter;
  const cutoff = giveUpAfter > 0 ? now - giveUpAfter : 0;
  const submissions = getResurrectionCandidates(cutoff);
  const changedBoards = new Set();
  let restored = 0;

  const reachable = await mapWithConcurrency(submissions, config.livenessProbeConcurrency,
    (sub) => probe(sub.contentRef));

  inTransaction(() => {
    for (let i = 0; i < submissions.length; i++) {
      if (!reachable[i]) continue;
      const sub = submissions[i];
      markLive(sub.submissionRef);
      changedBoards.add(sub.boardId);
      restored += 1;
    }
  });

  if (submissions.length > 0) {
    console.log(`[Liveness] Resurrection sweep: checked ${submissions.length}, restored ${restored}`);
  }
  return { changedBoards };
}

/**
 * Run whichever sweeps are due now, persist their timestamps, and post any
 * pruned/restored boards into the republish queue. Single entrypoint used by
 * the scheduler and exposed for direct invocation (e.g. tests).
 */
export async function runLivenessSweeps(now = Date.now()) {
  if (!config.livenessEnabled) return;

  const sweptBoards = new Set();

  if (now - parseInt(getMeta('last_death_sweep_at', '0'), 10) >= config.livenessCheckInterval) {
    const { changedBoards: pruned } = await runDeathSweep(now);
    for (const slug of pruned) sweptBoards.add(slug);
    setMeta('last_death_sweep_at', String(now));
  }

  if (config.livenessRecheckDead
      && now - parseInt(getMeta('last_resurrection_sweep_at', '0'), 10) >= config.livenessRecheckInterval) {
    const { changedBoards: restored } = await runResurrectionSweep(now);
    for (const slug of restored) sweptBoards.add(slug);
    setMeta('last_resurrection_sweep_at', String(now));
  }

  if (sweptBoards.size > 0) markBoardsDirty(sweptBoards);
}

// --- Scheduler --------------------------------------------------------------
//
// The sweep runs on its own timer, decoupled from pollOnce. A singleton guard
// (`inFlight`) makes the tick re-entrant-safe: if a sweep is still running when
// the next tick fires, the tick is a no-op rather than piling sweeps on top of
// each other. The sweep's own internal `last_death_sweep_at` check provides the
// real cadence — the ticker just polls often enough to notice when an interval
// has elapsed.

let inFlight = null;

function tick() {
  if (inFlight) return;
  inFlight = runLivenessSweeps()
    .catch((err) => console.error(`[Liveness] sweep error: ${err.message}`))
    .finally(() => { inFlight = null; });
}

/**
 * Start the background sweep scheduler. Returns the interval handle (used by
 * `stopLivenessScheduler` and tests). No-op when liveness is disabled.
 */
export function startLivenessScheduler() {
  if (!config.livenessEnabled) return null;
  tick(); // run once on boot so a long-overdue sweep doesn't wait a full interval
  return setInterval(tick, config.livenessCheckInterval);
}

/**
 * Stop the scheduler and await the in-flight sweep, if any, so a clean
 * shutdown doesn't tear down the DB while a write is pending.
 */
export async function stopLivenessScheduler(handle) {
  if (handle) clearInterval(handle);
  if (inFlight) await inFlight;
}

export function _resetSchedulerForTest() {
  inFlight = null;
}
