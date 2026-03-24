import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestEnv, VALID_BZZ, VALID_BZZ_2, VALID_BZZ_3 } from '../helpers/fixtures.js';

setupTestEnv();

const config = (await import('../../src/config.js')).default;
const {
  loadState, saveState,
  getLastProcessedBlock, setLastProcessedBlock,
  getBoards, addBoard, getKnownBoardSlugs,
  getSubmissions, addSubmission, getSubmissionsForBoard,
  getRootSubmissions, getRepliesForRoot,
  getFeed, setFeed,
  getRetrySubmissions, setRetrySubmissions,
  getRepublishBoards, setRepublishBoards,
  getRepublishGlobal, setRepublishGlobal,
  getRepublishProfile, setRepublishProfile,
  getPublishedBoardSlugs, setPublishedBoardSlugs,
} = await import('../../src/indexer/state.js');

let tmpDir;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'swarmit-test-'));
});

after(async () => {
  await rm(tmpDir, { recursive: true });
});

beforeEach(() => {
  // Point state file to a unique temp file
  config.stateFile = join(tmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  // Reset in-memory state
  setLastProcessedBlock(-1);
  getBoards().clear();
  getSubmissions().clear();
  setRetrySubmissions([]);
  setRepublishBoards(new Set());
  setRepublishGlobal(false);
  setRepublishProfile(false);
  setPublishedBoardSlugs([]);
});

// =============================================
// Save + load round-trip
// =============================================

describe('save + load round-trip', () => {
  it('preserves all fields', async () => {
    setLastProcessedBlock(42);
    addBoard('test-board', { boardId: 'test-board', slug: 'test-board' });
    addSubmission(VALID_BZZ, {
      boardId: 'test-board', kind: 'post', contentRef: VALID_BZZ_2,
      blockNumber: 10, logIndex: 0, author: '0xabc',
    });
    setFeed('test-feed', 'ab'.repeat(32));
    setPublishedBoardSlugs(['test-board']);
    setRetrySubmissions([{ submissionRef: VALID_BZZ, author: '0xabc', blockNumber: 10, logIndex: 0 }]);
    setRepublishBoards(new Set(['test-board']));
    setRepublishGlobal(true);
    setRepublishProfile(true);

    await saveState();

    // Reset everything
    setLastProcessedBlock(0);
    getBoards().clear();
    getSubmissions().clear();
    setRetrySubmissions([]);
    setRepublishBoards(new Set());
    setRepublishGlobal(false);
    setRepublishProfile(false);
    setPublishedBoardSlugs([]);

    const loaded = await loadState();
    assert.equal(loaded, true);
    assert.equal(getLastProcessedBlock(), 42);
    assert.equal(getBoards().size, 1);
    assert.ok(getBoards().has('test-board'));
    assert.equal(getSubmissions().size, 1);
    assert.ok(getSubmissions().has(VALID_BZZ));
    assert.equal(getFeed('test-feed'), 'ab'.repeat(32));
    assert.deepEqual([...getPublishedBoardSlugs()], ['test-board']);
    assert.equal(getRetrySubmissions().length, 1);
    assert.equal(getRepublishBoards().size, 1);
    assert.ok(getRepublishBoards().has('test-board'));
    assert.equal(getRepublishGlobal(), true);
    assert.equal(getRepublishProfile(), true);
  });
});

// =============================================
// Atomic write
// =============================================

describe('atomic write', () => {
  it('temp file is cleaned up after save', async () => {
    await saveState();
    const files = await readdir(tmpDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    assert.equal(tmpFiles.length, 0);
  });
});

// =============================================
// Missing state file
// =============================================

describe('missing state file', () => {
  it('loadState returns false, fresh state', async () => {
    config.stateFile = join(tmpDir, 'nonexistent.json');
    const loaded = await loadState();
    assert.equal(loaded, false);
  });
});

// =============================================
// Corrupt state file
// =============================================

describe('corrupt state file', () => {
  it('loadState returns false with warning, fresh state', async () => {
    await writeFile(config.stateFile, 'not valid json!!!');
    const loaded = await loadState();
    assert.equal(loaded, false);
  });
});

// =============================================
// Retry state round-trip
// =============================================

describe('retry state fields survive round-trip', () => {
  it('retrySubmissions', async () => {
    setRetrySubmissions([{ submissionRef: VALID_BZZ }]);
    await saveState();
    setRetrySubmissions([]);
    await loadState();
    assert.equal(getRetrySubmissions().length, 1);
  });

  it('republishBoards', async () => {
    setRepublishBoards(new Set(['board-a', 'board-b']));
    await saveState();
    setRepublishBoards(new Set());
    await loadState();
    assert.equal(getRepublishBoards().size, 2);
  });

  it('republishGlobal', async () => {
    setRepublishGlobal(true);
    await saveState();
    setRepublishGlobal(false);
    await loadState();
    assert.equal(getRepublishGlobal(), true);
  });

  it('republishProfile', async () => {
    setRepublishProfile(true);
    await saveState();
    setRepublishProfile(false);
    await loadState();
    assert.equal(getRepublishProfile(), true);
  });
});

// =============================================
// Query accessors
// =============================================

describe('getSubmissionsForBoard', () => {
  it('filters correctly by board', () => {
    addSubmission(VALID_BZZ, { boardId: 'board-x', kind: 'post' });
    addSubmission(VALID_BZZ_2, { boardId: 'board-y', kind: 'post' });

    const results = getSubmissionsForBoard('board-x');
    assert.equal(results.length, 1);
    assert.ok(results.every(r => r.boardId === 'board-x'));
  });
});

describe('getRootSubmissions', () => {
  it('excludes replies', () => {
    const rootRef = VALID_BZZ;
    addSubmission(rootRef, { boardId: 'board-z', kind: 'post' });
    addSubmission(VALID_BZZ_2, { boardId: 'board-z', kind: 'reply', rootSubmissionId: rootRef });

    const roots = getRootSubmissions('board-z');
    assert.equal(roots.length, 1);
    assert.equal(roots[0].kind, 'post');
  });
});

describe('getRepliesForRoot', () => {
  it('finds all replies for a root', () => {
    const rootRef = VALID_BZZ;
    addSubmission(rootRef, { boardId: 'board-w', kind: 'post' });
    addSubmission(VALID_BZZ_2, { boardId: 'board-w', kind: 'reply', rootSubmissionId: rootRef });
    addSubmission(VALID_BZZ_3, { boardId: 'board-w', kind: 'reply', rootSubmissionId: rootRef });

    const replies = getRepliesForRoot(rootRef);
    assert.equal(replies.length, 2);
  });
});
