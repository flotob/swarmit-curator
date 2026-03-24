import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIngestedSubmission,
  validateIngestedContent,
  validateReplyConsistency,
} from '../../src/indexer/validator.js';
import {
  VALID_BZZ, VALID_BZZ_2, VALID_BZZ_3, VALID_HEX,
  BOARD_SLUGS, validSubmissionPost, validSubmissionReply,
  validPost, validReply,
} from '../helpers/fixtures.js';

// =============================================
// validateIngestedSubmission
// =============================================

describe('validateIngestedSubmission', () => {
  it('valid submission + known board passes', () => {
    const result = validateIngestedSubmission(validSubmissionPost(), BOARD_SLUGS);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('valid submission + unknown board fails with "not registered"', () => {
    const sub = { ...validSubmissionPost(), boardId: 'nonexistent' };
    const result = validateIngestedSubmission(sub, BOARD_SLUGS);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('not registered')));
  });

  it('missing protocol field fails', () => {
    const sub = { ...validSubmissionPost() };
    delete sub.protocol;
    const result = validateIngestedSubmission(sub, BOARD_SLUGS);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('protocol')));
  });

  it('invalid contentRef (bare hex, not bzz://) fails', () => {
    const sub = { ...validSubmissionPost(), contentRef: VALID_HEX };
    const result = validateIngestedSubmission(sub, BOARD_SLUGS);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('contentRef')));
  });

  it('missing author.address fails', () => {
    const sub = { ...validSubmissionPost(), author: { userFeed: VALID_BZZ } };
    const result = validateIngestedSubmission(sub, BOARD_SLUGS);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('author')));
  });
});

// =============================================
// validateIngestedContent
// =============================================

describe('validateIngestedContent', () => {
  it('valid post passes', () => {
    const result = validateIngestedContent(validPost(), 'post');
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('valid reply passes', () => {
    const result = validateIngestedContent(validReply(), 'reply');
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('post with missing title fails', () => {
    const post = { ...validPost() };
    delete post.title;
    const result = validateIngestedContent(post, 'post');
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('title')));
  });

  it('reply with missing body.text fails', () => {
    const reply = { ...validReply(), body: { kind: 'markdown' } };
    const result = validateIngestedContent(reply, 'reply');
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('body.text')));
  });

  it('wrong expectedKind fails', () => {
    const result = validateIngestedContent(validPost(), 'unknown');
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('unexpected kind')));
  });

  it('null content fails', () => {
    const result = validateIngestedContent(null, 'post');
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('null')));
  });
});

// =============================================
// validateReplyConsistency
// =============================================

describe('validateReplyConsistency', () => {
  const knownSubmissions = new Map([
    [VALID_BZZ_2, { kind: 'post' }],
    [VALID_BZZ_3, { kind: 'post' }],
  ]);

  it('reply with known parent + root passes', () => {
    const result = validateReplyConsistency(validSubmissionReply(), knownSubmissions);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('reply with unknown parent fails', () => {
    const sub = { ...validSubmissionReply(), parentSubmissionId: VALID_BZZ };
    const result = validateReplyConsistency(sub, knownSubmissions);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('parent')));
  });

  it('reply with unknown root fails', () => {
    const sub = { ...validSubmissionReply(), rootSubmissionId: VALID_BZZ };
    const result = validateReplyConsistency(sub, knownSubmissions);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('root')));
  });

  it('reply with missing parentSubmissionId fails', () => {
    const sub = { ...validSubmissionReply() };
    delete sub.parentSubmissionId;
    const result = validateReplyConsistency(sub, knownSubmissions);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('parent')));
  });

  it('non-reply (kind: post) passes (skipped)', () => {
    const result = validateReplyConsistency(validSubmissionPost(), knownSubmissions);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });
});
