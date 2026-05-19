import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv, VALID_HEX, VALID_BZZ } from '../helpers/fixtures.js';

setupTestEnv();

const { isRetrievable } = await import('../../src/swarm/client.js');

// --- fetch stub helpers ---

const originalFetch = globalThis.fetch;

/** Stub global fetch with a resolved Response-like object. */
function stubFetch(impl) {
  globalThis.fetch = mock.fn(impl);
  return globalThis.fetch;
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

describe('isRetrievable', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.timers.reset();
  });

  it('content retrievable → returns true', async () => {
    stubFetch(async () => jsonResponse({ isRetrievable: true }));
    assert.equal(await isRetrievable(VALID_BZZ), true);
  });

  it('content not retrievable → returns false', async () => {
    stubFetch(async () => jsonResponse({ isRetrievable: false }));
    assert.equal(await isRetrievable(VALID_BZZ), false);
  });

  it('missing isRetrievable field → returns false (strict === true)', async () => {
    stubFetch(async () => jsonResponse({}));
    assert.equal(await isRetrievable(VALID_BZZ), false);
  });

  it('hits GET /stewardship/{bare-hex} on the configured Bee node', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ isRetrievable: true }));
    await isRetrievable(VALID_BZZ);
    assert.equal(
      fetchMock.mock.calls[0].arguments[0],
      `http://localhost:1633/stewardship/${VALID_HEX}`,
    );
  });

  it('accepts a bare hex reference', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ isRetrievable: true }));
    assert.equal(await isRetrievable(VALID_HEX), true);
    assert.equal(
      fetchMock.mock.calls[0].arguments[0],
      `http://localhost:1633/stewardship/${VALID_HEX}`,
    );
  });

  it('non-2xx response → throws (caller treats as could-not-determine)', async () => {
    stubFetch(async () => jsonResponse(null, { ok: false, status: 500 }));
    await assert.rejects(() => isRetrievable(VALID_BZZ), /HTTP 500/);
  });

  it('transport error → propagates as a rejection', async () => {
    stubFetch(async () => { throw new Error('ECONNREFUSED'); });
    await assert.rejects(() => isRetrievable(VALID_BZZ), /ECONNREFUSED/);
  });

  it('passes an abort signal to fetch', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ isRetrievable: true }));
    await isRetrievable(VALID_BZZ);
    assert.ok(fetchMock.mock.calls[0].arguments[1].signal instanceof AbortSignal);
  });

  it('hung retrieval → times out, aborts the request, and rejects', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    stubFetch((_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('operation aborted')));
    }));
    const pending = isRetrievable(VALID_BZZ);
    mock.timers.tick(30_000);
    await assert.rejects(pending, /aborted/);
  });

  it('invalid reference → throws before any fetch', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ isRetrievable: true }));
    await assert.rejects(() => isRetrievable('not-a-ref'), /Invalid Swarm reference/);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});
