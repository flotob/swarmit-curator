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

async function processEvents(fromBlock, toBlock) {
  const events = await fetchEvents(fromBlock, toBlock);
  const changedBoards = new Set();
  const changedThreads = new Set(); // track which root submissions need threadIndex updates

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

  // 3. Process submissions
  const knownBoardSlugs = getKnownBoardSlugs();

  for (const sub of events.submissions) {
    const submissionRef = sub.submissionRef;
    const bzzRef = hexToBzz(submissionRef);

    if (!bzzRef) {
      console.warn(`[Ingest] Invalid submissionRef: ${submissionRef}`);
      continue;
    }

    // Skip if already known
    if (getSubmissions().has(bzzRef)) continue;

    try {
      // Fetch submission object
      const submission = await fetchObject(submissionRef);

      // Validate submission
      const subResult = validateIngestedSubmission(submission, knownBoardSlugs);
      if (!subResult.valid) {
        console.warn(`[Ingest] Invalid submission ${bzzRef}: ${subResult.errors.join(', ')}`);
        continue;
      }

      // Fetch content
      const content = await fetchObject(submission.contentRef);

      // Validate content
      const contentResult = validateIngestedContent(content, submission.kind);
      if (!contentResult.valid) {
        console.warn(`[Ingest] Invalid content for ${bzzRef}: ${contentResult.errors.join(', ')}`);
        continue;
      }

      // For replies: validate parent/root consistency
      if (submission.kind === 'reply') {
        const replyResult = validateReplyConsistency(submission, getSubmissions());
        if (!replyResult.valid) {
          console.warn(`[Ingest] Orphaned reply ${bzzRef}: ${replyResult.errors.join(', ')}`);
          continue;
        }
      }

      // All validation passed — add to state
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
      console.warn(`[Ingest] Failed to process ${bzzRef}: ${err.message}`);
    }
  }

  return { changedBoards, changedThreads };
}

async function publishIndexes(changedBoards, changedThreads) {
  for (const boardSlug of changedBoards) {
    try {
      // Build and publish boardIndex
      const boardIndex = buildBoardIndexForBoard(boardSlug);
      await publishAndUpdateFeed(`board-${boardSlug}`, boardIndex, `boardIndex for r/${boardSlug}`);

      // Only rebuild threadIndexes for threads that actually changed
      const roots = getRootSubmissions(boardSlug);
      for (const root of roots) {
        if (changedThreads.has(root.submissionRef)) {
          const threadIndex = buildThreadIndexForRoot(root);
          const threadFeedName = `thread-${root.submissionRef}`;
          await publishAndUpdateFeed(threadFeedName, threadIndex, `threadIndex for ${root.submissionRef.slice(0, 20)}...`);
        }
      }
    } catch (err) {
      console.error(`[Publish] Failed for r/${boardSlug}: ${err.message}`);
    }
  }

  // Publish globalIndex
  if (changedBoards.size > 0) {
    try {
      const globalIndex = buildGlobalIndexFromState();
      await publishAndUpdateFeed('global', globalIndex, 'globalIndex');
    } catch (err) {
      console.error(`[Publish] Failed for globalIndex: ${err.message}`);
    }
  }

  // Update curator profile if new boards discovered
  if (needsProfileUpdate()) {
    try {
      await publishAndDeclare();
    } catch (err) {
      console.error(`[Profile] Failed to update: ${err.message}`);
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

      if (fromBlock > safeBlock) {
        await sleep(config.pollInterval);
        continue;
      }

      // Chunk large ranges to avoid RPC limits
      const toBlock = Math.min(fromBlock + MAX_BLOCKS_PER_POLL - 1, safeBlock);

      console.log(`[Curator] Processing blocks ${fromBlock} → ${toBlock}${toBlock < safeBlock ? ` (${safeBlock - toBlock} remaining)` : ''}`);

      const { changedBoards, changedThreads } = await processEvents(fromBlock, toBlock);

      if (changedBoards.size > 0) {
        await publishIndexes(changedBoards, changedThreads);
      }

      setLastProcessedBlock(toBlock);
      await saveState();
      clearCache();

      // If more blocks remain, continue immediately without sleeping
      if (toBlock < safeBlock) continue;

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
