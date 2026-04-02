# Ranked Views Implementation Plan

Add `hot`, `rising`, and `controversial` views to the reference curator.

## Scope

- Board/global post feeds only. No thread comment ranking this pass.
- No protocol or contract changes.
- Multi-view feed infrastructure already exists (`best` proves the pattern).
- All formulas are simple, explainable, and tunable later.
- `hot` becomes the default feed (the one served by `globalIndexFeed` / `boardFeeds[slug]`).

## Default Feed: `hot`

The reference curator's default feed changes from chronological (`new`) to `hot`.

**Why**: `hot` surfaces quality content that's recently relevant — what most users want on landing. With zero votes, the formula degrades to newest-first (tie-break), so a new board with no activity shows the same results as `new`.

**How it works in the SPA**: The SPA loads the default feed from `curatorProfile.globalIndexFeed` and `curatorProfile.boardFeeds[slug]`, NOT from named views. So the curator must point these default fields at the `hot` feed:
- `globalIndexFeed` → `hot-global` feed manifest
- `boardFeeds[slug]` → `hot-board-{slug}` feed manifest

Named views then expose all 5 views, with `new` pointing to the chronological feed that was previously the default.

**Safety**: `hot` includes all posts (never omits), so thread discovery via the default board feed (used by `useThread.js` to find root posts) continues to work.

**SPA dependency**: The SPA header currently highlights the first view in its hardcoded order when no preference is stored, which may not match the actual default feed. A small SPA fix is needed so the header reflects the effective default view. This is tracked separately — it does not block the curator work.

## Current State

What we have:
- `new` (chronological) and `best` (score-sorted) views for board + global feeds
- Aggregate vote totals in `votes` table (upvotes, downvotes, score)
- Submission ordering by `block_number` / `log_index`
- Two-phase processEvents with transactional DB writes
- `published_profile_keys` with structured naming (`board:*`, `view:best:*`)

What we're missing:
- Block timestamps for submissions and votes (needed for time-decay in hot/rising)
- Individual vote event history (needed for recent-delta in rising)
- Ranking formulas and preloading logic
- Scheduled ranked refresh (hot/rising change with time, not just new events)

## Ranking Formulas

### `best` (already implemented)

- `score = upvotes - downvotes`, descending
- Tie-break: newer announcement first

### `hot`

Purpose: currently active/popular content.

```
score = upvotes - downvotes
ageHours = (nowMs - announcedAtMs) / 3600000
hotScore = score / pow(ageHours + 2, 1.5)
```

Include all posts. Tie-break: newer announcement first.

### `rising`

Purpose: gaining traction recently.

```
recentDelta24h = sum(direction - previousDirection) over vote events in last 24h
risingScore = recentDelta24h / pow(ageHours + 2, 1.8)
```

Filter: only posts where `recentDelta24h > 0` AND `age <= 7 days`. Omit the rest.
Tie-break: total score descending, then newer announcement first.

### `controversial`

Purpose: strong disagreement.

```
if upvotes === 0 || downvotes === 0: omit
balance = min(upvotes, downvotes) / max(upvotes, downvotes)
controversyScore = (upvotes + downvotes) * balance
```

Omit posts with one-sided voting. Tie-break: newer announcement first.

## Implementation Phases

### Phase 1: Block Timestamps + Schema Extension

**`src/chain/reader.js`**:
- After fetching events, collect unique block numbers from submissions and votes.
- Batch-fetch timestamps: `provider.getBlock(blockNumber)` for each unique block.
- Attach `blockTimestamp` (epoch ms) to each submission and vote event in the returned data.
- Cache timestamps in a local Map during the fetch (blocks are immutable, timestamps never change).

**`src/db/migrate.js`** — add:

```sql
ALTER TABLE submissions ADD COLUMN announced_at_ms INTEGER;

CREATE TABLE IF NOT EXISTS vote_events (
  submission_ref TEXT NOT NULL,
  voter          TEXT NOT NULL,
  direction      INTEGER NOT NULL,
  previous_direction INTEGER NOT NULL,
  delta          INTEGER NOT NULL,
  block_number   INTEGER NOT NULL,
  log_index      INTEGER NOT NULL,
  block_timestamp_ms INTEGER NOT NULL,
  UNIQUE(submission_ref, voter, block_number, log_index)
);

CREATE INDEX IF NOT EXISTS idx_vote_events_submission_time
  ON vote_events (submission_ref, block_timestamp_ms DESC);
```

Since the DB is a rebuildable cache, we handle migration by:
1. Try `ALTER TABLE` — if it fails (column already exists), ignore.
2. `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` for new tables.
3. If migration gets messy, rebuild from `CONTRACT_DEPLOY_BLOCK` (documented as acceptable).

**`src/config.js`** — add:

```
RANKED_REFRESH_INTERVAL=15     # minutes, default 15
```

### Phase 2: Vote Events Repo + Submission Timestamp

**New `src/db/repos/vote-events.js`**:

```js
insertVoteEvent({ submissionRef, voter, direction, previousDirection, blockNumber, logIndex, blockTimestampMs })
// INSERT OR IGNORE — idempotent, keyed on (submission_ref, voter, block_number, log_index)
// delta = direction - previousDirection (computed on insert)

getRecentDelta(submissionRef, sinceMs)
// SELECT SUM(delta) FROM vote_events
// WHERE submission_ref = ? AND block_timestamp_ms >= ?
// Returns a number (0 if no events)

getRecentDeltasBatch(submissionRefs, sinceMs)
// Same query but for a batch of refs — returns Map<ref, delta>
// Avoids N+1 when preloading for ranking
```

**Update `src/db/repos/submissions.js`**:

- `addSubmission` gains optional `announcedAtMs` parameter.
- `getRootSubmissions` and `getSubmissionsForBoard` return `announcedAtMs` in the result objects.
- `rowToEntry` maps the new column.

**Update `src/indexer/state.js`** — re-export new functions:

```js
export { insertVoteEvent, getRecentDeltasBatch } from '../db/repos/vote-events.js';
```

### Phase 3: Ranking Module

**New `src/indexer/ranking.js`**:

Centralizes all ranking formulas and batch-preloads data from SQLite so indexers don't query per-comparison.

```js
export function rankByBest(posts)
// Preloads scores into Map, sorts by score desc then newest

export function rankByHot(posts, nowMs)
// Preloads scores + announcedAtMs, computes hotScore, sorts desc

export function rankByRising(posts, nowMs)
// Preloads recentDelta24h (batch query) + announcedAtMs + scores
// Filters: recentDelta24h > 0, age <= 7 days
// Computes risingScore, sorts desc

export function rankByControversial(posts)
// Preloads vote totals
// Filters: upvotes > 0 AND downvotes > 0
// Computes controversyScore, sorts desc
```

Each function:
1. Batch-fetches all needed data (scores, timestamps, deltas) into Maps.
2. Optionally filters posts that don't qualify.
3. Sorts using the preloaded data (no per-comparison DB queries).
4. Returns a sorted array.

The existing `byBest` + score preloading logic in `board-indexer.js` and `global-indexer.js` moves here.

### Phase 4: Board/Global Index Builders

**`src/indexer/board-indexer.js`** — add:

```js
export function buildHotBoardIndex(boardSlug)
export function buildRisingBoardIndex(boardSlug)
export function buildControversialBoardIndex(boardSlug)
```

Each follows the same pattern as existing `buildBestBoardIndex`:
1. `getRootSubmissions(boardSlug)`
2. Call the ranking function from `ranking.js`
3. `buildEntry` per post (with threadIndexFeed lookup)
4. `buildBoardIndex({ boardId, curator, entries })`

The existing `buildBestBoardIndex` is refactored to use `rankByBest` from `ranking.js`.

**`src/indexer/global-indexer.js`** — same pattern:

```js
export function buildHotGlobalIndex()
export function buildRisingGlobalIndex()
export function buildControversialGlobalIndex()
```

The existing `buildBestGlobalIndex` is refactored to use `rankByBest` from `ranking.js`.

### Phase 5: Orchestrator — Publish + Scheduled Refresh

**New feed names** published in `publishIndexes`:

```
hot-board-{slug}           hot-global
rising-board-{slug}        rising-global
controversial-board-{slug} controversial-global
```

Existing feeds stay unchanged:
```
board-{slug}               global
best-board-{slug}          best-global
thread-{submissionRef}
```

**Scheduled ranked refresh**:

Hot and rising change with time even without new Swarmit events. On a live chain, new blocks arrive constantly (~5s on Gnosis), so "no new blocks" almost never happens. The refresh trigger must be time-based, not chain-idleness-based.

At the end of every `pollOnce`, after processing and publishing any event-driven changes:

```
check if RANKED_REFRESH_INTERVAL has elapsed since last_ranked_refresh_at
if yes AND no ranked-relevant Swarmit work happened this poll:
  republish only ranked feeds (best/hot/rising/controversial) for all boards + global
  update last_ranked_refresh_at
```

"Ranked-relevant work" means: changedBoards was non-empty (submissions or votes arrived). If ranked work already happened this poll, the ranked feeds were already rebuilt — no need to refresh again.

**Important: timed refresh publishes ranked feeds only, not `new`/thread feeds.** The current `publishIndexes` couples default and ranked variants together. For the timed refresh path, we split this:

- `publishIndexes` (existing) — publishes everything for changed boards: thread feeds, default `new` board index, and all ranked board indexes. Triggered by new submissions/votes.
- `publishRankedRefresh` (new) — publishes only ranked board indexes (best/hot/rising/controversial) and ranked global indexes. Triggered by time interval. Does NOT republish `new`, thread feeds, or advance any cursor.

This avoids needlessly republishing unchanged `new` feeds on every 15-minute refresh cycle.

The meta key `last_ranked_refresh_at` (epoch ms) tracks the last timed refresh.

**Update `processEvents`**: In the Phase 2 transaction, also call `insertVoteEvent` for each vote event alongside `applyVoteEvent`.

### Phase 6: Profile Manager

**`src/publisher/profile-manager.js`** — expand `globalViewFeeds` and `boardViewFeeds`:

The default feed fields now point to `hot`:

```js
// Default feed = hot (what the SPA loads when no view preference is stored)
globalIndexFeed = hotGlobalFeedUrl;
boardFeeds[slug] = hotBoardFeedUrl;
```

Named views expose all 5 views:

```js
globalViewFeeds.hot = hotGlobalFeedUrl;
globalViewFeeds.new = chronologicalGlobalFeedUrl;
globalViewFeeds.best = bestGlobalUrl;
globalViewFeeds.rising = risingGlobalUrl;
globalViewFeeds.controversial = controversialGlobalUrl;
```

Same for each board in `boardViewFeeds[slug]`. All views are included when their feed exists. `hot` and `new` are always present.

**Update `needsProfileUpdate`**: Check for new view feed keys:
- `view:hot:global`, `view:rising:global`, `view:controversial:global`
- `view:hot:board:{slug}`, `view:rising:board:{slug}`, `view:controversial:board:{slug}`

**Update `publishAndDeclare`**: Push the new keys to `setPublishedKeys`.

### Phase 7: Tests

| Area | Tests |
|------|-------|
| **Chain reader** | Block timestamp attachment for submission/vote events |
| **vote-events repo** | Insert idempotency, recent delta query, batch delta query |
| **ranking.js** | Fixed timestamps + fixed vote data for each formula: hot, rising, controversial. Verify filtering (rising omits non-qualifying, controversial omits one-sided). Verify tie-breaking. |
| **Board/global indexers** | `buildHot*`, `buildRising*`, `buildControversial*` produce valid protocol objects with correct ordering |
| **Orchestrator** | New feed names published. Ranked scheduled refresh fires even with no new chain events. |
| **Profile manager** | Profile contains all 5 named views. Published keys use structured naming for all views. |

Ranking tests should use fixed `nowMs` parameters so results are deterministic.

## Implementation Order

```
Phase 1   Reader timestamps + schema extension
 ↓
Phase 2   Vote-events repo + submission announcedAtMs
 ↓
Phase 3   Ranking module (ranking.js)
 ↓
Phase 4   Board/global index builders
 ↓
Phase 5   Orchestrator publishing + scheduled refresh
 ↓
Phase 6   Profile manager
 ↓
Phase 7   Tests (alongside each phase)
```

Phases 1-2 are data-model groundwork. Phase 3 is the core ranking logic. Phases 4-6 are wiring. Tests run alongside each phase.

## SPA Dependency

The SPA needs a small fix so the header highlights the effective default view (`hot`) when no user preference is stored. This is tracked separately in the swarmit repo and does not block the curator work.

## Non-Goals

- Thread comment ranking
- Pagination
- Contract or protocol changes
- Per-user vote analytics
- Configurable formula parameters (hardcode for now, tune later)
- SPA changes (handled separately)
