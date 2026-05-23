import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { slugToBoardId } from 'swarmit-protocol';
import { setupTestEnv } from '../helpers/fixtures.js';

setupTestEnv();

const { initDb, closeDb, resetDb } = await import('../../src/db/sqlite.js');
const { getMeta, setMeta, getRepublishGlobal, setRepublishGlobal } = await import('../../src/db/repos/meta.js');
const { addBoard } = await import('../../src/db/repos/boards.js');
const { getRepublishBoards, addRepublishBoard } = await import('../../src/db/repos/republish-boards.js');
const { runStampRotationCheck, ACTIVE_BATCH_META_KEY } = await import('../../src/publisher/stamp-rotation.js');

before(() => initDb(':memory:'));
after(() => closeDb());
beforeEach(() => resetDb());

const BATCH_A = 'a'.repeat(64);
const BATCH_B = 'b'.repeat(64);

const seedBoards = (...slugs) => {
  for (const slug of slugs) addBoard(slug, { boardId: slugToBoardId(slug) });
};

describe('runStampRotationCheck', () => {
  it('first run (no stored batch) → purges, marks all boards + global, records current', () => {
    // Simulate the production curator's first deploy: existing publish-hash
    // cache, known boards, but no active_batch_id breadcrumb.
    seedBoards('tech', 'random', 'crypto');
    setMeta('last_published_hash:thread-x', 'h1');
    setMeta('last_published_hash:thread-y', 'h2');
    setMeta('last_published_ref:thread-x', 'r1');

    const result = runStampRotationCheck(BATCH_A);

    assert.equal(result.rotated, true);
    assert.equal(result.previous, null);
    assert.equal(result.purged, 3);
    assert.equal(result.markedBoards, 3);
    assert.equal(getMeta('last_published_hash:thread-x'), null);
    assert.equal(getMeta('last_published_hash:thread-y'), null);
    assert.equal(getMeta('last_published_ref:thread-x'), null);
    assert.equal(getMeta(ACTIVE_BATCH_META_KEY), BATCH_A);
    assert.deepEqual([...getRepublishBoards()].sort(), ['crypto', 'random', 'tech']);
    assert.equal(getRepublishGlobal(), true);
  });

  it('stored batch matches current → no-op (republish state untouched)', () => {
    seedBoards('tech');
    setMeta(ACTIVE_BATCH_META_KEY, BATCH_A);
    setMeta('last_published_hash:thread-x', 'h1');

    const result = runStampRotationCheck(BATCH_A);

    assert.equal(result.rotated, false);
    assert.equal(result.markedBoards, 0);
    assert.equal(getMeta('last_published_hash:thread-x'), 'h1');
    assert.equal(getRepublishBoards().size, 0);
    assert.equal(getRepublishGlobal(), false);
  });

  it('stored batch differs → purges, marks every known board, records new batch', () => {
    seedBoards('tech', 'random');
    setMeta(ACTIVE_BATCH_META_KEY, BATCH_A);
    setMeta('last_published_hash:thread-x', 'h1');
    setMeta('last_published_ref:thread-x', 'r1');

    const result = runStampRotationCheck(BATCH_B);

    assert.equal(result.rotated, true);
    assert.equal(result.previous, BATCH_A);
    assert.equal(result.purged, 2);
    assert.equal(result.markedBoards, 2);
    assert.equal(getMeta(ACTIVE_BATCH_META_KEY), BATCH_B);
    assert.equal(getMeta('last_published_hash:thread-x'), null);
    assert.deepEqual([...getRepublishBoards()].sort(), ['random', 'tech']);
    assert.equal(getRepublishGlobal(), true);
  });

  it('fresh DB (no cache, no boards, no stored batch) → records batch, marked=0, purged=0', () => {
    const result = runStampRotationCheck(BATCH_A);

    assert.equal(result.rotated, true);
    assert.equal(result.previous, null);
    assert.equal(result.purged, 0);
    assert.equal(result.markedBoards, 0);
    assert.equal(getMeta(ACTIVE_BATCH_META_KEY), BATCH_A);
    assert.equal(getRepublishGlobal(), true);  // global flag still flips
  });

  it('rotation unions with an existing republish queue (does not clobber it)', () => {
    // The orchestrator may have left boards in the queue from a prior crashed
    // poll. Rotation should add to them, not replace.
    seedBoards('tech', 'random');
    setRepublishGlobal(true);
    // Pre-existing queue entry (simulating crash recovery).
    addRepublishBoard('tech');

    const result = runStampRotationCheck(BATCH_A);

    // markedBoards counts boards iterated, not boards newly added — both 'tech'
    // (already queued) and 'random' (added) are counted; addRepublishBoard is
    // INSERT OR IGNORE so re-marking is a no-op at the SQL level.
    assert.equal(result.markedBoards, 2);
    assert.deepEqual([...getRepublishBoards()].sort(), ['random', 'tech']);
    assert.equal(getRepublishGlobal(), true);
  });

  it('leaves unrelated meta keys alone on rotation', () => {
    setMeta('last_processed_block', '12345');
    setMeta('last_published_hash:thread-x', 'h1');

    runStampRotationCheck(BATCH_A);

    assert.equal(getMeta('last_processed_block'), '12345');
    assert.equal(getMeta('last_published_hash:thread-x'), null);
  });

  it('throws if currentBatchId is missing', () => {
    assert.throws(() => runStampRotationCheck(undefined), /currentBatchId is required/);
    assert.throws(() => runStampRotationCheck(''), /currentBatchId is required/);
  });
});
