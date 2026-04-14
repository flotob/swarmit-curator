/**
 * Boards repository.
 */

import { getDb } from '../sqlite.js';

function rowToBoard(row) {
  return {
    slug: row.slug,
    boardId: row.board_id,
    boardRef: row.board_ref,
    governance: row.governance_json ? JSON.parse(row.governance_json) : null,
  };
}

export function addBoard(slug, { boardId, boardRef, governance } = {}) {
  if (!boardId) throw new Error('addBoard: boardId is required (bytes32 hex hash)');
  getDb().prepare(`
    INSERT OR REPLACE INTO boards (slug, board_id, board_ref, governance_json)
    VALUES (?, ?, ?, ?)
  `).run(slug, boardId, boardRef || null, governance ? JSON.stringify(governance) : null);
}

export function getBoard(slug) {
  const row = getDb().prepare('SELECT * FROM boards WHERE slug = ?').get(slug);
  return row ? rowToBoard(row) : null;
}

export function getAllBoards() {
  return getDb().prepare('SELECT * FROM boards ORDER BY slug').all().map(rowToBoard);
}

export function hasBoard(slug) {
  const row = getDb().prepare('SELECT 1 FROM boards WHERE slug = ?').get(slug);
  return !!row;
}

export function updateBoardRef(boardId, boardRef) {
  getDb().prepare('UPDATE boards SET board_ref = ? WHERE board_id = ?').run(boardRef, boardId);
}
