import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from '../helpers/fixtures.js';

setupTestEnv();

const { sleepInterruptible, wake, _resetForTest } = await import('../../src/chain/subscribe.js');

describe('sleepInterruptible / wake', () => {
  beforeEach(() => _resetForTest());

  it('sleep resolves on timeout when not woken', async () => {
    const start = Date.now();
    await sleepInterruptible(20);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 15, `expected ~20ms; got ${elapsed}ms`);
  });

  it('wake() interrupts an in-progress sleep early', async () => {
    const start = Date.now();
    const sleeping = sleepInterruptible(10_000);
    setTimeout(() => wake(), 5);
    await sleeping;
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `expected interrupt; took ${elapsed}ms`);
  });

  it('wake() arriving between sleeps is consumed by the next sleep', async () => {
    // The race the WP6 design must close: a WS event lands while pollOnce is
    // running, between two sleep cycles — without a pending-wake flag this is
    // silently lost and the next sleep waits the full POLL_INTERVAL.
    wake();

    const start = Date.now();
    await sleepInterruptible(10_000);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, `expected immediate return; took ${elapsed}ms`);
  });

  it('a consumed pending wake does not affect the sleep after it', async () => {
    wake();
    await sleepInterruptible(10_000); // consumes the pending wake
    const start = Date.now();
    await sleepInterruptible(15);     // no pending wake → real sleep
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 10, `expected ~15ms; got ${elapsed}ms`);
  });

  it('multiple wake()s during one sleep are coalesced', async () => {
    const sleeping = sleepInterruptible(10_000);
    setTimeout(() => { wake(); wake(); wake(); }, 5);
    await sleeping;
    // The extra wakes set wakePending; _resetForTest in beforeEach clears it
    // for the next test, so we don't need to drain it here.
  });

  it('wake() before any sleep is idempotent — multiple calls collapse to one pending wake', async () => {
    wake();
    wake();
    wake();

    const start = Date.now();
    await sleepInterruptible(10_000);  // consumes the (single) pending wake
    assert.ok(Date.now() - start < 50);

    const start2 = Date.now();
    await sleepInterruptible(15);      // no more pending — real sleep
    assert.ok(Date.now() - start2 >= 10);
  });
});
