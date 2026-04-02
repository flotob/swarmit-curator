# SQLite Migration Plan

Replace `state.json` with SQLite before adding `hot` / `rising` / `controversial` views.

## Decision

- Replace `state.json` with SQLite via `better-sqlite3`.
- Do NOT move to Postgres. This is a single-process local curator.
- Chain + Swarm remain the source of truth. SQLite is a rebuildable local cache.
- Do NOT migrate old `state.json`. Start fresh from `CONTRACT_DEPLOY_BLOCK`.

## Why Now

The current `state.js` holds everything in Maps/Sets and serializes to JSON on every poll iteration. That was fine for MVP, but ranked views now want queryable state — submissions by board sorted by score, vote aggregates, feed manifests per view — and `hot` / `rising` / `controversial` will make it worse. Moving to SQLite gives us indexed queries, atomic writes, and a foundation for more complex sorting without growing in-memory data structures.

## Driver

`better-sqlite3` — synchronous API, battle-tested, fits the single-threaded architecture. The current state.js is already effectively sync (only `loadState`/`saveState` do async file I/O). Node 22's `node:sqlite` is still experimental and its API is unstable.

## Schema

### 1. `meta`

Key-value store for scalar state.

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Keys: `last_processed_block`, `republish_global`, `republish_profile`.

### 2. `boards`

```sql
CREATE TABLE boards (
  slug            TEXT PRIMARY KEY,
  board_id        TEXT NOT NULL,
  board_ref       TEXT,
  governance_json TEXT
);
```

Replaces the in-memory `boards` Map.

### 3. `submissions`

```sql
CREATE TABLE submissions (
  submission_ref      TEXT PRIMARY KEY,
  board_slug          TEXT NOT NULL,
  kind                TEXT NOT NULL,  -- 'post' or 'reply'
  content_ref         TEXT NOT NULL,
  parent_submission_ref TEXT,
  root_submission_ref TEXT,
  author              TEXT NOT NULL,
  block_number        INTEGER NOT NULL,
  log_index           INTEGER NOT NULL
);

CREATE INDEX idx_submissions_board ON submissions (
  board_slug, kind, block_number DESC, log_index DESC
);

CREATE INDEX idx_submissions_root ON submissions (
  root_submission_ref, block_number ASC, log_index ASC
);
```

The first index powers `getRootSubmissions` and board indexer queries (chronological newest-first). The second powers `getRepliesForRoot` and thread indexer queries (oldest-first within thread).

### 4. `votes`

```sql
CREATE TABLE votes (
  submission_ref       TEXT PRIMARY KEY,
  upvotes              INTEGER NOT NULL,
  downvotes            INTEGER NOT NULL,
  score                INTEGER NOT NULL,
  updated_at_block     INTEGER NOT NULL,
  updated_at_log_index INTEGER NOT NULL
);
```

The stale-event guard is implemented in SQL (see [Vote upsert](#vote-upsert) below).

### 5. `feeds`

```sql
CREATE TABLE feeds (
  feed_name    TEXT PRIMARY KEY,
  manifest_ref TEXT NOT NULL
);
```

Replaces the `feeds` Map. Examples: `global`, `best-global`, `board-tech`, `best-board-tech`, `thread-bzz://...`.

### 6. `published_profile_keys`

```sql
CREATE TABLE published_profile_keys (
  key TEXT PRIMARY KEY
);
```

Replaces `publishedBoardSlugs`. Tracks what's in the current published curator profile with structured keys using a consistent `type:scope` naming scheme. Examples: `board:tech`, `view:best:global`, `view:best:board:tech`.

### 7. `republish_boards`

```sql
CREATE TABLE republish_boards (
  slug TEXT PRIMARY KEY
);
```

Replaces the `republishBoards` Set. Board slugs needing feed republish.

### 8. `retry_submissions`

```sql
CREATE TABLE retry_submissions (
  submission_ref TEXT PRIMARY KEY,
  author         TEXT NOT NULL,
  block_number   INTEGER NOT NULL,
  log_index      INTEGER NOT NULL
);
```

Replaces the `retrySubmissions` array.

## SQLite Settings

```js
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
```

## Transaction Boundaries

Do NOT wrap an entire `pollOnce()` in one transaction. The poll iteration is async and includes network I/O (chain reads, Swarm fetches, Swarm publishes, on-chain tx). `better-sqlite3` transactions are synchronous and must not span awaits.

Instead, use **small local transactions** around each state-application phase:

| Phase | What happens | Transaction scope |
|-------|-------------|-------------------|
| Chain fetch | `fetchEvents(from, to)` | No transaction (network I/O) |
| Swarm fetch + validate | `fetchObject(ref)`, validate, collect results | No transaction (network I/O) |
| Ingestion apply | `addBoard`, `addSubmission`, `applyVoteEvent`, `setRetrySubmissions`, `setLastProcessedBlock` | **Transaction**: batch all state writes from one processEvents call |
| Publish | `publishAndUpdateFeed` per board/thread/global | No transaction (network I/O) |
| Post-publish update | `setFeed` (per published feed), `setRepublishBoards`, `setRepublishGlobal` | **Transaction**: batch post-publish state updates |
| Profile publish | `publishAndDeclare` | No transaction (network I/O + on-chain tx) |
| Post-profile update | `setPublishedProfileKeys`, `setRepublishProfile` | **Transaction**: batch post-profile state updates |

This gives atomicity where it matters (state application) without holding a DB lock across network calls.

### processEvents must become two-phase

The current `processEvents` in `orchestrator.js` interleaves async network calls (`await fetchObject(...)`) with state writes (`addSubmission(...)`). With SQLite, this must be split into two distinct phases:

**Phase 1 — Fetch and validate (async, no DB writes):**
Loop over submissions, call `fetchObject` for each, run all three validators, collect the validated results into a plain array. Failed validations are dropped; transient errors and orphaned replies go into a pending array. No state mutation happens during this phase.

**Phase 2 — Apply to DB (sync transaction):**
Open a `better-sqlite3` transaction, write all validated submissions, boards, metadata updates, vote events, the retry queue, and the block cursor in one atomic batch. Close the transaction.

This separation ensures no `await` occurs inside a sync SQLite transaction.

### feed-manager needs a small refactor

Today `feed-manager.js` calls `setFeed()` inside `ensureFeed()`, which runs mid-publish (between `publishJSON` and `updateSwarmFeed`). With the transaction model above, `setFeed` is a DB write that should happen in the post-publish transaction, not during async I/O.

The fix: `ensureFeed` / `publishAndUpdateFeed` should return the new feed manifest reference (if created) as part of its result, and the orchestrator collects those and writes them in the post-publish transaction alongside `setRepublishBoards` and `setRepublishGlobal`. Alternatively, `feed-manager` can accept a write-batch callback. Either way, `setFeed()` must not be called inside async publish flow.

## Vote Upsert

The stale-event guard moves from JS into SQL. The repo layer owns freshness semantics:

```sql
INSERT INTO votes (submission_ref, upvotes, downvotes, score, updated_at_block, updated_at_log_index)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (submission_ref) DO UPDATE SET
  upvotes              = excluded.upvotes,
  downvotes            = excluded.downvotes,
  score                = excluded.score,
  updated_at_block     = excluded.updated_at_block,
  updated_at_log_index = excluded.updated_at_log_index
WHERE
  excluded.updated_at_block > votes.updated_at_block
  OR (excluded.updated_at_block = votes.updated_at_block
      AND excluded.updated_at_log_index > votes.updated_at_log_index);
```

Returns `changes > 0` to indicate whether state actually changed (used by orchestrator to mark boards dirty).

## Target Structure

```
src/db/
  sqlite.js              — initDb(path), closeDb(), resetDb(), getDb()
  migrate.js             — schema creation (all 8 tables + indexes)
  repos/
    meta.js              — getLastProcessedBlock, setLastProcessedBlock,
                           getRepublishGlobal, setRepublishGlobal, ...
    boards.js            — addBoard, getAllBoards, getKnownBoardSlugs, hasBoard
    submissions.js       — addSubmission, hasSubmission, getSubmissionsForBoard,
                           getRootSubmissions, getRepliesForRoot
    votes.js             — applyVoteEvent (SQL upsert), getVotesForSubmission
    feeds.js             — getFeed, setFeed
    published.js         — getPublishedKeys, setPublishedKeys, hasPublishedKey
    retries.js           — getRetrySubmissions, setRetrySubmissions, addRetry, clearRetries
    republish-boards.js  — getRepublishBoards, setRepublishBoards, addRepublishBoard
```

## DB Lifecycle

Do not hide a singleton connection in module-import side effects. Tests need explicit control:

```js
// src/db/sqlite.js
export function initDb(path)   // open connection, run migrations, set pragmas
export function closeDb()      // close connection
export function resetDb()      // drop all data (for tests)
export function getDb()        // return the active connection
```

- Production: `initDb(config.stateDb)` at startup in `index.js`, before `pollOnce` loop.
- Tests: `initDb(':memory:')` in setup, `resetDb()` in `beforeEach`, `closeDb()` in teardown.

## Facade API Changes

Rewrite `src/indexer/state.js` to delegate to repos. Keep the same exported function names where possible. Key changes:

| Current | After | Reason |
|---------|-------|--------|
| `getBoards()` → `Map` | `getAllBoards()` → `[{slug, boardId, boardRef, governance}]` | Stop returning mutable Map |
| `getSubmissions()` → `Map` | `hasSubmission(ref)` → `boolean` | Only use in production is `.has()` |
| `getVotes()` → `Map` | Remove (only used in tests for `.clear()`) | Tests use `resetDb()` instead |
| `getKnownBoardSlugs()` → `Set` | `getKnownBoardSlugs()` → `Set` | Same API, backed by SQL |
| `getRetrySubmissions()` → `Array` | `getRetrySubmissions()` → `Array` | Same API, backed by SQL |
| `getRepublishBoards()` → `Set` | `getRepublishBoards()` → `Set` | Same API, backed by SQL |
| `loadState()` / `saveState()` | `initDb()` / removed | Writes are immediate; no explicit save |
| `getPublishedBoardSlugs()` | `getPublishedProfileKeys()` / `hasPublishedKey()` | Expanded tracking |

Callers that iterate `getBoards()` with `for (const [slug] of getBoards())` change to `for (const {slug} of getAllBoards())` or similar.

## Config Changes

```
STATE_DB=./state.db     # new, default
STATE_FILE=./state.json # deprecated, ignored
```

## Work Packages

### WP1: SQLite Infrastructure

- Add `better-sqlite3` dependency.
- Create `src/db/sqlite.js` — `initDb`, `closeDb`, `resetDb`, `getDb`.
- Create `src/db/migrate.js` — create all 8 tables and indexes.
- Add `STATE_DB` to config.

### WP2: Repository Modules

- Implement 8 repo files under `src/db/repos/`.
- Each repo exports typed query functions.
- Vote repo includes the SQL upsert with stale-event guard.
- Write unit tests for each repo against `:memory:` SQLite.

### WP3: State Facade Rewrite

- Replace `state.js` internals with repo calls.
- Match existing export names where possible.
- Stop returning mutable Maps/Sets.
- Remove `loadState()` / `saveState()`.
- Add `initDb()` call to startup path.

### WP4: Caller Updates

- `orchestrator.js` — refactor `processEvents` into two-phase (async fetch/validate, then sync DB transaction). Replace `getSubmissions().has()` with `hasSubmission()`, replace `getBoards()` iteration, remove `saveState()` call, add transaction wrappers around ingestion and post-publish phases. Collect feed manifest refs from publish phase and write them in the post-publish transaction.
- `board-indexer.js` / `global-indexer.js` — adapt to new query return shapes.
- `profile-manager.js` — switch from `publishedBoardSlugs` to `publishedProfileKeys` (using `view:best:` prefix scheme).
- `feed-manager.js` — refactor so `setFeed()` is not called inside async publish flow. `ensureFeed` / `publishAndUpdateFeed` should return new manifest refs for the caller to batch-write in a post-publish transaction. `getFeed` (read-only) is unchanged.
- `index.js` — replace `loadState()` with `initDb()`, remove `saveState()` on shutdown.

### WP5: Test Migration

- All test files: replace `getBoards().clear()` / `getSubmissions().clear()` / `getVotes().clear()` with `resetDb()`.
- Use `initDb(':memory:')` in test setup — fast, isolated, no temp files.
- Keep all existing test cases and assertions.
- Add new tests: DB bootstrap/migration, repo-level round-trips, vote upsert guard in SQL, `pollOnce` resume from DB cursor.

### WP6: Cleanup

- Remove JSON serialization code from `state.js`.
- Remove `STATE_FILE` from config.
- Update README.

## Implementation Order

```
WP1  SQLite infra + schema
 ↓
WP2  Repo modules + repo tests
 ↓
WP3  State facade rewrite
 ↓
WP4  Caller updates
WP5  Test migration     (parallel with WP4)
 ↓
WP6  Cleanup
```

WP1–WP3 are the core. WP4–WP5 follow directly. WP6 is polish.

## Non-Goals

- Postgres or any external database.
- Multi-process locking or distributed orchestration.
- Automatic migration from `state.json` to SQLite.
- Protocol changes.
- Analytics or dashboards.

## Behavioral Goal

After migration, the curator behaves exactly the same for board ingestion, submission ingestion, vote ingestion, feed publishing, and profile publishing. The only change is the storage backend. All existing tests should pass with the same assertions against DB-backed state.
