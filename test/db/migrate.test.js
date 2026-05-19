import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';

const LIVENESS_COLUMNS = ['unreachable_strikes', 'stale_since', 'ingested_at'];

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

// The submissions schema as it was before the liveness-pruning columns existed.
const PRE_LIVENESS_SUBMISSIONS = `
  CREATE TABLE submissions (
    submission_ref        TEXT PRIMARY KEY,
    board_slug            TEXT NOT NULL,
    kind                  TEXT NOT NULL,
    content_ref           TEXT NOT NULL,
    parent_submission_ref TEXT,
    root_submission_ref   TEXT,
    author                TEXT NOT NULL,
    block_number          INTEGER NOT NULL,
    log_index             INTEGER NOT NULL,
    announced_at_ms       INTEGER
  );
`;

describe('migrate — liveness columns', () => {
  it('a fresh database has all liveness columns', () => {
    const db = new Database(':memory:');
    migrate(db);
    const cols = columnNames(db, 'submissions');
    for (const col of LIVENESS_COLUMNS) assert.ok(cols.includes(col), `missing ${col}`);
    db.close();
  });

  it('a pre-existing submissions table gets the liveness columns added', () => {
    const db = new Database(':memory:');
    db.exec(PRE_LIVENESS_SUBMISSIONS);
    db.exec(`
      INSERT INTO submissions
        (submission_ref, board_slug, kind, content_ref, author, block_number, log_index)
      VALUES ('bzz://old', 'general', 'post', 'bzz://c', '0xabc', 100, 0);
    `);

    migrate(db);

    const cols = columnNames(db, 'submissions');
    for (const col of LIVENESS_COLUMNS) assert.ok(cols.includes(col), `missing ${col}`);

    // The pre-existing row takes the column defaults.
    const row = db.prepare('SELECT * FROM submissions WHERE submission_ref = ?').get('bzz://old');
    assert.equal(row.unreachable_strikes, 0);
    assert.equal(row.stale_since, null);
    assert.equal(row.ingested_at, 0);
    db.close();
  });

  it('is idempotent — running migrate twice does not error', () => {
    const db = new Database(':memory:');
    migrate(db);
    assert.doesNotThrow(() => migrate(db));
    db.close();
  });
});
