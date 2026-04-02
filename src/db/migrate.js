/**
 * Schema creation — all 8 tables + indexes.
 * Idempotent: uses IF NOT EXISTS throughout.
 */

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS boards (
    slug            TEXT PRIMARY KEY,
    board_id        TEXT NOT NULL,
    board_ref       TEXT,
    governance_json TEXT
  );

  CREATE TABLE IF NOT EXISTS submissions (
    submission_ref        TEXT PRIMARY KEY,
    board_slug            TEXT NOT NULL,
    kind                  TEXT NOT NULL,
    content_ref           TEXT NOT NULL,
    parent_submission_ref TEXT,
    root_submission_ref   TEXT,
    author                TEXT NOT NULL,
    block_number          INTEGER NOT NULL,
    log_index             INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_submissions_board ON submissions (
    board_slug, kind, block_number DESC, log_index DESC
  );

  CREATE INDEX IF NOT EXISTS idx_submissions_root ON submissions (
    root_submission_ref, block_number ASC, log_index ASC
  );

  CREATE TABLE IF NOT EXISTS votes (
    submission_ref       TEXT PRIMARY KEY,
    upvotes              INTEGER NOT NULL,
    downvotes            INTEGER NOT NULL,
    score                INTEGER NOT NULL,
    updated_at_block     INTEGER NOT NULL,
    updated_at_log_index INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS feeds (
    feed_name    TEXT PRIMARY KEY,
    manifest_ref TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS published_profile_keys (
    key TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS republish_boards (
    slug TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS retry_submissions (
    submission_ref TEXT PRIMARY KEY,
    author         TEXT NOT NULL,
    block_number   INTEGER NOT NULL,
    log_index      INTEGER NOT NULL
  );
`;

/**
 * Run schema creation on the given database.
 * @param {import('better-sqlite3').Database} db
 */
export function migrate(db) {
  db.exec(SCHEMA);
}
