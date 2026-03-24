import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  refToHex, hexToBzz, isValidRef, isValidBzzRef,
  hexToBytes32, bytes32ToHex, refToBytes32, bytes32ToRef,
  slugToBoardId,
} from '../../src/protocol/references.js';
import {
  VALID_HEX, VALID_HEX_MIXED, VALID_BZZ,
  INVALID_HEX_SHORT, INVALID_HEX_LONG, INVALID_HEX_NONHEX,
  INVALID_BZZ_PATH, INVALID_BZZ_UPPER,
} from '../helpers/fixtures.js';

// =============================================
// refToHex
// =============================================

describe('refToHex', () => {
  it('bare 64-char hex returns lowercase hex', () => {
    assert.equal(refToHex(VALID_HEX), VALID_HEX);
  });

  it('bzz:// prefixed strips prefix and returns lowercase', () => {
    assert.equal(refToHex(VALID_BZZ), VALID_HEX);
  });

  it('mixed case is lowercased', () => {
    assert.equal(refToHex(VALID_HEX_MIXED), VALID_HEX_MIXED.toLowerCase());
  });

  it('too short returns empty string', () => {
    assert.equal(refToHex(INVALID_HEX_SHORT), '');
  });

  it('too long returns empty string', () => {
    assert.equal(refToHex(INVALID_HEX_LONG), '');
  });

  it('non-hex characters returns empty string', () => {
    assert.equal(refToHex(INVALID_HEX_NONHEX), '');
  });

  it('paths (bzz://hex/path) returns empty string', () => {
    assert.equal(refToHex(INVALID_BZZ_PATH), '');
  });

  it('null returns empty string', () => {
    assert.equal(refToHex(null), '');
  });

  it('undefined returns empty string', () => {
    assert.equal(refToHex(undefined), '');
  });

  it('number returns empty string', () => {
    assert.equal(refToHex(42), '');
  });
});

// =============================================
// hexToBzz
// =============================================

describe('hexToBzz', () => {
  it('bare hex returns bzz://<lowercase>', () => {
    assert.equal(hexToBzz(VALID_HEX), `bzz://${VALID_HEX}`);
  });

  it('already prefixed normalizes', () => {
    assert.equal(hexToBzz(VALID_BZZ), VALID_BZZ);
  });

  it('invalid input returns empty string', () => {
    assert.equal(hexToBzz('garbage'), '');
  });
});

// =============================================
// isValidRef
// =============================================

describe('isValidRef', () => {
  it('valid bare hex returns true', () => {
    assert.equal(isValidRef(VALID_HEX), true);
  });

  it('valid bzz:// returns true', () => {
    assert.equal(isValidRef(VALID_BZZ), true);
  });

  it('garbage returns false', () => {
    assert.equal(isValidRef('garbage'), false);
  });
});

// =============================================
// isValidBzzRef
// =============================================

describe('isValidBzzRef', () => {
  it('valid lowercase bzz:// returns true', () => {
    assert.equal(isValidBzzRef(VALID_BZZ), true);
  });

  it('uppercase hex returns false (strict lowercase)', () => {
    assert.equal(isValidBzzRef(INVALID_BZZ_UPPER), false);
  });

  it('bare hex without prefix returns false', () => {
    assert.equal(isValidBzzRef(VALID_HEX), false);
  });

  it('invalid returns false', () => {
    assert.equal(isValidBzzRef('garbage'), false);
  });
});

// =============================================
// hexToBytes32 / bytes32ToHex
// =============================================

describe('hexToBytes32 / bytes32ToHex', () => {
  it('round-trip: hexToBytes32 then bytes32ToHex', () => {
    const b32 = hexToBytes32(VALID_HEX);
    assert.equal(bytes32ToHex(b32), VALID_HEX);
  });

  it('adds 0x prefix', () => {
    const b32 = hexToBytes32(VALID_HEX);
    assert.ok(b32.startsWith('0x'));
  });

  it('strips 0x prefix correctly', () => {
    const hex = bytes32ToHex('0x' + VALID_HEX);
    assert.ok(!hex.startsWith('0x'));
    assert.equal(hex, VALID_HEX);
  });

  it('accepts input with 0x prefix', () => {
    const b32 = hexToBytes32('0x' + VALID_HEX);
    assert.equal(b32, '0x' + VALID_HEX);
  });

  it('rejects invalid input in hexToBytes32', () => {
    assert.throws(() => hexToBytes32('invalid'));
  });

  it('returns empty string for invalid bytes32ToHex', () => {
    assert.equal(bytes32ToHex('invalid'), '');
    assert.equal(bytes32ToHex(null), '');
  });
});

// =============================================
// refToBytes32 / bytes32ToRef
// =============================================

describe('refToBytes32 / bytes32ToRef', () => {
  it('bzz:// ref round-trips through bytes32', () => {
    const b32 = refToBytes32(VALID_BZZ);
    const ref = bytes32ToRef(b32);
    assert.equal(ref, VALID_BZZ);
  });

  it('refToBytes32 produces 0x-prefixed output', () => {
    const b32 = refToBytes32(VALID_BZZ);
    assert.ok(b32.startsWith('0x'));
  });

  it('refToBytes32 rejects invalid ref', () => {
    assert.throws(() => refToBytes32('invalid'));
  });

  it('bytes32ToRef rejects invalid bytes32', () => {
    assert.throws(() => bytes32ToRef('invalid'));
  });
});

// =============================================
// slugToBoardId
// =============================================

describe('slugToBoardId', () => {
  it('known slug produces deterministic keccak256 hash', () => {
    const id1 = slugToBoardId('general');
    const id2 = slugToBoardId('general');
    assert.equal(id1, id2);
  });

  it('returns 0x-prefixed bytes32', () => {
    const id = slugToBoardId('general');
    assert.ok(id.startsWith('0x'));
    assert.equal(id.length, 66); // 0x + 64 hex chars
  });

  it('different slugs produce different hashes', () => {
    const id1 = slugToBoardId('general');
    const id2 = slugToBoardId('tech');
    assert.notEqual(id1, id2);
  });

  it('empty slug throws', () => {
    assert.throws(() => slugToBoardId(''));
  });

  it('null throws', () => {
    assert.throws(() => slugToBoardId(null));
  });
});
