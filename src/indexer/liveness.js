/**
 * Liveness sweeps — periodically re-check that indexed content is still
 * retrievable from Swarm, pruning submissions that have gone and restoring
 * any that come back. See docs/liveness-pruning-plan.md.
 *
 * Both sweeps return the set of board slugs whose live set changed, so the
 * caller can republish the affected feeds.
 */

import { isRetrievable } from '../swarm/client.js';
import config from '../config.js';
import {
  getLiveSubmissions, getResurrectionCandidates,
  setStrikes, markStale, markLive,
} from './state.js';

/**
 * Probe a content reference. Any error (timeout, transport, non-2xx) is treated
 * as "not retrievable" — a liveness check must never throw into the poll loop.
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
 * The sweep checks every eligible row; batched/incremental sweeps
 * (`livenessBatchSize`) are future work — see the plan doc.
 *
 * @param {number} [now] - current time in ms (injectable for tests)
 * @returns {Promise<{ changedBoards: Set<string> }>} boards whose live set changed
 */
export async function runDeathSweep(now = Date.now()) {
  const threshold = config.livenessStrikeThreshold;
  const submissions = getLiveSubmissions(now - config.livenessIngestGrace);
  const changedBoards = new Set();
  let pruned = 0;

  for (const sub of submissions) {
    if (await probe(sub.contentRef)) {
      if (sub.unreachableStrikes !== 0) setStrikes(sub.submissionRef, 0);
      continue;
    }
    const strikes = Math.min(sub.unreachableStrikes + 1, threshold);
    setStrikes(sub.submissionRef, strikes);
    // `>=`, not `===`: setStrikes and markStale are separate writes, so a crash
    // between them can leave a row re-entering the sweep already at the
    // threshold. Math.min keeps the stored count from drifting past it.
    if (strikes >= threshold) {
      markStale(sub.submissionRef, now);
      changedBoards.add(sub.boardId);
      pruned += 1;
    }
  }

  if (submissions.length > 0) {
    console.log(`[Liveness] Death sweep: checked ${submissions.length}, pruned ${pruned}`);
  }
  return { changedBoards };
}

/**
 * Resurrection sweep — re-check already-pruned submissions and restore any that
 * are retrievable again. Submissions stale longer than
 * `livenessRecheckGiveUpAfter` are abandoned and skipped (a cutoff of 0 means
 * never give up). The caller gates this on `config.livenessRecheckDead`.
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

  for (const sub of submissions) {
    if (await probe(sub.contentRef)) {
      markLive(sub.submissionRef);
      changedBoards.add(sub.boardId);
      restored += 1;
    }
  }

  if (submissions.length > 0) {
    console.log(`[Liveness] Resurrection sweep: checked ${submissions.length}, restored ${restored}`);
  }
  return { changedBoards };
}
