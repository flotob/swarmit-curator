import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, resetDb } from '../../src/db/sqlite.js';
import { insertVoteEvent, getRecentDelta, getRecentDeltasBatch } from '../../src/db/repos/vote-events.js';

before(() => initDb(':memory:'));
after(() => closeDb());
beforeEach(() => resetDb());

const BASE_TS = 1700000000000;

describe('insertVoteEvent', () => {
  it('inserts a vote event', () => {
    insertVoteEvent({
      submissionRef: 'bzz://a', voter: '0x1', direction: 1, previousDirection: 0,
      blockNumber: 100, logIndex: 0, blockTimestampMs: BASE_TS,
    });
    assert.equal(getRecentDelta('bzz://a', 0), 1);
  });

  it('is idempotent (INSERT OR IGNORE)', () => {
    const event = {
      submissionRef: 'bzz://a', voter: '0x1', direction: 1, previousDirection: 0,
      blockNumber: 100, logIndex: 0, blockTimestampMs: BASE_TS,
    };
    insertVoteEvent(event);
    insertVoteEvent(event);
    assert.equal(getRecentDelta('bzz://a', 0), 1);
  });

  it('computes delta = direction - previousDirection', () => {
    insertVoteEvent({
      submissionRef: 'bzz://a', voter: '0x1', direction: -1, previousDirection: 1,
      blockNumber: 100, logIndex: 0, blockTimestampMs: BASE_TS,
    });
    assert.equal(getRecentDelta('bzz://a', 0), -2); // -1 - 1
  });
});

describe('getRecentDelta', () => {
  it('sums deltas since cutoff', () => {
    insertVoteEvent({
      submissionRef: 'bzz://a', voter: '0x1', direction: 1, previousDirection: 0,
      blockNumber: 100, logIndex: 0, blockTimestampMs: BASE_TS,
    });
    insertVoteEvent({
      submissionRef: 'bzz://a', voter: '0x2', direction: 1, previousDirection: 0,
      blockNumber: 101, logIndex: 0, blockTimestampMs: BASE_TS + 5000,
    });

    assert.equal(getRecentDelta('bzz://a', BASE_TS), 2);
  });

  it('excludes events before cutoff', () => {
    insertVoteEvent({
      submissionRef: 'bzz://a', voter: '0x1', direction: 1, previousDirection: 0,
      blockNumber: 100, logIndex: 0, blockTimestampMs: BASE_TS - 10000,
    });
    insertVoteEvent({
      submissionRef: 'bzz://a', voter: '0x2', direction: 1, previousDirection: 0,
      blockNumber: 101, logIndex: 0, blockTimestampMs: BASE_TS + 5000,
    });

    assert.equal(getRecentDelta('bzz://a', BASE_TS), 1);
  });

  it('returns 0 for unknown submission', () => {
    assert.equal(getRecentDelta('bzz://unknown', 0), 0);
  });
});

describe('getRecentDeltasBatch', () => {
  it('returns Map with deltas per submission', () => {
    insertVoteEvent({
      submissionRef: 'bzz://a', voter: '0x1', direction: 1, previousDirection: 0,
      blockNumber: 100, logIndex: 0, blockTimestampMs: BASE_TS,
    });
    insertVoteEvent({
      submissionRef: 'bzz://b', voter: '0x1', direction: 1, previousDirection: 0,
      blockNumber: 100, logIndex: 1, blockTimestampMs: BASE_TS,
    });
    insertVoteEvent({
      submissionRef: 'bzz://b', voter: '0x2', direction: 1, previousDirection: 0,
      blockNumber: 101, logIndex: 0, blockTimestampMs: BASE_TS,
    });

    const deltas = getRecentDeltasBatch(['bzz://a', 'bzz://b', 'bzz://c'], BASE_TS);
    assert.equal(deltas.get('bzz://a'), 1);
    assert.equal(deltas.get('bzz://b'), 2);
    assert.equal(deltas.has('bzz://c'), false); // no events
  });

  it('returns empty Map for empty input', () => {
    const deltas = getRecentDeltasBatch([], 0);
    assert.equal(deltas.size, 0);
  });
});
