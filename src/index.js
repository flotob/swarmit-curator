/**
 * Swarmit Curator — main entry point.
 * Poll loop: watch chain → fetch + validate → index → publish feeds → save state.
 */

import config from './config.js';
import { getSafeBlockNumber, fetchEvents } from './chain/reader.js';
import { fetchObject, clearCache } from './swarm/client.js';
import { hexToBzz } from './protocol/references.js';
import { validateIngestedSubmission, validateIngestedContent, validateReplyConsistency } from './indexer/validator.js';
import {
  loadState, saveState,
  getLastProcessedBlock, setLastProcessedBlock,
  getBoards, addBoard, getKnownBoardSlugs,
  getSubmissions, addSubmission,
  getRootSubmissions,
} from './indexer/state.js';
import { buildBoardIndexForBoard } from './indexer/board-indexer.js';
import { buildThreadIndexForRoot } from './indexer/thread-indexer.js';
import { buildGlobalIndexFromState } from './indexer/global-indexer.js';
import { publishAndUpdateFeed } from './publisher/feed-manager.js';
import { needsProfileUpdate, publishAndDeclare } from './publisher/profile-manager.js';

const MAX_BLOCKS_PER_POLL = 10_000;

let running = true;

// Retry queues — submissions that failed transiently, boards that need republishing
const pendingRetrySubmissions = []; // { submissionRef, author, blockNumber, logIndex }
const pendingRepublishBoards = new Set();
let pendingRepublishGlobal = false;
let pendingRepublishProfile = false;

async function processEvents(fromBlock, toBlock) {
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
  const toProcess = [
    ...events.submissions,
    ...pendingRetrySubmissions.splice(0), // drain retry queue
  ];

  const knownBoardSlugs = getKnownBoardSlugs();

  for (const sub of toProcess) {
    const submissionRef = sub.submissionRef;
    const bzzRef = hexToBzz(submissionRef);

    if (!bzzRef) {
      console.warn(`[Ingest] Invalid submissionRef: ${submissionRef}`);
      continue;
    }

    // Skip if already known
    if (getSubmissions().has(bzzRef)) continue;

    try {
      const submission = await fetchObject(submissionRef);

      const subResult = validateIngestedSubmission(submission, knownBoardSlugs);
      if (!subResult.valid) {
        console.warn(`[Ingest] Invalid submission ${bzzRef}: ${subResult.errors.join(', ')}`);
        continue; // permanently skip — malformed, not transient
      }

      const content = await fetchObject(submission.contentRef);

      const contentResult = validateIngestedContent(content, submission.kind);
      if (!contentResult.valid) {
        console.warn(`[Ingest] Invalid content for ${bzzRef}: ${contentResult.errors.join(', ')}`);
        continue; // permanently skip
      }

      if (submission.kind === 'reply') {
        const replyResult = validateReplyConsistency(submission, getSubmissions());
        if (!replyResult.valid) {
          console.warn(`[Ingest] Orphaned reply ${bzzRef}: ${replyResult.errors.join(', ')}`);
          continue; // permanently skip — parent missing
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
      // Transient error (Bee timeout, 404 propagation delay, network) — queue for retry
      console.warn(`[Ingest] Transient failure for ${bzzRef}, will retry: ${err.message}`);
      pendingRetrySubmissions.push(sub);
    }
  }

  return { changedBoards, changedThreads };
}

async function publishIndexes(changedBoards, changedThreads) {
  // Also include boards that failed to publish last time
  for (const slug of pendingRepublishBoards) {
    changedBoards.add(slug);
  }

  const failedBoards = new Set();

  for (const boardSlug of changedBoards) {
    try {
      // Publish thread feeds FIRST so threadIndexFeed is available for boardIndex
      const roots = getRootSubmissions(boardSlug);
      for (const root of roots) {
        if (changedThreads.has(root.submissionRef) || pendingRepublishBoards.has(boardSlug)) {
          const threadIndex = buildThreadIndexForRoot(root);
          const threadFeedName = `thread-${root.submissionRef}`;
          await publishAndUpdateFeed(threadFeedName, threadIndex, `threadIndex for ${root.submissionRef.slice(0, 20)}...`);
        }
      }

      // Now build boardIndex — threadIndexFeed refs are available in state
      const boardIndex = buildBoardIndexForBoard(boardSlug);
      await publishAndUpdateFeed(`board-${boardSlug}`, boardIndex, `boardIndex for r/${boardSlug}`);
    } catch (err) {
      console.error(`[Publish] Failed for r/${boardSlug}: ${err.message}`);
      failedBoards.add(boardSlug);
    }
  }

  // Update retry set: clear successes, keep failures
  pendingRepublishBoards.clear();
  for (const slug of failedBoards) {
    pendingRepublishBoards.add(slug);
  }

  // Publish globalIndex
  if (changedBoards.size > 0 || pendingRepublishGlobal) {
    try {
      const globalIndex = buildGlobalIndexFromState();
      await publishAndUpdateFeed('global', globalIndex, 'globalIndex');
      pendingRepublishGlobal = false;
    } catch (err) {
      console.error(`[Publish] Failed for globalIndex: ${err.message}`);
      pendingRepublishGlobal = true;
    }
  }

  // Update curator profile if new boards discovered or previous attempt failed
  if (needsProfileUpdate() || pendingRepublishProfile) {
    try {
      await publishAndDeclare();
      pendingRepublishProfile = false;
    } catch (err) {
      console.error(`[Profile] Failed to update: ${err.message}`);
      pendingRepublishProfile = true;
    }
  }
}

async function runLoop() {
  console.log(`[Curator] Starting: ${config.curatorName} (${config.curatorAddress})`);
  console.log(`[Curator] Bee: ${config.beeUrl}, Contract: ${config.contractAddress}`);

  const loaded = await loadState();
  if (loaded) {
    console.log(`[Curator] Resumed from block ${getLastProcessedBlock()}`);
  } else {
    console.log(`[Curator] Fresh start from deploy block ${config.contractDeployBlock}`);
  }

  while (running) {
    try {
      const safeBlock = await getSafeBlockNumber();
      const fromBlock = getLastProcessedBlock() + 1;

      if (fromBlock > safeBlock && pendingRetrySubmissions.length === 0 && pendingRepublishBoards.size === 0 && !pendingRepublishGlobal && !pendingRepublishProfile) {
        await sleep(config.pollInterval);
        continue;
      }

      // Process new blocks if available
      if (fromBlock <= safeBlock) {
        const toBlock = Math.min(fromBlock + MAX_BLOCKS_PER_POLL - 1, safeBlock);
        console.log(`[Curator] Processing blocks ${fromBlock} → ${toBlock}${toBlock < safeBlock ? ` (${safeBlock - toBlock} remaining)` : ''}`);

        const { changedBoards, changedThreads } = await processEvents(fromBlock, toBlock);

        if (changedBoards.size > 0 || pendingRepublishBoards.size > 0) {
          await publishIndexes(changedBoards, changedThreads);
        }

        setLastProcessedBlock(toBlock);
        await saveState();
        clearCache();

        if (toBlock < safeBlock) continue;
      } else {
        // No new blocks, but retries pending
        const { changedBoards, changedThreads } = await processEvents(fromBlock, fromBlock - 1); // empty range, processes retry queue only
        if (changedBoards.size > 0 || pendingRepublishBoards.size > 0) {
          await publishIndexes(changedBoards, changedThreads);
          await saveState();
        }
        clearCache();
      }

    } catch (err) {
      console.error(`[Curator] Loop error: ${err.message}`);
      await sleep(config.pollInterval);
    }
  }

  console.log('[Curator] Shutting down...');
  await saveState();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

runLoop().catch((err) => {
  console.error(`[Curator] Fatal error: ${err.message}`);
  process.exit(1);
});
