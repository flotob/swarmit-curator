/**
 * Reference normalization and encoding utilities.
 * Single source of truth for bzz:// handling, hex↔bytes32, and slugToBoardId.
 * Pure logic, no I/O.
 */

import { keccak256, toUtf8Bytes } from 'ethers';

const HEX_64_RE = /^[0-9a-f]{64}$/i;

/**
 * Extract and validate a 64-char hex reference from a bzz:// URL or bare hex string.
 * Rejects non-canonical inputs (paths, query strings, short hashes).
 * @param {string} ref - 'bzz://abc123...' or 'abc123...'
 * @returns {string} 64-char lowercase hex, or '' if invalid
 */
export function refToHex(ref) {
  if (!ref || typeof ref !== 'string') return '';
  const hex = ref.replace(/^bzz:\/\//, '').trim();
  if (!HEX_64_RE.test(hex)) return '';
  return hex.toLowerCase();
}

/**
 * Normalize a reference to canonical bzz://<hex> form.
 * @param {string} ref - bare hex or bzz:// URL
 * @returns {string} 'bzz://<64hex>' or '' if invalid
 */
export function hexToBzz(ref) {
  const hex = refToHex(ref);
  if (!hex) return '';
  return `bzz://${hex}`;
}

/**
 * Check if a string is a valid Swarm reference (bare hex or bzz://).
 * Use isValidBzzRef() for protocol-object validation where normalized form is required.
 * @param {string} ref
 * @returns {boolean}
 */
export function isValidRef(ref) {
  return refToHex(ref) !== '';
}

/**
 * Check if a string is a valid normalized bzz://<hex> reference.
 * Requires the bzz:// prefix — bare hex is rejected.
 * Use this for protocol-object validation.
 * @param {string} ref
 * @returns {boolean}
 */
const HEX_64_LOWER_RE = /^[0-9a-f]{64}$/;

export function isValidBzzRef(ref) {
  if (!ref || typeof ref !== 'string' || !ref.startsWith('bzz://')) return false;
  return HEX_64_LOWER_RE.test(ref.slice(6));
}

/**
 * Convert a 64-char hex string to bytes32 for on-chain encoding.
 * @param {string} hex - 64-char hex (no 0x prefix)
 * @returns {string} 0x-prefixed bytes32
 */
export function hexToBytes32(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!HEX_64_RE.test(clean)) throw new Error(`Invalid hex for bytes32: ${hex}`);
  return '0x' + clean.toLowerCase();
}

/**
 * Convert a bytes32 (0x-prefixed) back to bare 64-char hex.
 * @param {string} b32 - 0x-prefixed bytes32
 * @returns {string} 64-char lowercase hex
 */
export function bytes32ToHex(b32) {
  if (!b32 || typeof b32 !== 'string') return '';
  const hex = b32.startsWith('0x') ? b32.slice(2) : b32;
  if (!HEX_64_RE.test(hex)) return '';
  return hex.toLowerCase();
}

/**
 * Convert a bzz:// reference to on-chain bytes32 submissionId.
 * Strips bzz:// prefix, hex-decodes the remaining 64 hex chars.
 * @param {string} ref - 'bzz://<64hex>' or bare hex
 * @returns {string} 0x-prefixed bytes32
 */
export function refToBytes32(ref) {
  const hex = refToHex(ref);
  if (!hex) throw new Error(`Invalid reference for bytes32 encoding: ${ref}`);
  return '0x' + hex; // hex is already validated lowercase 64-char
}

/**
 * Convert an on-chain bytes32 to canonical bzz:// reference.
 * @param {string} b32 - 0x-prefixed bytes32
 * @returns {string} 'bzz://<64hex>'
 */
export function bytes32ToRef(b32) {
  const hex = bytes32ToHex(b32);
  if (!hex) throw new Error(`Invalid bytes32 for reference: ${b32}`);
  return `bzz://${hex}`;
}

/**
 * Derive on-chain boardId from a human-readable slug.
 * boardId = keccak256(bytes(slug))
 * @param {string} slug
 * @returns {string} 0x-prefixed bytes32
 */
export function slugToBoardId(slug) {
  if (!slug || typeof slug !== 'string') throw new Error('Board slug is required');
  return keccak256(toUtf8Bytes(slug));
}
