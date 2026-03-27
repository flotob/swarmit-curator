/**
 * Protocol object builders and validators.
 * Single source of truth for building and validating all 9 protocol object types.
 * Matches swarm-message-board-v1-schemas.md exactly.
 * Pure logic, no I/O.
 */

import { TYPES } from './constants.js';
import { isValidRef, isValidBzzRef } from './references.js';

// ============================================
// Shared validation helpers
// ============================================

function requireString(obj, field) {
  if (!obj[field] || typeof obj[field] !== 'string') {
    return `${field} is required and must be a non-empty string`;
  }
  return null;
}

function requireNumber(obj, field) {
  if (typeof obj[field] !== 'number' || !Number.isFinite(obj[field])) {
    return `${field} is required and must be a finite number`;
  }
  return null;
}

function requireObject(obj, field) {
  if (!obj[field] || typeof obj[field] !== 'object' || Array.isArray(obj[field])) {
    return `${field} is required and must be an object`;
  }
  return null;
}

function requireArray(obj, field) {
  if (!Array.isArray(obj[field])) {
    return `${field} is required and must be an array`;
  }
  return null;
}

function requireRef(obj, field) {
  const err = requireString(obj, field);
  if (err) return err;
  if (!isValidRef(obj[field])) {
    return `${field} must be a valid bzz:// reference or 64-char hex`;
  }
  return null;
}

function requireBzzRef(obj, field) {
  const err = requireString(obj, field);
  if (err) return err;
  if (!isValidBzzRef(obj[field])) {
    return `${field} must be a normalized bzz://<hex> reference`;
  }
  return null;
}

function requireProtocol(obj, expectedType) {
  if (obj.protocol !== expectedType) {
    return `protocol must be "${expectedType}", got "${obj.protocol}"`;
  }
  return null;
}

function requireAuthorRef(obj) {
  const err = requireObject(obj, 'author');
  if (err) return [err];
  const errors = [];
  if (!obj.author.address || typeof obj.author.address !== 'string') {
    errors.push('author.address is required');
  }
  if (!obj.author.userFeed || !isValidBzzRef(obj.author.userFeed)) {
    errors.push('author.userFeed must be a normalized bzz:// reference');
  }
  return errors.length ? errors : null;
}

function requireBody(obj) {
  const err = requireObject(obj, 'body');
  if (err) return [err];
  const errors = [];
  if (!obj.body.kind || typeof obj.body.kind !== 'string') {
    errors.push('body.kind is required');
  }
  if (!obj.body.text || typeof obj.body.text !== 'string') {
    errors.push('body.text is required');
  }
  return errors.length ? errors : null;
}

function validateOptionalBody(obj) {
  if (!obj.body) return null;
  if (typeof obj.body !== 'object' || Array.isArray(obj.body)) {
    return ['body must be an object'];
  }
  const errors = [];
  if (!obj.body.kind || typeof obj.body.kind !== 'string') {
    errors.push('body.kind is required when body is present');
  }
  if (!obj.body.text || typeof obj.body.text !== 'string') {
    errors.push('body.text must be a non-empty string when body is present');
  }
  return errors.length ? errors : null;
}

const ABSOLUTE_URL_RE = /^https?:\/\/.+/;

function validateOptionalLink(obj) {
  if (!obj.link) return null;
  if (typeof obj.link !== 'object' || Array.isArray(obj.link)) {
    return ['link must be an object'];
  }
  const errors = [];
  if (!obj.link.url || typeof obj.link.url !== 'string') {
    errors.push('link.url is required when link is present');
  } else if (!ABSOLUTE_URL_RE.test(obj.link.url)) {
    errors.push('link.url must be an absolute http:// or https:// URL');
  }
  if (obj.link.thumbnailRef != null) {
    if (!isValidBzzRef(obj.link.thumbnailRef)) {
      errors.push('link.thumbnailRef must be a normalized bzz:// reference');
    }
  }
  return errors.length ? errors : null;
}

function validateEntries(entries, requiredFields, label) {
  const errors = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry !== 'object') {
      errors.push(`${label}[${i}] must be an object`);
      continue;
    }
    for (const field of requiredFields) {
      if (field.bzz) {
        if (!entry[field.name] || !isValidBzzRef(entry[field.name])) {
          errors.push(`${label}[${i}].${field.name} must be a normalized bzz:// reference`);
        }
      } else if (field.type === 'string') {
        if (!entry[field.name] || typeof entry[field.name] !== 'string') {
          errors.push(`${label}[${i}].${field.name} is required and must be a string`);
        }
      } else if (field.type === 'number') {
        if (typeof entry[field.name] !== 'number') {
          errors.push(`${label}[${i}].${field.name} is required and must be a number`);
        }
      }
    }
  }
  return errors.length ? errors : null;
}

function collectErrors(...checks) {
  const errors = [];
  for (const check of checks) {
    if (Array.isArray(check)) {
      errors.push(...check);
    } else if (check) {
      errors.push(check);
    }
  }
  return errors;
}

// ============================================
// Builders
// ============================================

/**
 * Build a board object.
 */
export function buildBoard({ boardId, slug, title, description, governance, rulesRef, endorsedCurators, defaultCurator, metadata }) {
  const obj = {
    protocol: TYPES.BOARD,
    boardId: boardId || slug,
    slug,
    title,
    description,
    createdAt: Date.now(),
    governance,
  };
  if (rulesRef) obj.rulesRef = rulesRef;
  if (endorsedCurators) obj.endorsedCurators = endorsedCurators;
  if (defaultCurator) obj.defaultCurator = defaultCurator;
  if (metadata) obj.metadata = metadata;
  return obj;
}

/**
 * Build a post object.
 */
export function buildPost({ author, title, body, link, attachments }) {
  const obj = {
    protocol: TYPES.POST,
    author,
    title,
    createdAt: Date.now(),
  };
  if (body) obj.body = body;
  if (link) obj.link = link;
  if (attachments && attachments.length > 0) obj.attachments = attachments;
  return obj;
}

/**
 * Build a reply object.
 */
export function buildReply({ author, body }) {
  return {
    protocol: TYPES.REPLY,
    author,
    body,
    createdAt: Date.now(),
  };
}

/**
 * Build a submission object.
 * Note: submissionId is NOT included — the Swarm reference after publish IS the identity.
 */
export function buildSubmission({ boardId, kind, contentRef, author, parentSubmissionId, rootSubmissionId, flair, metadata }) {
  const obj = {
    protocol: TYPES.SUBMISSION,
    boardId,
    kind,
    contentRef,
    author,
    createdAt: Date.now(),
  };
  if (kind === 'reply') {
    obj.parentSubmissionId = parentSubmissionId;
    obj.rootSubmissionId = rootSubmissionId;
  }
  if (flair) obj.flair = flair;
  if (metadata) obj.metadata = metadata;
  return obj;
}

/**
 * Build a userFeedIndex object.
 */
export function buildUserFeedIndex({ author, entries }) {
  return {
    protocol: TYPES.USER_FEED,
    author,
    updatedAt: Date.now(),
    entries: entries || [],
  };
}

/**
 * Build a boardIndex object (curator-produced).
 */
export function buildBoardIndex({ boardId, curator, entries, hidden }) {
  const obj = {
    protocol: TYPES.BOARD_INDEX,
    boardId,
    curator,
    updatedAt: Date.now(),
    entries: entries || [],
  };
  if (hidden && hidden.length > 0) obj.hidden = hidden;
  return obj;
}

/**
 * Build a threadIndex object (curator-produced).
 */
export function buildThreadIndex({ rootSubmissionId, curator, nodes, hidden }) {
  const obj = {
    protocol: TYPES.THREAD_INDEX,
    rootSubmissionId,
    curator,
    updatedAt: Date.now(),
    nodes: nodes || [],
  };
  if (hidden && hidden.length > 0) obj.hidden = hidden;
  return obj;
}

/**
 * Build a globalIndex object (curator-produced).
 */
export function buildGlobalIndex({ curator, entries }) {
  return {
    protocol: TYPES.GLOBAL_INDEX,
    curator,
    updatedAt: Date.now(),
    entries: entries || [],
  };
}

/**
 * Build a curatorProfile object.
 */
export function buildCuratorProfile({ curator, name, description, globalIndexFeed, policyRef, boardFeeds }) {
  const obj = {
    protocol: TYPES.CURATOR,
    curator,
    name,
    description,
    globalIndexFeed,
  };
  if (policyRef) obj.policyRef = policyRef;
  if (boardFeeds) obj.boardFeeds = boardFeeds;
  return obj;
}

// ============================================
// Validators
// ============================================

/**
 * Validate a board object. Returns array of error strings, or empty array if valid.
 */
export function validateBoard(obj) {
  return collectErrors(
    requireProtocol(obj, TYPES.BOARD),
    requireString(obj, 'boardId'),
    requireString(obj, 'slug'),
    requireString(obj, 'title'),
    requireString(obj, 'description'),
    requireNumber(obj, 'createdAt'),
    requireObject(obj, 'governance'),
  );
}

/**
 * Validate a post object.
 */
export function validatePost(obj) {
  const result = collectErrors(
    requireProtocol(obj, TYPES.POST),
    requireAuthorRef(obj),
    requireString(obj, 'title'),
    requireNumber(obj, 'createdAt'),
    validateOptionalBody(obj),
    validateOptionalLink(obj),
  );

  // At least one of body, link, or attachments must be present
  const hasBody = !!(obj.body && obj.body.text);
  const hasLink = !!(obj.link && obj.link.url);
  const hasAttachments = Array.isArray(obj.attachments) && obj.attachments.length > 0;
  if (!hasBody && !hasLink && !hasAttachments) {
    result.push('post must contain at least one of: body, link, or attachments');
  }

  if (obj.attachments != null) {
    if (!Array.isArray(obj.attachments)) {
      result.push('attachments must be an array');
    } else if (obj.attachments.length > 0) {
      const attErrors = validateEntries(obj.attachments, [
        { name: 'reference', bzz: true },
        { name: 'contentType', type: 'string' },
      ], 'attachments');
      if (attErrors) result.push(...attErrors);
    }
  }

  return result;
}

/**
 * Validate a reply object.
 */
export function validateReply(obj) {
  return collectErrors(
    requireProtocol(obj, TYPES.REPLY),
    requireAuthorRef(obj),
    requireBody(obj),
    requireNumber(obj, 'createdAt'),
  );
}

/**
 * Validate a submission object.
 */
export function validateSubmission(obj) {
  const errors = collectErrors(
    requireProtocol(obj, TYPES.SUBMISSION),
    requireString(obj, 'boardId'),
    requireString(obj, 'kind'),
    requireBzzRef(obj, 'contentRef'),
    requireAuthorRef(obj),
    requireNumber(obj, 'createdAt'),
  );

  if (obj.kind === 'reply') {
    const parent = requireBzzRef(obj, 'parentSubmissionId');
    if (parent) errors.push(parent);
    const root = requireBzzRef(obj, 'rootSubmissionId');
    if (root) errors.push(root);
  } else if (obj.kind === 'post') {
    if (obj.parentSubmissionId) {
      errors.push('top-level posts must not include parentSubmissionId');
    }
    if (obj.rootSubmissionId) {
      errors.push('top-level posts must not include rootSubmissionId');
    }
  } else {
    errors.push('kind must be "post" or "reply"');
  }

  return errors;
}

/**
 * Validate a userFeedIndex object.
 */
export function validateUserFeedIndex(obj) {
  const errors = collectErrors(
    requireProtocol(obj, TYPES.USER_FEED),
    requireString(obj, 'author'),
    requireNumber(obj, 'updatedAt'),
    requireArray(obj, 'entries'),
  );
  if (Array.isArray(obj.entries)) {
    errors.push(...(validateEntries(obj.entries, [
      { name: 'submissionId', bzz: true },
      { name: 'submissionRef', bzz: true },
      { name: 'boardId', type: 'string' },
      { name: 'kind', type: 'string' },
      { name: 'createdAt', type: 'number' },
    ], 'entries') || []));
  }
  return errors;
}

/**
 * Validate a boardIndex object.
 */
export function validateBoardIndex(obj) {
  const errors = collectErrors(
    requireProtocol(obj, TYPES.BOARD_INDEX),
    requireString(obj, 'boardId'),
    requireString(obj, 'curator'),
    requireNumber(obj, 'updatedAt'),
    requireArray(obj, 'entries'),
  );
  if (Array.isArray(obj.entries)) {
    errors.push(...(validateEntries(obj.entries, [
      { name: 'submissionId', bzz: true },
      { name: 'submissionRef', bzz: true },
    ], 'entries') || []));
  }
  return errors;
}

/**
 * Validate a threadIndex object.
 */
export function validateThreadIndex(obj) {
  const errors = collectErrors(
    requireProtocol(obj, TYPES.THREAD_INDEX),
    requireBzzRef(obj, 'rootSubmissionId'),
    requireString(obj, 'curator'),
    requireNumber(obj, 'updatedAt'),
    requireArray(obj, 'nodes'),
  );
  if (Array.isArray(obj.nodes)) {
    errors.push(...(validateEntries(obj.nodes, [
      { name: 'submissionId', bzz: true },
      { name: 'depth', type: 'number' },
    ], 'nodes') || []));
    // parentSubmissionId is required but may be null for root node
    for (let i = 0; i < obj.nodes.length; i++) {
      const node = obj.nodes[i];
      if (node && typeof node === 'object' && !('parentSubmissionId' in node)) {
        errors.push(`nodes[${i}].parentSubmissionId is required (null for root)`);
      } else if (node && node.parentSubmissionId !== null && !isValidBzzRef(node.parentSubmissionId)) {
        errors.push(`nodes[${i}].parentSubmissionId must be null or a normalized bzz:// reference`);
      }
    }
  }
  return errors;
}

/**
 * Validate a globalIndex object.
 */
export function validateGlobalIndex(obj) {
  const errors = collectErrors(
    requireProtocol(obj, TYPES.GLOBAL_INDEX),
    requireString(obj, 'curator'),
    requireNumber(obj, 'updatedAt'),
    requireArray(obj, 'entries'),
  );
  if (Array.isArray(obj.entries)) {
    errors.push(...(validateEntries(obj.entries, [
      { name: 'boardId', type: 'string' },
      { name: 'submissionId', bzz: true },
      { name: 'submissionRef', bzz: true },
    ], 'entries') || []));
  }
  return errors;
}

/**
 * Validate a curatorProfile object.
 */
export function validateCuratorProfile(obj) {
  return collectErrors(
    requireProtocol(obj, TYPES.CURATOR),
    requireString(obj, 'curator'),
    requireString(obj, 'name'),
    requireString(obj, 'description'),
    requireBzzRef(obj, 'globalIndexFeed'),
  );
}

const VALIDATORS = {
  [TYPES.BOARD]: validateBoard,
  [TYPES.POST]: validatePost,
  [TYPES.REPLY]: validateReply,
  [TYPES.SUBMISSION]: validateSubmission,
  [TYPES.USER_FEED]: validateUserFeedIndex,
  [TYPES.BOARD_INDEX]: validateBoardIndex,
  [TYPES.THREAD_INDEX]: validateThreadIndex,
  [TYPES.GLOBAL_INDEX]: validateGlobalIndex,
  [TYPES.CURATOR]: validateCuratorProfile,
};

/**
 * Validate any protocol object by dispatching on its protocol field.
 * Returns { valid: boolean, errors: string[] }
 */
export function validate(obj) {
  if (!obj || typeof obj !== 'object') {
    return { valid: false, errors: ['object is required'] };
  }
  if (!obj.protocol || typeof obj.protocol !== 'string') {
    return { valid: false, errors: ['protocol field is required'] };
  }

  const fn = VALIDATORS[obj.protocol];
  if (!fn) {
    return { valid: false, errors: [`unknown protocol type: ${obj.protocol}`] };
  }

  const errors = fn(obj);
  return { valid: errors.length === 0, errors };
}
