import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TYPES } from '../../src/protocol/constants.js';
import {
  buildBoard, buildPost, buildReply, buildSubmission,
  buildUserFeedIndex, buildBoardIndex, buildThreadIndex,
  buildGlobalIndex, buildCuratorProfile,
  validateBoard, validatePost, validateReply, validateSubmission,
  validateUserFeedIndex, validateBoardIndex, validateThreadIndex,
  validateGlobalIndex, validateCuratorProfile,
  validate,
} from '../../src/protocol/objects.js';
import {
  VALID_HEX, VALID_BZZ, VALID_BZZ_2, VALID_BZZ_3,
  VALID_ADDRESS, validAuthor, validBody,
  validBoard, validPost, validReply,
  validSubmissionPost, validSubmissionReply,
  validUserFeedIndex, validBoardIndex, validThreadIndex,
  validGlobalIndex, validCuratorProfile,
} from '../helpers/fixtures.js';

// ===========================================
// Builders
// ===========================================

describe('buildBoard', () => {
  it('produces correct protocol field', () => {
    const board = buildBoard({ slug: 'gen', title: 'Gen', description: 'd', governance: {} });
    assert.equal(board.protocol, TYPES.BOARD);
  });

  it('defaults boardId to slug', () => {
    const board = buildBoard({ slug: 'gen', title: 'Gen', description: 'd', governance: {} });
    assert.equal(board.boardId, 'gen');
  });

  it('accepts explicit boardId', () => {
    const board = buildBoard({ boardId: 'custom', slug: 'gen', title: 'Gen', description: 'd', governance: {} });
    assert.equal(board.boardId, 'custom');
  });

  it('sets createdAt to a recent timestamp', () => {
    const before = Date.now();
    const board = buildBoard({ slug: 'x', title: 'x', description: 'x', governance: {} });
    assert.ok(board.createdAt >= before && board.createdAt <= Date.now());
  });
});

describe('buildPost', () => {
  it('produces correct protocol field', () => {
    const post = buildPost({ author: validAuthor(), title: 'T', body: validBody() });
    assert.equal(post.protocol, TYPES.POST);
  });

  it('sets createdAt', () => {
    const post = buildPost({ author: validAuthor(), title: 'T', body: validBody() });
    assert.equal(typeof post.createdAt, 'number');
  });
});

describe('buildReply', () => {
  it('produces correct protocol field', () => {
    const reply = buildReply({ author: validAuthor(), body: validBody() });
    assert.equal(reply.protocol, TYPES.REPLY);
  });

  it('sets createdAt', () => {
    const reply = buildReply({ author: validAuthor(), body: validBody() });
    assert.equal(typeof reply.createdAt, 'number');
  });
});

describe('buildSubmission', () => {
  it('produces correct protocol field', () => {
    const sub = buildSubmission({ boardId: 'gen', kind: 'post', contentRef: VALID_BZZ, author: validAuthor() });
    assert.equal(sub.protocol, TYPES.SUBMISSION);
  });

  it('kind: post excludes parent/root', () => {
    const sub = buildSubmission({ boardId: 'gen', kind: 'post', contentRef: VALID_BZZ, author: validAuthor() });
    assert.equal(sub.parentSubmissionId, undefined);
    assert.equal(sub.rootSubmissionId, undefined);
  });

  it('kind: reply includes parent/root', () => {
    const sub = buildSubmission({
      boardId: 'gen', kind: 'reply', contentRef: VALID_BZZ, author: validAuthor(),
      parentSubmissionId: VALID_BZZ_2, rootSubmissionId: VALID_BZZ_3,
    });
    assert.equal(sub.parentSubmissionId, VALID_BZZ_2);
    assert.equal(sub.rootSubmissionId, VALID_BZZ_3);
  });

  it('sets createdAt', () => {
    const sub = buildSubmission({ boardId: 'gen', kind: 'post', contentRef: VALID_BZZ, author: validAuthor() });
    assert.equal(typeof sub.createdAt, 'number');
  });
});

describe('buildUserFeedIndex', () => {
  it('defaults entries to empty array', () => {
    const ufi = buildUserFeedIndex({ author: VALID_ADDRESS });
    assert.deepEqual(ufi.entries, []);
  });

  it('sets updatedAt', () => {
    const ufi = buildUserFeedIndex({ author: VALID_ADDRESS });
    assert.equal(typeof ufi.updatedAt, 'number');
  });
});

describe('buildBoardIndex', () => {
  it('produces correct protocol', () => {
    const bi = buildBoardIndex({ boardId: 'gen', curator: VALID_ADDRESS, entries: [] });
    assert.equal(bi.protocol, TYPES.BOARD_INDEX);
  });
});

describe('buildThreadIndex', () => {
  it('produces correct protocol', () => {
    const ti = buildThreadIndex({ rootSubmissionId: VALID_BZZ, curator: VALID_ADDRESS, nodes: [] });
    assert.equal(ti.protocol, TYPES.THREAD_INDEX);
  });
});

describe('buildGlobalIndex', () => {
  it('produces correct protocol', () => {
    const gi = buildGlobalIndex({ curator: VALID_ADDRESS, entries: [] });
    assert.equal(gi.protocol, TYPES.GLOBAL_INDEX);
  });
});

describe('buildCuratorProfile', () => {
  it('produces correct protocol', () => {
    const cp = buildCuratorProfile({
      curator: VALID_ADDRESS, name: 'Test', description: 'd', globalIndexFeed: VALID_BZZ,
    });
    assert.equal(cp.protocol, TYPES.CURATOR);
  });
});

// ===========================================
// Validators — valid fixtures pass with 0 errors
// ===========================================

describe('validators pass for valid fixtures', () => {
  it('validateBoard', () => {
    assert.deepEqual(validateBoard(validBoard()), []);
  });

  it('validatePost', () => {
    assert.deepEqual(validatePost(validPost()), []);
  });

  it('validateReply', () => {
    assert.deepEqual(validateReply(validReply()), []);
  });

  it('validateSubmission (post)', () => {
    assert.deepEqual(validateSubmission(validSubmissionPost()), []);
  });

  it('validateSubmission (reply)', () => {
    assert.deepEqual(validateSubmission(validSubmissionReply()), []);
  });

  it('validateUserFeedIndex', () => {
    assert.deepEqual(validateUserFeedIndex(validUserFeedIndex()), []);
  });

  it('validateBoardIndex', () => {
    assert.deepEqual(validateBoardIndex(validBoardIndex()), []);
  });

  it('validateThreadIndex', () => {
    assert.deepEqual(validateThreadIndex(validThreadIndex()), []);
  });

  it('validateGlobalIndex', () => {
    assert.deepEqual(validateGlobalIndex(validGlobalIndex()), []);
  });

  it('validateCuratorProfile', () => {
    assert.deepEqual(validateCuratorProfile(validCuratorProfile()), []);
  });
});

// ===========================================
// Validators — missing/wrong fields
// ===========================================

describe('validators catch missing/wrong fields', () => {
  it('wrong protocol field produces error', () => {
    const board = { ...validBoard(), protocol: 'wrong' };
    const errors = validateBoard(board);
    assert.ok(errors.length > 0);
    assert.ok(errors.some(e => e.includes('protocol')));
  });

  it('missing required fields on board', () => {
    const errors = validateBoard({ protocol: TYPES.BOARD });
    assert.ok(errors.some(e => e.includes('boardId')));
    assert.ok(errors.some(e => e.includes('slug')));
    assert.ok(errors.some(e => e.includes('title')));
  });

  it('missing required fields on post', () => {
    const errors = validatePost({ protocol: TYPES.POST });
    assert.ok(errors.some(e => e.includes('author')));
    assert.ok(errors.some(e => e.includes('title')));
    assert.ok(errors.some(e => e.includes('body')));
  });

  it('missing required fields on reply', () => {
    const errors = validateReply({ protocol: TYPES.REPLY });
    assert.ok(errors.some(e => e.includes('author')));
    assert.ok(errors.some(e => e.includes('body')));
  });
});

// ===========================================
// validateSubmission specifics
// ===========================================

describe('validateSubmission specifics', () => {
  it('kind: post rejects parentSubmissionId', () => {
    const sub = { ...validSubmissionPost(), parentSubmissionId: VALID_BZZ_2 };
    const errors = validateSubmission(sub);
    assert.ok(errors.some(e => e.includes('parentSubmissionId')));
  });

  it('kind: post rejects rootSubmissionId', () => {
    const sub = { ...validSubmissionPost(), rootSubmissionId: VALID_BZZ_3 };
    const errors = validateSubmission(sub);
    assert.ok(errors.some(e => e.includes('rootSubmissionId')));
  });

  it('kind: reply requires parentSubmissionId as bzz://', () => {
    const sub = { ...validSubmissionReply(), parentSubmissionId: VALID_HEX };
    const errors = validateSubmission(sub);
    assert.ok(errors.some(e => e.includes('parentSubmissionId')));
  });

  it('kind: reply requires rootSubmissionId as bzz://', () => {
    const sub = { ...validSubmissionReply(), rootSubmissionId: VALID_HEX };
    const errors = validateSubmission(sub);
    assert.ok(errors.some(e => e.includes('rootSubmissionId')));
  });

  it('kind: reply rejects bare hex refs', () => {
    const sub = {
      ...validSubmissionReply(),
      parentSubmissionId: VALID_HEX,
      rootSubmissionId: VALID_HEX,
    };
    const errors = validateSubmission(sub);
    assert.ok(errors.some(e => e.includes('parentSubmissionId')));
    assert.ok(errors.some(e => e.includes('rootSubmissionId')));
  });

  it('unknown kind produces error', () => {
    const sub = { ...validSubmissionPost(), kind: 'unknown' };
    const errors = validateSubmission(sub);
    assert.ok(errors.some(e => e.includes('kind')));
  });
});

// ===========================================
// Index validators — nested entry checks
// ===========================================

describe('validateUserFeedIndex entries', () => {
  it('rejects entries missing submissionId', () => {
    const ufi = {
      ...validUserFeedIndex(),
      entries: [{ submissionRef: VALID_BZZ, boardId: 'gen', kind: 'post', createdAt: 1 }],
    };
    const errors = validateUserFeedIndex(ufi);
    assert.ok(errors.some(e => e.includes('submissionId')));
  });

  it('rejects entries with bare hex submissionId', () => {
    const ufi = {
      ...validUserFeedIndex(),
      entries: [{ submissionId: VALID_HEX, submissionRef: VALID_BZZ, boardId: 'gen', kind: 'post', createdAt: 1 }],
    };
    const errors = validateUserFeedIndex(ufi);
    assert.ok(errors.some(e => e.includes('submissionId')));
  });
});

describe('validateBoardIndex entries', () => {
  it('rejects entries missing submissionRef', () => {
    const bi = {
      ...validBoardIndex(),
      entries: [{ submissionId: VALID_BZZ }],
    };
    const errors = validateBoardIndex(bi);
    assert.ok(errors.some(e => e.includes('submissionRef')));
  });
});

describe('validateThreadIndex nodes', () => {
  it('rejects nodes missing depth', () => {
    const ti = {
      ...validThreadIndex(),
      nodes: [{ submissionId: VALID_BZZ, parentSubmissionId: null }],
    };
    const errors = validateThreadIndex(ti);
    assert.ok(errors.some(e => e.includes('depth')));
  });

  it('rejects nodes with invalid parentSubmissionId (bare hex)', () => {
    const ti = {
      ...validThreadIndex(),
      nodes: [{ submissionId: VALID_BZZ, parentSubmissionId: VALID_HEX, depth: 1 }],
    };
    const errors = validateThreadIndex(ti);
    assert.ok(errors.some(e => e.includes('parentSubmissionId')));
  });
});

describe('validateGlobalIndex entries', () => {
  it('rejects entries missing boardId', () => {
    const gi = {
      ...validGlobalIndex(),
      entries: [{ submissionId: VALID_BZZ, submissionRef: VALID_BZZ }],
    };
    const errors = validateGlobalIndex(gi);
    assert.ok(errors.some(e => e.includes('boardId')));
  });
});

// ===========================================
// Generic validate()
// ===========================================

describe('validate()', () => {
  it('dispatches to correct validator based on protocol', () => {
    const result = validate(validBoard());
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('unknown protocol returns error', () => {
    const result = validate({ protocol: 'unknown/type' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('unknown protocol')));
  });

  it('missing protocol returns error', () => {
    const result = validate({ foo: 'bar' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('protocol')));
  });

  it('non-object input returns error', () => {
    const result = validate(null);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('object is required')));
  });

  it('string input returns error', () => {
    const result = validate('not an object');
    assert.equal(result.valid, false);
  });
});
