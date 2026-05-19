import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from '../helpers/fixtures.js';

setupTestEnv();
// This file exercises the resurrection path, which is gated off by default.
process.env.LIVENESS_RECHECK_DEAD = 'true';

// --- Mock the sweep implementations; this file tests the orchestration only ---

const mockDeathSweep = mock.fn(async () => ({ changedBoards: new Set() }));
const mockResurrectionSweep = mock.fn(async () => ({ changedBoards: new Set() }));
mock.module('../../src/indexer/liveness.js', {
  namedExports: { runDeathSweep: mockDeathSweep, runResurrectionSweep: mockResurrectionSweep },
});

const { runLivenessSweeps } = await import('../../src/indexer/orchestrator.js');
const { default: config } = await import('../../src/config.js');
const {
  initDb, closeDb, resetDb, setMeta, getMeta,
  getRepublishBoards, getRepublishGlobal,
} = await import('../../src/indexer/state.js');

before(() => initDb(':memory:'));
after(() => closeDb());
beforeEach(() => {
  resetDb();
  for (const m of [mockDeathSweep, mockResurrectionSweep]) {
    m.mock.resetCalls();
    m.mock.mockImplementation(async () => ({ changedBoards: new Set() }));
  }
});

// Far enough past epoch that both sweep timers read as due against an unset meta.
const NOW = 10_000_000_000;

describe('runLivenessSweeps', () => {
  it('runs the death sweep when its timer is due and records the run', async () => {
    await runLivenessSweeps(new Set(), NOW);
    assert.equal(mockDeathSweep.mock.callCount(), 1);
    assert.equal(getMeta('last_death_sweep_at'), String(NOW));
  });

  it('skips the death sweep when its timer is not yet due', async () => {
    setMeta('last_death_sweep_at', String(NOW - 1000));
    await runLivenessSweeps(new Set(), NOW);
    assert.equal(mockDeathSweep.mock.callCount(), 0);
  });

  it('runs the resurrection sweep when recheck-dead is enabled and due', async () => {
    await runLivenessSweeps(new Set(), NOW);
    assert.equal(mockResurrectionSweep.mock.callCount(), 1);
    assert.equal(getMeta('last_resurrection_sweep_at'), String(NOW));
  });

  it('folds swept boards into changedBoards and marks them for republish', async () => {
    mockDeathSweep.mock.mockImplementation(async () => ({ changedBoards: new Set(['tech']) }));
    mockResurrectionSweep.mock.mockImplementation(async () => ({ changedBoards: new Set(['art']) }));

    const changedBoards = new Set();
    await runLivenessSweeps(changedBoards, NOW);

    assert.deepEqual([...changedBoards].sort(), ['art', 'tech']);
    assert.ok(getRepublishBoards().has('tech'));
    assert.ok(getRepublishBoards().has('art'));
    assert.equal(getRepublishGlobal(), true);
  });

  it('sets no republish markers when the sweeps change nothing', async () => {
    await runLivenessSweeps(new Set(), NOW);
    assert.equal(getRepublishBoards().size, 0);
    assert.equal(getRepublishGlobal(), false);
  });

  it('does nothing when livenessEnabled is false', async () => {
    const original = config.livenessEnabled;
    config.livenessEnabled = false;
    try {
      const changedBoards = new Set();
      await runLivenessSweeps(changedBoards, NOW);
      assert.equal(mockDeathSweep.mock.callCount(), 0);
      assert.equal(mockResurrectionSweep.mock.callCount(), 0);
      assert.equal(changedBoards.size, 0);
      assert.equal(getMeta('last_death_sweep_at'), null);
    } finally {
      config.livenessEnabled = original;
    }
  });
});
