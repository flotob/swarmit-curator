/**
 * SQLite connection lifecycle — explicit init/close, no side effects on import.
 */

import Database from 'better-sqlite3';
import { migrate } from './migrate.js';

let db = null;

/**
 * Open a SQLite connection, run migrations, set pragmas.
 * @param {string} path - file path or ':memory:' for tests
 */
export function initDb(path) {
  if (db) throw new Error('DB already initialized — call closeDb() first');

  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  migrate(db);
}

/**
 * Close the connection.
 */
export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Delete all data from every table (for tests).
 */
export function resetDb() {
  if (!db) throw new Error('DB not initialized');
  db.exec(`
    DELETE FROM retry_submissions;
    DELETE FROM republish_boards;
    DELETE FROM published_profile_keys;
    DELETE FROM feeds;
    DELETE FROM vote_events;
    DELETE FROM votes;
    DELETE FROM submissions;
    DELETE FROM boards;
    DELETE FROM meta;
  `);
}

/**
 * Return the active connection. Throws if not initialized.
 * @returns {import('better-sqlite3').Database}
 */
export function getDb() {
  if (!db) throw new Error('DB not initialized — call initDb() first');
  return db;
}

/**
 * Run a function inside a SQLite transaction.
 * All DB writes within `fn` are committed atomically.
 * @param {Function} fn - sync function containing DB writes
 */
export function inTransaction(fn) {
  if (!db) throw new Error('DB not initialized — call initDb() first');
  db.transaction(fn)();
}
