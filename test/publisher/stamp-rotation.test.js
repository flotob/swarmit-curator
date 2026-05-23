import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from '../helpers/fixtures.js';

setupTestEnv();

const { initDb, closeDb, resetDb } = await import('../../src/db/sqlite.js');
const { getMeta, setMeta } = await import('../../src/db/repos/meta.js');
const { runStampRotationCheck, ACTIVE_BATCH_META_KEY } = await import('../../src/publisher/stamp-rotation.js');

before(() => initDb(':memory:'));
after(() => closeDb());
beforeEach(() => resetDb());

const BATCH_A = 'a'.repeat(64);
const BATCH_B = 'b'.repeat(64);

describe('runStampRotationCheck', () => {
  it('first run (no stored batch) → treats as rotated, purges, records current', () => {
    // Simulate an existing DB with publish-hash cache from prior batches but no
    // active_batch_id meta key — this is the exact state of the production
    // curator on first deploy of this code, and the case that must heal.
    setMeta('last_published_hash:thread-x', 'h1');
    setMeta('last_published_hash:thread-y', 'h2');
    setMeta('last_published_ref:thread-x', 'r1');

    const result = runStampRotationCheck(BATCH_A);

    assert.equal(result.rotated, true);
    assert.equal(result.previous, null);
    assert.equal(result.purged, 3);
    assert.equal(getMeta('last_published_hash:thread-x'), null);
    assert.equal(getMeta('last_published_hash:thread-y'), null);
    assert.equal(getMeta('last_published_ref:thread-x'), null);
    assert.equal(getMeta(ACTIVE_BATCH_META_KEY), BATCH_A);
  });

  it('stored batch matches current → no-op', () => {
    setMeta(ACTIVE_BATCH_META_KEY, BATCH_A);
    setMeta('last_published_hash:thread-x', 'h1');

    const result = runStampRotationCheck(BATCH_A);

    assert.equal(result.rotated, false);
    assert.equal(result.previous, BATCH_A);
    assert.equal(result.purged, 0);
    assert.equal(getMeta('last_published_hash:thread-x'), 'h1');
  });

  it('stored batch differs → purges and records new batch', () => {
    setMeta(ACTIVE_BATCH_META_KEY, BATCH_A);
    setMeta('last_published_hash:thread-x', 'h1');
    setMeta('last_published_ref:thread-x', 'r1');

    const result = runStampRotationCheck(BATCH_B);

    assert.equal(result.rotated, true);
    assert.equal(result.previous, BATCH_A);
    assert.equal(result.purged, 2);
    assert.equal(getMeta(ACTIVE_BATCH_META_KEY), BATCH_B);
    assert.equal(getMeta('last_published_hash:thread-x'), null);
  });

  it('fresh DB (no cache, no stored batch) → records batch, purge is a no-op', () => {
    const result = runStampRotationCheck(BATCH_A);

    assert.equal(result.rotated, true);
    assert.equal(result.previous, null);
    assert.equal(result.purged, 0);
    assert.equal(getMeta(ACTIVE_BATCH_META_KEY), BATCH_A);
  });

  it('leaves unrelated meta keys alone on rotation', () => {
    setMeta('last_processed_block', '12345');
    setMeta('republish_global', 'true');
    setMeta('last_published_hash:thread-x', 'h1');

    runStampRotationCheck(BATCH_A);

    assert.equal(getMeta('last_processed_block'), '12345');
    assert.equal(getMeta('republish_global'), 'true');
    assert.equal(getMeta('last_published_hash:thread-x'), null);
  });

  it('throws if currentBatchId is missing', () => {
    assert.throws(() => runStampRotationCheck(undefined), /currentBatchId is required/);
    assert.throws(() => runStampRotationCheck(''), /currentBatchId is required/);
  });
});
