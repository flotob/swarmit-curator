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
  getAllBoards, addBoard, getKnownBoardSlugs, updateBoardMetadata,
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

export const MAX_BLOCKS_PER_POLL = 10_000;

export function hasPendingWork() {
  return getRetrySubmissions().length > 0
    || getRepublishBoards().size > 0
    || getRepublishGlobal()
    || getRepublishProfile(); // profile content check deferred to publish time (too expensive for idle)
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

  const knownBoardSlugs = getKnownBoardSlugs();
  // Include boards from this batch so submissions targeting a newly-registered
  // board in the same block range pass validation.
  for (const board of events.boards) knownBoardSlugs.add(board.slug);

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

      const subResult = validateIngestedSubmission(submission, knownBoardSlugs);
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

      const rootRef = submission.rootSubmissionId || bzzRef;
      validatedSubmissions.push({
        bzzRef,
        boardId: submission.boardId,
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
      changedBoards.add(submission.boardId);
      changedThreads.add(rootRef);
      console.log(`[Ingest] ${submission.kind}: ${bzzRef} in r/${submission.boardId}`);

    } catch (err) {
      console.warn(`[Ingest] Transient failure for ${bzzRef}, will retry: ${err.message}`);
      stillPending.push(sub);
    }
  }

  // Resolve board slugs for vote events (needs current DB state, read-only)
  const boardsByBytes32 = new Map();
  if (events.votes.length > 0) {
    for (const board of getAllBoards()) {
      boardsByBytes32.set(board.boardId, board.slug);
    }
    for (const board of events.boards) {
      boardsByBytes32.set(board.boardId, board.slug);
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

    // Publish thread feeds FIRST so threadIndexFeed is available for boardIndex
    try {
      for (const root of posts) {
        if (changedThreads.has(root.submissionRef) || republishBoards.has(boardSlug)) {
          const threadIndex = buildThreadIndexForRoot(root);
          await publishAndUpdateFeed(`thread-${root.submissionRef}`, threadIndex, `threadIndex for ${root.submissionRef.slice(0, 20)}...`);
        }
      }

      await publishAndUpdateFeed(`board-${boardSlug}`, buildBoardIndexForBoard(boardSlug, posts), `boardIndex for r/${boardSlug}`);
    } catch (err) {
      console.error(`[Publish] Failed default feed for r/${boardSlug}: ${err.message}`);
      failedBoards.add(boardSlug);
      continue; // skip ranked feeds if Swarm is down for this board
    }

    // All ranked board feeds (reuse fetched posts)
    for (const [prefix, build] of [
      ['best-board', () => buildBestBoardIndex(boardSlug, posts)],
      ['hot-board', () => buildHotBoardIndex(boardSlug, posts)],
      ['rising-board', () => buildRisingBoardIndex(boardSlug, posts)],
      ['controversial-board', () => buildControversialBoardIndex(boardSlug, posts)],
    ]) {
      try {
        await publishAndUpdateFeed(`${prefix}-${boardSlug}`, build(), `${prefix} for r/${boardSlug}`);
      } catch (err) {
        console.error(`[Publish] Failed ${prefix} feed for r/${boardSlug}: ${err.message}`);
        failedBoards.add(boardSlug);
      }
    }
  }

  setRepublishBoards(failedBoards);

  // Ranked feeds were just rebuilt — reset the timed refresh clock
  if (failedBoards.size === 0) {
    setMeta('last_ranked_refresh_at', String(Date.now()));
  }
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

    // Chronological (new) global feed
    try {
      await publishAndUpdateFeed('global', buildGlobalIndexFromState(allPosts), 'globalIndex');
    } catch (err) {
      console.error(`[Publish] Failed for globalIndex: ${err.message}`);
      globalFailed = true;
    }

    // All ranked global feeds (reuse collected posts)
    for (const [name, build] of [
      ['best-global', () => buildBestGlobalIndex(allPosts)],
      ['hot-global', () => buildHotGlobalIndex(allPosts)],
      ['rising-global', () => buildRisingGlobalIndex(allPosts)],
      ['controversial-global', () => buildControversialGlobalIndex(allPosts)],
    ]) {
      try {
        await publishAndUpdateFeed(name, build(), name);
      } catch (err) {
        console.error(`[Publish] Failed for ${name}: ${err.message}`);
        globalFailed = true;
      }
    }

    setRepublishGlobal(globalFailed);

    // Global ranked feeds were just rebuilt — reset the timed refresh clock
    if (!globalFailed) {
      setMeta('last_ranked_refresh_at', String(Date.now()));
    }
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

    if (changedBoards.size > 0) {
      inTransaction(() => {
        for (const slug of changedBoards) addRepublishBoard(slug);
        setRepublishGlobal(true);
      });
    }
  }

  // Publish board/thread indexes (republishBoards includes anything from above)
  if (changedBoards.size > 0 || getRepublishBoards().size > 0) {
    await publishIndexes(changedBoards, changedThreads);
  }

  // Global + profile — always checked independently of board changes
  await publishGlobalAndProfile();

  // Timed ranked refresh — hot/rising change with time even without new events
  const rankedWorkHappened = changedBoards.size > 0;
  if (!rankedWorkHappened) {
    const lastRefresh = parseInt(getMeta('last_ranked_refresh_at', '0'), 10);
    if (Date.now() - lastRefresh >= config.rankedRefreshInterval) {
      console.log('[Curator] Ranked refresh interval elapsed, republishing ranked feeds');
      await publishRankedRefresh();
    }
  }

  clearCache();

  return { idle: false };
}
