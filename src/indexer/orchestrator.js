/**
 * Orchestrator — single-iteration poll logic.
 * Extracted from index.js for testability.
 */

import { getSafeBlockNumber, fetchEvents } from '../chain/reader.js';
import { fetchObject, clearCache } from '../swarm/client.js';
import { hexToBzz } from 'swarmit-protocol';
import { validateIngestedSubmission, validateIngestedContent, validateReplyConsistency } from './validator.js';
import {
  getLastProcessedBlock, setLastProcessedBlock, getMeta, setMeta,
  inTransaction,
  getAllBoards, addBoard, updateBoardMetadata,
  hasSubmission, addSubmission,
  getRetrySubmissions, setRetrySubmissions,
  applyVoteEvent, insertVoteEvent,
  getRepublishBoards, setRepublishBoards, addRepublishBoard,
  getRepublishGlobal, setRepublishGlobal,
  getRepublishProfile, setRepublishProfile,
} from './state.js';
import { getPostsForBoard, buildBoardIndexForBoard, buildBestBoardIndex, buildHotBoardIndex, buildRisingBoardIndex, buildControversialBoardIndex } from './board-indexer.js';
import { buildThreadIndexForRoot } from './thread-indexer.js';
import { collectAllPosts, buildGlobalIndexFromState, buildBestGlobalIndex, buildHotGlobalIndex, buildRisingGlobalIndex, buildControversialGlobalIndex } from './global-indexer.js';
import config from '../config.js';
import { publishAndUpdateFeed } from '../publisher/feed-manager.js';
import { needsProfileUpdate, publishProfileToFeed, ensureDeclared } from '../publisher/profile-manager.js';
import { runDeathSweep, runResurrectionSweep } from './liveness.js';

export const MAX_BLOCKS_PER_POLL = 10_000;

export function hasPendingWork() {
  return getRetrySubmissions().length > 0
    || getRepublishBoards().size > 0
    || getRepublishGlobal()
    || getRepublishProfile(); // profile content check deferred to publish time (too expensive for idle)
}

/**
 * Persist the "republish these boards + global" dirty markers atomically, so a
 * crash before the publish phase still leaves the work to be picked up on the
 * next start.
 */
function markBoardsDirty(slugs) {
  inTransaction(() => {
    for (const slug of slugs) addRepublishBoard(slug);
    setRepublishGlobal(true);
  });
}

export async function processEvents(fromBlock, toBlock) {
  const events = await fetchEvents(fromBlock, toBlock);
  const changedBoards = new Set();
  const changedThreads = new Set();

  // ========================================
  // Phase 1: Fetch + validate (async, no DB writes)
  // ========================================

  const retryQueue = getRetrySubmissions();
  const toProcess = [...events.submissions, ...retryQueue];

  // Submissions carry boardId as bytes32; internal state is slug-keyed, so
  // we resolve at the ingest boundary.
  const boardsByBytes32 = new Map();
  for (const board of getAllBoards()) boardsByBytes32.set(board.boardId, board.slug);
  for (const board of events.boards) boardsByBytes32.set(board.boardId, board.slug);

  // Track refs known to exist: DB state + accepted refs from this batch.
  // This lets replies whose parent is in the same batch pass consistency checks.
  const batchKnownRefs = new Set();
  const isKnown = (ref) => hasSubmission(ref) || batchKnownRefs.has(ref);

  const validatedSubmissions = [];
  const stillPending = [];

  for (const sub of toProcess) {
    const submissionRef = sub.submissionRef;
    const bzzRef = hexToBzz(submissionRef);

    if (!bzzRef) {
      console.warn(`[Ingest] Invalid submissionRef: ${submissionRef}`);
      continue;
    }

    if (isKnown(bzzRef)) continue;

    try {
      const submission = await fetchObject(submissionRef);

      const subResult = validateIngestedSubmission(submission, boardsByBytes32);
      if (!subResult.valid) {
        console.warn(`[Ingest] Invalid submission ${bzzRef}: ${subResult.errors.join(', ')}`);
        continue;
      }

      const content = await fetchObject(submission.contentRef);

      const contentResult = validateIngestedContent(content, submission.kind);
      if (!contentResult.valid) {
        console.warn(`[Ingest] Invalid content for ${bzzRef}: ${contentResult.errors.join(', ')}`);
        continue;
      }

      if (submission.kind === 'reply') {
        const replyResult = validateReplyConsistency(submission, isKnown);
        if (!replyResult.valid) {
          console.warn(`[Ingest] Reply ${bzzRef} parent/root not yet available, will retry`);
          stillPending.push(sub);
          continue;
        }
      }

      // Validator guarantees the map contains this boardId.
      const boardSlug = boardsByBytes32.get(submission.boardId);

      const rootRef = submission.rootSubmissionId || bzzRef;
      validatedSubmissions.push({
        bzzRef,
        boardId: boardSlug,
        kind: submission.kind,
        contentRef: submission.contentRef,
        parentSubmissionId: submission.parentSubmissionId || null,
        rootSubmissionId: rootRef,
        author: sub.author,
        blockNumber: sub.blockNumber,
        logIndex: sub.logIndex,
        announcedAtMs: sub.blockTimestampMs || null,
      });

      batchKnownRefs.add(bzzRef);
      changedBoards.add(boardSlug);
      changedThreads.add(rootRef);
      console.log(`[Ingest] ${submission.kind}: ${bzzRef} in r/${boardSlug}`);

    } catch (err) {
      console.warn(`[Ingest] Transient failure for ${bzzRef}, will retry: ${err.message}`);
      stillPending.push(sub);
    }
  }

  // ========================================
  // Phase 2: Apply to DB (sync transaction)
  // ========================================

  inTransaction(() => {
    for (const board of events.boards) {
      addBoard(board.slug, {
        boardId: board.boardId,
        boardRef: board.boardRef,
        governance: board.governance,
      });
    }

    for (const update of events.metadataUpdates) {
      updateBoardMetadata(update.boardId, update.boardRef);
    }

    for (const sub of validatedSubmissions) {
      addSubmission(sub.bzzRef, sub);
    }

    setRetrySubmissions(stillPending);

    for (const vote of events.votes) {
      const changed = applyVoteEvent(vote);
      if (changed) {
        const slug = boardsByBytes32.get(vote.boardId);
        if (slug) changedBoards.add(slug);
      }
      insertVoteEvent(vote);
    }
  });

  // Log after transaction
  for (const board of events.boards) {
    console.log(`[Ingest] Board registered: r/${board.slug}`);
  }
  for (const update of events.metadataUpdates) {
    console.log(`[Ingest] Board metadata updated: boardId=${update.boardId}`);
  }
  for (const vote of events.votes) {
    console.log(`[Ingest] vote: ${vote.direction > 0 ? 'up' : vote.direction < 0 ? 'down' : 'clear'} on ${vote.submissionRef.slice(0, 20)}... by ${vote.voter.slice(0, 10)}...`);
  }

  return { changedBoards, changedThreads };
}

export async function publishIndexes(changedBoards, changedThreads) {
  const republishBoards = getRepublishBoards();
  for (const slug of republishBoards) {
    changedBoards.add(slug);
  }

  const failedBoards = new Set();

  for (const boardSlug of changedBoards) {
    // Fetch posts once for all views of this board
    const posts = getPostsForBoard(boardSlug);

    // Event-driven publish covers only the default feeds the SPA shows on
    // landing — chronological + hot. The other ranked variants (best, rising,
    // controversial) are refreshed by publishRankedRefresh on its timer, gated
    // by the no-change skip in publishAndUpdateFeed.
    try {
      // Thread feeds first so threadIndexFeed is available for boardIndex.
      for (const root of posts) {
        if (changedThreads.has(root.submissionRef) || republishBoards.has(boardSlug)) {
          const threadIndex = buildThreadIndexForRoot(root);
          await publishAndUpdateFeed(`thread-${root.submissionRef}`, threadIndex, `threadIndex for ${root.submissionRef.slice(0, 20)}...`);
        }
      }

      await publishAndUpdateFeed(`board-${boardSlug}`, buildBoardIndexForBoard(boardSlug, posts), `boardIndex for r/${boardSlug}`);
      await publishAndUpdateFeed(`hot-board-${boardSlug}`, buildHotBoardIndex(boardSlug, posts), `hot-board for r/${boardSlug}`);
    } catch (err) {
      console.error(`[Publish] Failed default feeds for r/${boardSlug}: ${err.message}`);
      failedBoards.add(boardSlug);
    }
  }

  setRepublishBoards(failedBoards);
}

/**
 * Publish only ranked feeds for all boards + global. Does NOT republish
 * chronological (new) or thread feeds. Used by timed ranked refresh.
 */
export async function publishRankedRefresh() {
  let anyFailed = false;

  for (const { slug } of getAllBoards()) {
    const posts = getPostsForBoard(slug);
    if (posts.length === 0) continue;

    for (const [prefix, build] of [
      ['best-board', () => buildBestBoardIndex(slug, posts)],
      ['hot-board', () => buildHotBoardIndex(slug, posts)],
      ['rising-board', () => buildRisingBoardIndex(slug, posts)],
      ['controversial-board', () => buildControversialBoardIndex(slug, posts)],
    ]) {
      try {
        await publishAndUpdateFeed(`${prefix}-${slug}`, build(), `${prefix} refresh for r/${slug}`);
      } catch (err) {
        console.error(`[Ranked] Failed ${prefix} refresh for r/${slug}: ${err.message}`);
        anyFailed = true;
      }
    }
  }

  const allPosts = collectAllPosts();
  for (const [name, build] of [
    ['best-global', () => buildBestGlobalIndex(allPosts)],
    ['hot-global', () => buildHotGlobalIndex(allPosts)],
    ['rising-global', () => buildRisingGlobalIndex(allPosts)],
    ['controversial-global', () => buildControversialGlobalIndex(allPosts)],
  ]) {
    try {
      await publishAndUpdateFeed(name, build(), `${name} refresh`);
    } catch (err) {
      console.error(`[Ranked] Failed ${name} refresh: ${err.message}`);
      anyFailed = true;
    }
  }

  // Only update timestamp if all feeds succeeded — retry sooner on failure
  if (!anyFailed) {
    setMeta('last_ranked_refresh_at', String(Date.now()));
  }
}

export async function publishGlobalAndProfile() {
  if (getRepublishGlobal()) {
    let globalFailed = false;
    const allPosts = collectAllPosts();

    // Event-driven path publishes only the defaults — chronological + hot.
    // The other ranked global variants are deferred to publishRankedRefresh.
    for (const [name, build] of [
      ['global', () => buildGlobalIndexFromState(allPosts)],
      ['hot-global', () => buildHotGlobalIndex(allPosts)],
    ]) {
      try {
        await publishAndUpdateFeed(name, build(), name);
      } catch (err) {
        console.error(`[Publish] Failed for ${name}: ${err.message}`);
        globalFailed = true;
      }
    }

    setRepublishGlobal(globalFailed);
  }

  // Curator profile — publish to feed if content changed, then ensure declaration.
  // Split so a declaration-only failure doesn't re-upload identical content.
  const profileChanged = needsProfileUpdate();
  if (profileChanged || getRepublishProfile()) {
    let feedOk = !profileChanged; // already up-to-date → skip feed write
    if (!feedOk) {
      try {
        await publishProfileToFeed();
        feedOk = true;
      } catch (err) {
        console.error(`[Profile] Feed publish failed: ${err.message}`);
        setRepublishProfile(true);
      }
    }

    if (feedOk) {
      try {
        await ensureDeclared();
        setRepublishProfile(false);
      } catch (err) {
        console.error(`[Profile] Declaration failed: ${err.message}`);
        setRepublishProfile(true);
      }
    }
  }
}

/**
 * Run whichever liveness sweeps are due and fold their results into the poll.
 *
 * Timer-driven like the ranked refresh, and gated by config — not by
 * hasPendingWork() — so it never keeps the loop from going idle. Boards whose
 * live set changed are added to `changedBoards` and marked for republish so
 * the poll's publish phase rebuilds their feeds.
 *
 * @param {Set<string>} changedBoards - the poll's changed-board set, mutated in place
 * @param {number} [now] - current time in ms
 */
export async function runLivenessSweeps(changedBoards, now = Date.now()) {
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

  if (sweptBoards.size === 0) return;
  for (const slug of sweptBoards) changedBoards.add(slug);
  markBoardsDirty(sweptBoards);
}

export async function pollOnce() {
  const safeBlock = await getSafeBlockNumber();
  const fromBlock = getLastProcessedBlock() + 1;

  if (fromBlock > safeBlock && !hasPendingWork()) {
    return { idle: true };
  }

  let changedBoards = new Set();
  let changedThreads = new Set();

  // Process new blocks if available
  if (fromBlock <= safeBlock) {
    const toBlock = Math.min(fromBlock + MAX_BLOCKS_PER_POLL - 1, safeBlock);
    console.log(`[Curator] Processing blocks ${fromBlock} → ${toBlock}${toBlock < safeBlock ? ` (${safeBlock - toBlock} remaining)` : ''}`);

    const result = await processEvents(fromBlock, toBlock);
    changedBoards = result.changedBoards;
    changedThreads = result.changedThreads;

    // Persist cursor AND dirty markers in a single transaction before publishing.
    // If we crash after this but before publish, restart will see the
    // dirty markers and republish even though the blocks won't be replayed.
    inTransaction(() => {
      setLastProcessedBlock(toBlock);
      if (changedBoards.size > 0) {
        for (const slug of changedBoards) addRepublishBoard(slug);
        setRepublishGlobal(true);
      }
    });
  } else if (getRetrySubmissions().length > 0) {
    // No new blocks but retries pending — process empty range to drain retry queue
    const result = await processEvents(fromBlock, fromBlock - 1);
    changedBoards = result.changedBoards;
    changedThreads = result.changedThreads;

    if (changedBoards.size > 0) markBoardsDirty(changedBoards);
  }

  // Liveness sweeps — timer-driven; fold any boards they changed into this
  // poll so the publish phase below rebuilds the affected feeds.
  await runLivenessSweeps(changedBoards);

  // Publish board/thread indexes (republishBoards includes anything from above)
  if (changedBoards.size > 0 || getRepublishBoards().size > 0) {
    await publishIndexes(changedBoards, changedThreads);
  }

  // Global + profile — always checked independently of board changes
  await publishGlobalAndProfile();

  // Timed ranked refresh — hot/rising drift with time, and post-WP3 it is the
  // *only* path that publishes best/rising/controversial. Always check the
  // timer (even when this poll had event-driven work); publishAndUpdateFeed's
  // no-change skip makes the refresh cheap when nothing actually shifted.
  const lastRefresh = parseInt(getMeta('last_ranked_refresh_at', '0'), 10);
  if (Date.now() - lastRefresh >= config.rankedRefreshInterval) {
    console.log('[Curator] Ranked refresh interval elapsed, republishing ranked feeds');
    await publishRankedRefresh();
  }

  clearCache();

  return { idle: false };
}
