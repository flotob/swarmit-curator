import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// --- Mocks (must be registered before importing the module under test) ---

const mockIsRetrievable = mock.fn(async () => true);
mock.module('../../src/swarm/client.js', {
  namedExports: { isRetrievable: mockIsRetrievable },
});
mock.module('../../src/config.js', {
  defaultExport: {
    livenessStrikeThreshold: 2,
    livenessIngestGrace: 1000,
    livenessRecheckGiveUpAfter: 5000,
  },
});

const { runDeathSweep, runResurrectionSweep } = await import('../../src/indexer/liveness.js');
const { initDb, closeDb, resetDb, addSubmission, getSubmissionsForBoard, markStale } =
  await import('../../src/indexer/state.js');

before(() => initDb(':memory:'));
after(() => closeDb());
beforeEach(() => {
  resetDb();
  mockIsRetrievable.mock.resetCalls();
  mockIsRetrievable.mock.mockImplementation(async () => true);
});

const NOW = 1_000_000;

/** Add a submission; ingestedAt defaults to 0 (old → past the grace window). */
function addSub(ref, { contentRef = `${ref}-content`, ingestedAt = 0, board = 'tech', kind = 'post' } = {}) {
  addSubmission(ref, { boardId: board, kind, contentRef, ingestedAt });
}

/** Look up a single submission entry by ref. */
function entry(ref, board = 'tech') {
  return getSubmissionsForBoard(board).find((s) => s.submissionRef === ref);
}

describe('runDeathSweep', () => {
  it('all content retrievable → no strikes, no changed boards', async () => {
    addSub('bzz://a');
    addSub('bzz://b');
    const { changedBoards } = await runDeathSweep(NOW);
    assert.equal(changedBoards.size, 0);
    assert.equal(entry('bzz://a').unreachableStrikes, 0);
  });

  it('one failed check → one strike, not yet stale', async () => {
    addSub('bzz://a');
    mockIsRetrievable.mock.mockImplementation(async () => false);
    const { changedBoards } = await runDeathSweep(NOW);
    assert.equal(entry('bzz://a').unreachableStrikes, 1);
    assert.equal(entry('bzz://a').staleSince, null);
    assert.equal(changedBoards.size, 0);
  });

  it('strikes reaching the threshold → pruned, board reported', async () => {
    addSub('bzz://a');
    mockIsRetrievable.mock.mockImplementation(async () => false);
    await runDeathSweep(NOW);                            // strike 1
    const { changedBoards } = await runDeathSweep(NOW);  // strike 2 → stale
    assert.equal(entry('bzz://a').staleSince, NOW);
    assert.ok(changedBoards.has('tech'));
  });

  it('a recovered check resets the strike count', async () => {
    addSub('bzz://a');
    mockIsRetrievable.mock.mockImplementation(async () => false);
    await runDeathSweep(NOW);
    assert.equal(entry('bzz://a').unreachableStrikes, 1);

    mockIsRetrievable.mock.mockImplementation(async () => true);
    await runDeathSweep(NOW);
    assert.equal(entry('bzz://a').unreachableStrikes, 0);
  });

  it('submissions within the ingest grace window are skipped', async () => {
    addSub('bzz://old', { ingestedAt: 0 });
    addSub('bzz://recent', { ingestedAt: NOW }); // inside grace (NOW - 1000)
    mockIsRetrievable.mock.mockImplementation(async () => false);

    await runDeathSweep(NOW);

    assert.equal(mockIsRetrievable.mock.callCount(), 1); // only the old one probed
    assert.equal(entry('bzz://recent').unreachableStrikes, 0);
    assert.equal(entry('bzz://old').unreachableStrikes, 1);
  });

  it('a stewardship error counts as a failed check', async () => {
    addSub('bzz://a');
    mockIsRetrievable.mock.mockImplementation(async () => { throw new Error('timeout'); });
    await runDeathSweep(NOW);
    assert.equal(entry('bzz://a').unreachableStrikes, 1);
  });

  it('stale submissions are not re-checked by the death sweep', async () => {
    addSub('bzz://a');
    markStale('bzz://a', NOW);
    await runDeathSweep(NOW);
    assert.equal(mockIsRetrievable.mock.callCount(), 0);
  });

  it('reports only the boards with newly pruned submissions', async () => {
    addSub('bzz://x', { board: 'tech' });
    addSub('bzz://y', { board: 'art' });
    // only tech's content is unretrievable
    mockIsRetrievable.mock.mockImplementation(async (ref) => ref !== 'bzz://x-content');

    await runDeathSweep(NOW);                           // strike 1
    const { changedBoards } = await runDeathSweep(NOW); // strike 2 → tech pruned

    assert.deepEqual([...changedBoards], ['tech']);
    assert.equal(entry('bzz://y', 'art').staleSince, null);
  });
});

describe('runResurrectionSweep', () => {
  it('a stale submission that is retrievable again is restored', async () => {
    addSub('bzz://a');
    markStale('bzz://a', NOW - 1000); // within the give-up window
    const { changedBoards } = await runResurrectionSweep(NOW);
    assert.equal(entry('bzz://a').staleSince, null);
    assert.equal(entry('bzz://a').unreachableStrikes, 0);
    assert.ok(changedBoards.has('tech'));
  });

  it('a stale submission still unretrievable stays stale', async () => {
    addSub('bzz://a');
    markStale('bzz://a', NOW - 1000);
    mockIsRetrievable.mock.mockImplementation(async () => false);
    const { changedBoards } = await runResurrectionSweep(NOW);
    assert.equal(entry('bzz://a').staleSince, NOW - 1000);
    assert.equal(changedBoards.size, 0);
  });

  it('abandoned submissions (stale past the give-up window) are not re-checked', async () => {
    addSub('bzz://a');
    markStale('bzz://a', NOW - 10_000); // older than give-up cutoff (NOW - 5000)
    await runResurrectionSweep(NOW);
    assert.equal(mockIsRetrievable.mock.callCount(), 0);
    assert.equal(entry('bzz://a').staleSince, NOW - 10_000);
  });

  it('live submissions are not touched by the resurrection sweep', async () => {
    addSub('bzz://a');
    await runResurrectionSweep(NOW);
    assert.equal(mockIsRetrievable.mock.callCount(), 0);
  });
});
