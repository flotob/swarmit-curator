/**
 * Orchestrator — single-iteration poll logic.
 * Extracted from index.js for testability.
 */

import { getSafeBlockNumber, fetchEvents } from '../chain/reader.js';
import { fetchObject, clearCache } from '../swarm/client.js';
import { hexToBzz } from '../protocol/references.js';
import { validateIngestedSubmission, validateIngestedContent, validateReplyConsistency } from './validator.js';
import {
  saveState,
  getLastProcessedBlock, setLastProcessedBlock,
  getBoards, addBoard, getKnownBoardSlugs,
  getSubmissions, addSubmission,
  getRootSubmissions,
  getRetrySubmissions, setRetrySubmissions,
  getRepublishBoards, setRepublishBoards,
  getRepublishGlobal, setRepublishGlobal,
  getRepublishProfile, setRepublishProfile,
} from './state.js';
import { buildBoardIndexForBoard } from './board-indexer.js';
import { buildThreadIndexForRoot } from './thread-indexer.js';
import { buildGlobalIndexFromState } from './global-indexer.js';
import { publishAndUpdateFeed } from '../publisher/feed-manager.js';
import { needsProfileUpdate, publishAndDeclare } from '../publisher/profile-manager.js';

export const MAX_BLOCKS_PER_POLL = 10_000;

export function hasPendingWork() {
  return getRetrySubmissions().length > 0
    || getRepublishBoards().size > 0
    || getRepublishGlobal()
    || getRepublishProfile()
    || needsProfileUpdate();
}

export async function processEvents(fromBlock, toBlock) {
  const events = await fetchEvents(fromBlock, toBlock);
  const changedBoards = new Set();
  const changedThreads = new Set();

  // 1. Process board registrations
  for (const board of events.boards) {
    addBoard(board.slug, {
      boardId: board.boardId,
      slug: board.slug,
      boardRef: board.boardRef,
      governance: board.governance,
    });
    console.log(`[Ingest] Board registered: r/${board.slug}`);
  }

  // 2. Process board metadata updates
  for (const update of events.metadataUpdates) {
    const boards = getBoards();
    for (const [slug, board] of boards) {
      if (board.boardId === update.boardId) {
        board.boardRef = update.boardRef;
        console.log(`[Ingest] Board metadata updated: r/${slug}`);
        break;
      }
    }
  }

  // 3. Process submissions (new events + retry queue)
  const retryQueue = getRetrySubmissions().splice(0);
  const toProcess = [...events.submissions, ...retryQueue];
  const stillPending = [];

  const knownBoardSlugs = getKnownBoardSlugs();

  for (const sub of toProcess) {
    const submissionRef = sub.submissionRef;
    const bzzRef = hexToBzz(submissionRef);

    if (!bzzRef) {
      console.warn(`[Ingest] Invalid submissionRef: ${submissionRef}`);
      continue;
    }

    if (getSubmissions().has(bzzRef)) continue;

    try {
      const submission = await fetchObject(submissionRef);

      // Validate submission — malformed objects are permanently dropped
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

      // For replies: check parent/root — if missing, retry later (parent may be pending)
      if (submission.kind === 'reply') {
        const replyResult = validateReplyConsistency(submission, getSubmissions());
        if (!replyResult.valid) {
          console.warn(`[Ingest] Reply ${bzzRef} parent/root not yet available, will retry`);
          stillPending.push(sub);
          continue;
        }
      }

      const rootRef = submission.rootSubmissionId || bzzRef;
      addSubmission(bzzRef, {
        boardId: submission.boardId,
        kind: submission.kind,
        contentRef: submission.contentRef,
        parentSubmissionId: submission.parentSubmissionId || null,
        rootSubmissionId: rootRef,
        author: sub.author,
        blockNumber: sub.blockNumber,
        logIndex: sub.logIndex,
      });

      changedBoards.add(submission.boardId);
      changedThreads.add(rootRef);
      console.log(`[Ingest] ${submission.kind}: ${bzzRef} in r/${submission.boardId}`);

    } catch (err) {
      // Transient fetch error — retry next loop
      console.warn(`[Ingest] Transient failure for ${bzzRef}, will retry: ${err.message}`);
      stillPending.push(sub);
    }
  }

  setRetrySubmissions(stillPending);
  return { changedBoards, changedThreads };
}

export async function publishIndexes(changedBoards, changedThreads) {
  // Include boards pending republish
  const republishBoards = getRepublishBoards();
  for (const slug of republishBoards) {
    changedBoards.add(slug);
  }

  const failedBoards = new Set();

  for (const boardSlug of changedBoards) {
    try {
      // Publish thread feeds FIRST so threadIndexFeed is available for boardIndex
      const roots = getRootSubmissions(boardSlug);
      for (const root of roots) {
        if (changedThreads.has(root.submissionRef) || republishBoards.has(boardSlug)) {
          const threadIndex = buildThreadIndexForRoot(root);
          const threadFeedName = `thread-${root.submissionRef}`;
          await publishAndUpdateFeed(threadFeedName, threadIndex, `threadIndex for ${root.submissionRef.slice(0, 20)}...`);
        }
      }

      const boardIndex = buildBoardIndexForBoard(boardSlug);
      await publishAndUpdateFeed(`board-${boardSlug}`, boardIndex, `boardIndex for r/${boardSlug}`);
    } catch (err) {
      console.error(`[Publish] Failed for r/${boardSlug}: ${err.message}`);
      failedBoards.add(boardSlug);
    }
  }

  setRepublishBoards(failedBoards);
}

export async function publishGlobalAndProfile() {
  // Global index
  if (getRepublishGlobal()) {
    try {
      const globalIndex = buildGlobalIndexFromState();
      await publishAndUpdateFeed('global', globalIndex, 'globalIndex');
      setRepublishGlobal(false);
    } catch (err) {
      console.error(`[Publish] Failed for globalIndex: ${err.message}`);
      setRepublishGlobal(true);
    }
  }

  // Curator profile
  if (needsProfileUpdate() || getRepublishProfile()) {
    try {
      await publishAndDeclare();
      setRepublishProfile(false);
    } catch (err) {
      console.error(`[Profile] Failed to update: ${err.message}`);
      setRepublishProfile(true);
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

    setLastProcessedBlock(toBlock);
  } else if (getRetrySubmissions().length > 0) {
    // No new blocks but retries pending — process empty range to drain retry queue
    const result = await processEvents(fromBlock, fromBlock - 1);
    changedBoards = result.changedBoards;
    changedThreads = result.changedThreads;
  }

  // Publish board/thread indexes
  if (changedBoards.size > 0 || getRepublishBoards().size > 0) {
    await publishIndexes(changedBoards, changedThreads);
    // Mark global for publish if boards changed
    if (!getRepublishGlobal()) setRepublishGlobal(true);
  }

  // Global + profile — always checked independently of board changes
  await publishGlobalAndProfile();

  await saveState();
  clearCache();

  return { idle: false };
}
