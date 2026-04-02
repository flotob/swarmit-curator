/**
 * Swarmit Curator — main entry point.
 * Thin wrapper: init DB, run pollOnce in a loop, handle signals.
 */

import config from './config.js';
import {
  initDb, closeDb,
  getLastProcessedBlock, setLastProcessedBlock,
  getRetrySubmissions, getRepublishBoards,
  getRepublishGlobal, getRepublishProfile,
} from './indexer/state.js';
import { pollOnce, hasPendingWork } from './indexer/orchestrator.js';

let running = true;

async function runLoop() {
  console.log(`[Curator] Starting: ${config.curatorName} (${config.curatorAddress})`);
  console.log(`[Curator] Bee: ${config.beeUrl}, Contract: ${config.contractAddress}`);

  initDb(config.stateDb);

  // Seed initial block cursor if DB is fresh
  const currentBlock = getLastProcessedBlock();
  if (currentBlock === null) {
    setLastProcessedBlock(config.contractDeployBlock - 1);
    console.log(`[Curator] Fresh start from deploy block ${config.contractDeployBlock}`);
  } else {
    console.log(`[Curator] Resumed from block ${currentBlock}`);
    if (hasPendingWork()) {
      console.log(`[Curator] Pending: ${getRetrySubmissions().length} submissions, ${getRepublishBoards().size} boards, global=${getRepublishGlobal()}, profile=${getRepublishProfile()}`);
    }
  }

  while (running) {
    try {
      const result = await pollOnce();
      if (result.idle) {
        await sleep(config.pollInterval);
      }
    } catch (err) {
      console.error(`[Curator] Loop error: ${err.message}`);
      await sleep(config.pollInterval);
    }
  }

  console.log('[Curator] Shutting down...');
  closeDb();
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
