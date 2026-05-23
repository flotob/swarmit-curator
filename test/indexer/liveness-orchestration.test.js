import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv, trackConcurrency } from '../helpers/fixtures.js';

setupTestEnv();
// Exercise the resurrection path too — off by default.
process.env.LIVENESS_RECHECK_DEAD = 'true';

// --- Mocks (must be registered before importing the SUT) ---------------------

const mockIsRetrievable = mock.fn(async () => true);
mock.module('../../src/swarm/client.js', {
  namedExports: { isRetrievable: mockIsRetrievable },
});

// ESM namespace exports can't be re-bound, so tests can't swap runDeathSweep
// at runtime — instead we mock the boundary below (isRetrievable) and let the
// real sweep do its thing on seeded submissions.
const { runLivenessSweeps, startLivenessScheduler, stopLivenessScheduler, _resetSchedulerForTest } =
  await import('../../src/indexer/liveness.js');
const { default: config } = await import('../../src/config.js');
const {
  initDb, closeDb, resetDb, setMeta, getMeta,
  addBoard, addSubmission, setStrikes,
  getRepublishBoards, getRepublishGlobal,
} = await import('../../src/indexer/state.js');
const { slugToBoardId } = await import('swarmit-protocol');

before(() => initDb(':memory:'));
after(() => closeDb());
beforeEach(() => {
  resetDb();
  _resetSchedulerForTest();
  mockIsRetrievable.mock.resetCalls();
  mockIsRetrievable.mock.mockImplementation(async () => true);
});

// Far enough past epoch that both sweep timers read as due against an unset meta.
const NOW = 10_000_000_000;

// --- runLivenessSweeps (the timer-aware wrapper) -----------------------------

describe('runLivenessSweeps', () => {
  it('runs the death sweep when its timer is due and records the run', async () => {
    await runLivenessSweeps(NOW);
    assert.equal(getMeta('last_death_sweep_at'), String(NOW));
  });

  it('skips the death sweep when its timer is not yet due', async () => {
    addBoard('tech', { boardId: slugToBoardId('tech') });
    addSubmission('bzz://gated', {
      boardId: 'tech', kind: 'post', contentRef: 'bzz://c',
      blockNumber: 1, logIndex: 0, ingestedAt: 0,
    });
    setMeta('last_death_sweep_at', String(NOW - 1000));

    await runLivenessSweeps(NOW);

    assert.equal(getMeta('last_death_sweep_at'), String(NOW - 1000), 'timestamp unchanged');
    assert.equal(mockIsRetrievable.mock.callCount(), 0, 'no probes fired');
  });

  it('runs the resurrection sweep when recheck-dead is enabled and due', async () => {
    await runLivenessSweeps(NOW);
    assert.equal(getMeta('last_resurrection_sweep_at'), String(NOW));
  });

  it('writes pruned boards into the republish queue and flips republish_global', async () => {
    // Seed two boards with a submission each, one strike from the threshold.
    // With isRetrievable=false the next probe takes both submissions over the
    // line, so both boards land in `changedBoards` → markBoardsDirty fires.
    addBoard('tech', { boardId: slugToBoardId('tech') });
    addBoard('art', { boardId: slugToBoardId('art') });
    addSubmission('bzz://t', {
      boardId: 'tech', kind: 'post', contentRef: 'bzz://t-content',
      blockNumber: 10, logIndex: 0, ingestedAt: 0,
    });
    addSubmission('bzz://a', {
      boardId: 'art', kind: 'post', contentRef: 'bzz://a-content',
      blockNumber: 10, logIndex: 0, ingestedAt: 0,
    });
    setStrikes('bzz://t', 1);
    setStrikes('bzz://a', 1);
    mockIsRetrievable.mock.mockImplementation(async () => false);

    await runLivenessSweeps(NOW);

    assert.ok(getRepublishBoards().has('tech'));
    assert.ok(getRepublishBoards().has('art'));
    assert.equal(getRepublishGlobal(), true);
  });

  it('sets no republish markers when the sweeps change nothing', async () => {
    await runLivenessSweeps(NOW);
    assert.equal(getRepublishBoards().size, 0);
    assert.equal(getRepublishGlobal(), false);
  });

  it('does nothing when livenessEnabled is false', async () => {
    const original = config.livenessEnabled;
    config.livenessEnabled = false;
    try {
      await runLivenessSweeps(NOW);
      assert.equal(getMeta('last_death_sweep_at'), null);
    } finally {
      config.livenessEnabled = original;
    }
  });
});

// --- Scheduler (singleton guard, error isolation) ----------------------------

describe('startLivenessScheduler', () => {
  it('returns null when liveness is disabled', () => {
    const original = config.livenessEnabled;
    config.livenessEnabled = false;
    try {
      assert.equal(startLivenessScheduler(), null);
    } finally {
      config.livenessEnabled = original;
    }
  });

  it('singleton guard: a slow sweep doesnt pile up across rapid ticks', async () => {
    // Without seeded submissions the sweep is a no-op and the assertion below
    // would pass vacuously (tracker.max stays at 0). Seed 16 rows so each
    // sweep actually runs 16 probes — then a singleton breach is visible as
    // tracker.max exceeding livenessProbeConcurrency.
    addBoard('tech', { boardId: slugToBoardId('tech') });
    for (let i = 0; i < 16; i++) {
      addSubmission(`bzz://s${i}`, {
        boardId: 'tech', kind: 'post', contentRef: `bzz://c${i}`,
        blockNumber: 1, logIndex: i, ingestedAt: 0,
      });
    }

    // Slow probes so the sweep takes long enough to span multiple ticks.
    const tracker = trackConcurrency(mockIsRetrievable, { delayMs: 30, returnValue: true });
    // Force the timer-gate to admit every tick.
    setMeta('last_death_sweep_at', '0');

    const originalInterval = config.livenessCheckInterval;
    config.livenessCheckInterval = 5;
    let handle;
    try {
      handle = startLivenessScheduler();
      await new Promise((r) => setTimeout(r, 60)); // ~12 tick attempts
    } finally {
      config.livenessCheckInterval = originalInterval;
      await stopLivenessScheduler(handle);
    }

    // Inside one sweep, mapWithConcurrency caps in-flight at livenessProbeConcurrency.
    // If a second sweep started concurrently, tracker.max would shoot past that cap.
    assert.ok(mockIsRetrievable.mock.callCount() >= 16, `probes never ran: ${mockIsRetrievable.mock.callCount()}`);
    assert.ok(
      tracker.max <= config.livenessProbeConcurrency,
      `singleton breached: ${tracker.max} concurrent probes (cap = ${config.livenessProbeConcurrency})`,
    );
  });
});
