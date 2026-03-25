/**
 * Swarmit Curator — main entry point.
 * Thin wrapper: load state, run pollOnce in a loop, handle signals.
 */

import config from './config.js';
import {
  loadState, saveState,
  getLastProcessedBlock,
  getRetrySubmissions, getRepublishBoards,
  getRepublishGlobal, getRepublishProfile,
} from './indexer/state.js';
import { pollOnce, hasPendingWork } from './indexer/orchestrator.js';

let running = true;

async function runLoop() {
  console.log(`[Curator] Starting: ${config.curatorName} (${config.curatorAddress})`);
  console.log(`[Curator] Bee: ${config.beeUrl}, Contract: ${config.contractAddress}`);

  const loaded = await loadState();
  if (loaded) {
    console.log(`[Curator] Resumed from block ${getLastProcessedBlock()}`);
    if (hasPendingWork()) {
      console.log(`[Curator] Pending: ${getRetrySubmissions().length} submissions, ${getRepublishBoards().size} boards, global=${getRepublishGlobal()}, profile=${getRepublishProfile()}`);
    }
  } else {
    console.log(`[Curator] Fresh start from deploy block ${config.contractDeployBlock}`);
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
