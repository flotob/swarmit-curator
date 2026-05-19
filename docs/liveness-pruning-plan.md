# Content Liveness Pruning — Implementation Plan

Make the curator periodically re-check that the content it has indexed is still
retrievable from Swarm, and exclude unretrievable ("stale") posts from the feeds
it publishes — so the curator never advertises dead content.

> Status: **draft / planning**. This document is a living roadmap; sections
> marked _(open)_ are still under discussion.

## Background

### The incident

In May 2026 two independent postage batches expired at roughly the same time:

1. **The curator's own postage batch** (`af52a381…`, depth 20, originally bought
   on a DigitalOcean droplet). When it ran out of funds it was removed from the
   network. Every curator upload then failed with `404`, so no feeds could be
   published. Fixed by buying a fresh batch (`391243ec…`, depth 17, ~180-day TTL)
   and updating `POSTAGE_BATCH_ID` — see `swarmit-coolify/README.md`.

2. **The postage batches backing user-posted content.** Most Swarmit content is
   uploaded by end users from their own browser node (Freedom Browser's built-in
   light node), stamped with *their* postage batch. Those batches also expired.
   The submission and content objects they stamped are now garbage-collected and
   unretrievable.

Issue (1) is resolved. This document addresses the curator's response to (2).

### The symptom

After the curator was brought back online, the SPA's front page still renders
post cards correctly — title, link, etc. — but **clicking into a comment thread
fails** with e.g.:

```
Feed resolution failed: 404 for d4a4e9daa20739d3d80908fa24aa4f5ddcd44966d714361a8ac50d0fd1922054
```

### Why the front page renders but threads 404

The curator's index entries carry **no content metadata** — no title, no body.
`buildEntry` (`src/indexer/board-indexer.js`) emits only:

```js
{ submissionId, submissionRef, threadIndexFeed }
```

The SPA therefore fetches each post's submission + content object from Swarm
*itself* to render a card. The reason the front page still looks fine is **client
cache**: the viewer's browser cached those content objects during earlier visits
when their stamps were alive. Comment threads the viewer never opened are a cold
cache miss → a real network fetch → `404`, because the chunks are gone.

A fresh visitor with a cold cache would see the front-page cards fail to load
too. The asymmetry is purely a caching artifact.

### Two distinct failure modes

| Mode | What expired | Recoverable by curator? |
|------|--------------|--------------------------|
| 1. Curator-published feed/index objects (`boardIndex`, `threadIndex`, feed manifests) | The curator's own postage batch | Yes — already fixed; re-published under the new batch |
| 2. User-posted submission/content objects | Each poster's own postage batch | **No** — the curator never kept a copy of the bytes |

This plan does **not** attempt to recover Mode-2 content. It makes the curator
*honest*: stop listing posts whose content is unretrievable.

## Investigation findings

Two questions were asked of the current implementation:

### Q1 — Does the curator check availability on initial inclusion? **Yes.**

`processEvents()` (`src/indexer/orchestrator.js`) fetches **both** Swarm objects
before a post is indexed:

- `fetchObject(submissionRef)` → `validateIngestedSubmission`
- `fetchObject(submission.contentRef)` → `validateIngestedContent`

Any fetch failure is caught and the submission is pushed to the
`retry_submissions` queue — it is **not** indexed. A post enters the DB only once
both its submission and content objects are retrievable and schema-valid.

(The content fetch exists for *schema validation* — `validatePost` /
`validateReply` — not for metadata extraction. The curator never stores a title.)

### Q2 — Does the curator re-check already-included posts? **No.**

Once `addSubmission()` runs, the ref is permanently "known"
(`hasSubmission(ref) || batchKnownRefs.has(ref)` in `processEvents`) and is
skipped on every subsequent poll. The index builders — `board-indexer.js`,
`thread-indexer.js`, `global-indexer.js` — read **only** SQLite; they perform
zero Swarm reads and zero liveness checks. There is no TTL, eviction, or
re-validation path. `retry_submissions` tracks only posts that *never made it
in*; nothing tracks posts *falling out*.

**Consequence:** a post whose content stamp expires remains in every feed
forever, pointing at a dead reference.

### The curator keeps no copy of content

The SQLite schema (`src/db/migrate.js`) stores only **references and chain
metadata** — `submission_ref`, `content_ref`, `kind`, `board_slug`, `author`,
`block_number`, `log_index`, `announced_at_ms`, plus vote tallies. No content
bytes, no body, no title. Content is fetched transiently for validation and the
bytes are discarded.

Therefore the curator **cannot restore** Mode-2 content. Liveness pruning can
only *exclude* dead posts so feeds stay truthful.

## Scope

### In scope

- A periodic background **death sweep** that re-checks the retrievability of
  every live indexed submission (posts and replies) and prunes dead ones.
- An optional, separately-paced **resurrection sweep** that re-checks already-
  pruned content in case it comes back online.
- Per-submission liveness state persisted in SQLite.
- Exclusion of "stale" submissions from all published feeds (board, global,
  ranked, thread).
- A terminal **abandoned** state — content that has been dead long enough is
  declared permanently gone and no longer checked.
- Republish of affected feeds when liveness state changes.
- Configuration knobs and a kill switch.

### Out of scope

- **Re-hosting content.** The curator's job is indexing, not hosting. Making the
  curator cache and re-stamp content bytes (the "option B" discussed during
  planning) is explicitly rejected. Content durability will be solved elsewhere,
  outside the curator. _(open: cross-reference the durability design doc once it
  exists.)_
- Protocol or smart-contract changes. None required for this plan. (A protocol-
  level idea — recording the backing postage batch ID at submission time so
  liveness becomes an on-chain check — is noted under _Future work_.)
- SPA changes. Pruning is transparent to the SPA — it simply sees shorter feeds.
- Client-side cache behavior. Pruning makes the curator's *published* feeds
  honest; it cannot evict already-warm browser caches.

## The node-cache problem and the stewardship solution

This is the single most important design constraint, so it is addressed first.

### The problem

A naive liveness check — "fetch the content, did it 404?" — is **wrong**, because
it would be answered by the curator's *own Bee node cache*, not the network.

Bee's storage layer is a `localstore` = an in-memory cache + a persistent disk
store. Our node runs as a **light node** (`--full-node=false`,
`--storage-incentives-enable=false`), so it has **no reserve**, but it still
**caches every chunk it retrieves** (default `cache-capacity` ≈ 1,000,000 chunks,
LRU-evicted).

Consequences:

- When the curator **ingested** a post, it fetched the submission + content
  objects — populating the node's localstore cache with those chunks.
- A later liveness fetch of the same reference is served **from that cache**,
  returning `200` even if the content has been garbage-collected from the rest
  of the network. → **false "alive"**, the post is never pruned.
- The curator's JS-level `clearCache()` (`swarmit-protocol/swarm`) only clears an
  in-process `Map` of parsed objects — it does **not** touch Bee's localstore.

So any check built on `fetchObject` / `bee.downloadFile` (the normal retrieval
path, which is localstore-first) is unreliable for liveness.

### The solution: `GET /stewardship/{reference}`

Bee provides a purpose-built endpoint. `GET /stewardship/{reference}` returns
`{ "isRetrievable": boolean }` and is **cache-immune by construction**.

Verified against the Bee source (`pkg/steward/steward.go`): `IsRetrievable`
traverses the content's entire chunk tree using a `netGetter`, whose `Get` is:

```go
func (ng *netGetter) Get(ctx context.Context, addr swarm.Address) (swarm.Chunk, error) {
    return ng.retrieval.RetrieveChunk(ctx, addr, swarm.ZeroAddress)
}
```

It calls the retrieval protocol **directly**, bypassing the localstore/cache
entirely, and forces a real network retrieval for every chunk. `isRetrievable`
is `true` only if **every** chunk of the content is retrievable from the network.

This is exactly the honest "is this content actually still out there" signal we
need, and it requires no second node, no cache tuning, and no extra node
control — the node we already run exposes it. (`bee-js` v11 wraps it as
`bee.isReferenceRetrievable(reference)`.)

### Costs and caveats of stewardship checks

- **Bandwidth / SWAP.** Forcing network retrieval of *live* content consumes
  retrieval bandwidth, paid via SWAP cheques from the node's chequebook. The
  node's chequebook balance is currently **0**; low volume is covered by the
  per-peer free bandwidth allowance, but a high-volume curator would need the
  chequebook funded. Checking *dead* content costs nothing (no chunks received).
- **Latency.** A stewardship check traverses the whole chunk tree over the
  network — much slower than a cache hit. Each check needs a timeout. Curator
  content objects are small JSON (a few chunks), and sweeps are infrequent, so
  this is acceptable.
- **Error handling.** Treat any thrown error / timeout from the check the same
  as `isRetrievable: false` for that sweep — it becomes a strike, absorbed by the
  strike threshold (see below). The check must never crash the poll loop.
- _(open)_ Confirm `bee-js` v11's exact method name/signature and that it
  returns `false` (rather than throwing) for unretrievable content.

## Liveness state model

### Per-submission state

Three additive columns on the `submissions` table:

```sql
unreachable_strikes INTEGER NOT NULL DEFAULT 0   -- consecutive failed death-sweep checks
stale_since         INTEGER                       -- ms epoch when pruned; NULL while live
ingested_at         INTEGER NOT NULL DEFAULT 0    -- ms epoch when addSubmission() inserted the row
```

`stale_since` is the **authoritative "excluded from feeds" flag**.
`unreachable_strikes` is purely the death-sweep's debounce counter.
`ingested_at` is set to `Date.now()` at insert time by `addSubmission()`; it
drives the death-sweep recency grace window (below). Pre-existing rows migrated
via `ALTER TABLE` get `0`, so they are treated as old and checked immediately.

### Three states

```
        death sweep: strikes reach threshold
   ┌──────────────────────────────────────────────┐
   │                                               ▼
┌──────┐                                      ┌──────────────┐
│ LIVE │                                      │    STALE     │
│      │ ◀──────────────────────────────────  │  (watched)   │
└──────┘   resurrection sweep: isRetrievable   └──────────────┘
   ▲              == true                            │
   │                                                 │ time since stale_since
   │                                                 │ exceeds GIVEUP_AFTER
   │  (impossible — never rechecked)                  ▼
   │                                          ┌──────────────┐
   └───────────────────────────────────────── │  ABANDONED   │
                                               │ (terminal)   │
                                               └──────────────┘
```

| State | Definition | In feeds? | Checked by |
|-------|------------|-----------|------------|
| **LIVE** | `stale_since IS NULL` | Yes | Death sweep |
| **STALE (watched)** | `stale_since` set, and `now - stale_since ≤ RECHECK_GIVEUP_AFTER` | No | Resurrection sweep — only if `RECHECK_DEAD = true` |
| **ABANDONED** | `stale_since` set, and `now - stale_since > RECHECK_GIVEUP_AFTER` | No | Nothing — terminal |

`ABANDONED` is **derived** from `stale_since` + config — no extra column, no
write. Changing the `GIVEUP_AFTER` env var retroactively re-classifies rows,
which is acceptable and even useful.

The "missing-person-declared-dead" analogy: content stays actively searched for
(`STALE`) for a bounded window, then is formally given up on (`ABANDONED`).

### Transitions

| From → To | Trigger | DB writes | Republish? |
|-----------|---------|-----------|------------|
| LIVE → STALE | Death sweep: `unreachable_strikes` reaches `STRIKE_THRESHOLD` | `stale_since = now` | **Yes** — board feeds change |
| STALE → LIVE | Resurrection sweep: `isRetrievable == true` | `unreachable_strikes = 0`, `stale_since = NULL` | **Yes** — board feeds change |
| STALE → ABANDONED | Passage of time | none (derived) | No — already excluded |
| ABANDONED → * | — | — | Impossible (terminal) |

Note: with `RECHECK_DEAD = false` (the default — see below), the resurrection
sweep never runs, so `STALE` is effectively terminal too. The `ABANDONED` state
only matters when rechecking is enabled.

## The two sweeps

New module: `src/indexer/liveness.js`, exporting `runDeathSweep()` and
`runResurrectionSweep()`. The split is deliberate: detecting that live content
has *died* is more urgent and frequent than detecting that dead content has
*come back*, so the two run on independent cadences.

All checks use the cache-immune stewardship primitive (a new
`isRetrievable(ref)` on the shared Bee client — see _Work packages_).

### Death sweep — `runDeathSweep()`

Detects LIVE → STALE.

```
threshold    = config.livenessStrikeThreshold
graceCutoff  = now - config.livenessIngestGrace   // skip just-ingested posts
changedBoards = new Set()

// getLiveSubmissions excludes: stale_since set, AND ingested_at > graceCutoff.
// Optionally capped by BATCH_SIZE.
for each row in getLiveSubmissions(graceCutoff):
    ok = await isRetrievable(row.contentRef)  // stewardship; errors/timeouts → false

    if ok:
        if row.unreachableStrikes != 0:
            setStrikes(row.submissionRef, 0)
    else:
        newStrikes = min(row.unreachableStrikes + 1, threshold)
        setStrikes(row.submissionRef, newStrikes)
        if newStrikes >= threshold:
            markStale(row.submissionRef, now)     // sets stale_since
            changedBoards.add(row.boardSlug)

return { changedBoards }
```

The strike threshold (default `2`) absorbs transient network failures: a one-off
unretrievable result is a single strike; pruning requires `threshold`
consecutive failed sweeps.

The **recency grace window** skips posts ingested within the last
`LIVENESS_INGEST_GRACE` seconds: ingestion itself just verified their
retrievability (`processEvents` fetches submission + content before indexing),
so an immediate re-probe is wasted work. After a full DB rebuild every row is
freshly ingested, so the first death sweep is naturally a no-op until the grace
window elapses — also correct, since re-ingest re-verified everything.

### Resurrection sweep — `runResurrectionSweep()`

Detects STALE → LIVE. Runs only when `config.livenessRecheckDead == true`.

```
giveUpMs = config.livenessRecheckGiveUpAfter   // 0 = never give up
cutoff   = giveUpMs > 0 ? now - giveUpMs : 0
changedBoards = new Set()

for each row in getResurrectionCandidates(cutoff):   // stale_since IS NOT NULL
                                                     // AND (cutoff == 0 OR stale_since > cutoff)
    ok = await isRetrievable(row.contentRef)

    if ok:
        markLive(row.submissionRef)             // strikes = 0, stale_since = NULL
        changedBoards.add(row.boardSlug)
    // else: still dead — leave as-is; it will be retried until it ages into ABANDONED

return { changedBoards }
```

Design choice — **resurrect on the first successful check**, no confirmation
threshold. Rationale: stewardship is network-forced and unambiguous; a success
genuinely means the content is back. (Contrast the death side, where the strike
threshold guards against transient *failures*.) A confirmation threshold could be
added later if false resurrections are ever observed. _(open)_

`ABANDONED` rows simply fall outside the `getResurrectionCandidates` query —
no work, no writes.

## Query filtering

Feed builders must exclude any non-LIVE submission. Because `stale_since` is the
authoritative flag, the filter is a single clause:

```sql
AND stale_since IS NULL
```

`getRootSubmissions` and `getRepliesForRoot` (`src/db/repos/submissions.js`) are
the two chokepoints feeding every index builder:

- `getRootSubmissions` → `getPostsForBoard` (board-indexer) and `collectAllPosts`
  (global-indexer).
- `getRepliesForRoot` → `buildThreadIndexForRoot` (thread-indexer).

Both gain an optional `liveOnly` parameter (default `false` to preserve existing
callers/tests) that appends `AND stale_since IS NULL`. The indexer layer passes
`liveOnly: true`. `getSubmissionsForBoard` gets the same option for consistency.

The sweeps deliberately use **separate, unfiltered accessors** so they can see
non-LIVE rows:

- `getLiveSubmissions(graceCutoff)` — `WHERE stale_since IS NULL AND ingested_at
  <= :graceCutoff` (death sweep).
- `getResurrectionCandidates(cutoff)` — `WHERE stale_since IS NOT NULL AND
  (:cutoff = 0 OR stale_since > :cutoff)` (resurrection sweep).

Because every builder draws from the two chokepoints, stale posts disappear from
chronological, `best`, `hot`, `rising`, `controversial`, board, and global feeds
with no per-builder logic.

## Thread integrity

A dead **reply** in the middle of a thread would orphan its children: the
thread-indexer derives each node's `depth` from its parent link, and a missing
parent yields `depthMap.get(parent) ?? 0`, silently reparenting the subtree.

Fix in `buildThreadIndexForRoot` (`src/indexer/thread-indexer.js`): the
`getRepliesForRoot` query already drops stale replies (`liveOnly: true`); the
indexer then walks replies in announcement order and includes a reply **only
if** its `parentSubmissionId` is the root or an already-included reply — pruning
the entire subtree under any dropped reply.

```
included = { rootRef }
for reply in replies (announcement order, already stale-filtered):
    if reply.parentSubmissionId === rootRef or included.has(reply.parentSubmissionId):
        emit node; included.add(reply.submissionRef)
    else:
        skip (descendant of a pruned/dead reply)
```

A dead **root post** is excluded from board/global feeds by the
`getRootSubmissions` filter; its thread feed manifest becomes unreferenced and is
left untouched (harmless — nothing links to it).

## Orchestrator wiring

In `pollOnce` (`src/indexer/orchestrator.js`), after `processEvents` and before
the publish phase, gated by `config.livenessEnabled`:

1. **Death sweep** — if `Date.now() - meta('last_death_sweep_at') ≥
   config.livenessCheckInterval`: run `runDeathSweep()`, then
   `setMeta('last_death_sweep_at', now)`.
2. **Resurrection sweep** — if `config.livenessRecheckDead` **and**
   `Date.now() - meta('last_resurrection_sweep_at') ≥
   config.livenessRecheckInterval`: run `runResurrectionSweep()`, then
   `setMeta('last_resurrection_sweep_at', now)`.
3. Union both sweeps' `changedBoards` into the poll's `changedBoards`; for each,
   `addRepublishBoard(slug)` and `setRepublishGlobal(true)`.

The existing publish phase then rebuilds the affected board feeds, ranked feeds,
and — because `publishIndexes` rebuilds **all** thread feeds for any board in
`republishBoards` — the thread feeds too. No separate thread-change tracking is
needed.

The sweeps are **not** added to `hasPendingWork()`; like the existing ranked
refresh, they are purely timer-driven and must not keep the loop from idling.

## Configuration

New environment variables (parsed in `src/config.js`, documented in
`.env.example` and the `README.md` configuration table):

| Variable | Default | Description |
|----------|---------|-------------|
| `LIVENESS_ENABLED` | `true` | Master kill switch for the whole feature. |
| `LIVENESS_CHECK_INTERVAL` | `3600` | Seconds between **death sweeps**. |
| `LIVENESS_STRIKE_THRESHOLD` | `2` | Consecutive failed death-sweep checks before a post is pruned. `2` tolerates a one-off network blip. |
| `LIVENESS_INGEST_GRACE` | `3600` | Seconds after ingestion during which a post is skipped by the death sweep — ingestion already verified it. |
| `LIVENESS_RECHECK_DEAD` | `false` | Whether to ever re-check already-pruned content for resurrection. Default `false` reflects the current assumption that dead Swarm content does not come back. Flip to `true` if that proves wrong. |
| `LIVENESS_RECHECK_INTERVAL` | `21600` | Seconds between **resurrection sweeps**. Longer than the death interval — resurrection is rarer and less urgent. Used only when `RECHECK_DEAD = true`. |
| `LIVENESS_RECHECK_GIVEUP_AFTER` | `2592000` (30 d) | After a post has been stale this many seconds, stop re-checking it (it becomes `ABANDONED`). `0` = never give up. Used only when `RECHECK_DEAD = true`. |
| `LIVENESS_BATCH_SIZE` | `0` | Optional cap on submissions checked per sweep; `0` = all. A scale knob — see _Future work_. |

Behavioural summary:

- **Default config** (`RECHECK_DEAD = false`): content is checked while live;
  once pruned it is never touched again. Matches the current working assumption.
- `RECHECK_DEAD = true`, `GIVEUP_AFTER = 0`: pruned content is re-checked
  forever.
- `RECHECK_DEAD = true`, `GIVEUP_AFTER > 0`: pruned content is re-checked until
  it has been stale for that long, then abandoned.

With defaults, a post that goes dead is pruned ~`2 × CHECK_INTERVAL` (~2 h) after
it first fails. On the first death sweep after deploy every already-dead post
earns one strike; the second sweep prunes it.

## Work packages

| # | Repo / File(s) | Change |
|---|----------------|--------|
| WP0 | **`swarmit-protocol`** — `src/swarm/client.js` | Add `isRetrievable(ref)` to `createBeeClient`, wrapping `bee.isReferenceRetrievable` (`GET /stewardship/{ref}`). Export it. Add a test. |
| WP1 | `src/swarm/client.js` (curator) | Re-export the new `isRetrievable` from the protocol Bee client. |
| WP2 | `src/db/migrate.js` | Add `unreachable_strikes`, `stale_since`, `ingested_at` to `CREATE TABLE submissions`; idempotent `ALTER TABLE` (via `PRAGMA table_info`) for existing DBs. |
| WP3 | `src/db/repos/submissions.js` | `addSubmission` sets `ingested_at = Date.now()` at insert; `liveOnly` option on `getRootSubmissions`, `getRepliesForRoot`, `getSubmissionsForBoard`; new `getLiveSubmissions(graceCutoff)`, `getResurrectionCandidates(cutoff)`, `setStrikes(ref, n)`, `markStale(ref, ts)`, `markLive(ref)`. |
| WP4 | `src/indexer/state.js` | Re-export the new repo functions. |
| WP5 | `src/indexer/liveness.js` _(new)_ | `runDeathSweep()`, `runResurrectionSweep()`. |
| WP6 | `src/config.js`, `.env.example`, `README.md` | Eight new config vars. |
| WP7 | `src/indexer/board-indexer.js`, `global-indexer.js`, `thread-indexer.js` | Pass `liveOnly: true` to the chokepoint queries. |
| WP8 | `src/indexer/thread-indexer.js` | Subtree pruning for dropped replies. |
| WP9 | `src/indexer/orchestrator.js` | Timer-driven death + resurrection sweeps and republish wiring in `pollOnce`. |
| WP10 | `test/` (both repos) | New tests — see below. |

## Testing

Following `docs/testing-roadmap.md` conventions (`node --test`, `assert`,
fixtures in `test/helpers/`):

- **protocol `isRetrievable`** — mock the Bee HTTP layer; assert it maps
  `isRetrievable` true/false and surfaces errors as a rejection (which the sweep
  treats as `false`).
- **death sweep** — `isRetrievable` mocked to `false` for a chosen ref; assert
  strikes increment, cap at threshold, set `stale_since` on the threshold-th
  failed sweep, and that a recovered ref resets strikes to `0`.
- **resurrection sweep** — a stale row with `isRetrievable` mocked to `true` is
  cleared (`stale_since = NULL`); a row past `GIVEUP_AFTER` is not even queried;
  the sweep does nothing when `RECHECK_DEAD = false`.
- **query filtering** — `liveOnly: true` excludes rows with `stale_since` set;
  omitting the option keeps old behavior.
- **thread-indexer** — a dead reply and its entire subtree are pruned; siblings
  and the root are unaffected.
- **orchestrator** — a sweep that flips a post's liveness adds its board to
  `republish_boards` and sets `republishGlobal`; sweeps respect their intervals
  and `LIVENESS_ENABLED`.
- **recency grace** — a post with `ingested_at` inside the grace window is not
  returned by `getLiveSubmissions` and is left unchecked; once aged past the
  window it is checked normally.
- **migration** — applying the migration to a pre-existing DB adds all three
  columns with defaults and is safe to re-run.

## Known limitations

1. **Bandwidth cost / chequebook.** Stewardship checks of *live* content consume
   retrieval bandwidth paid via SWAP; the node's chequebook is currently empty.
   Fine for current low volume (per-peer free allowance); a high-volume curator
   would need the chequebook funded. Tracked as an ops dependency, not a blocker.
2. **Transient vs. permanent failures are not distinguished.** A stewardship
   timeout and a genuine `404` both count as one strike. The strike threshold
   absorbs transients; persistently dead content accrues strikes every sweep and
   is pruned. Acceptable.
3. **Client caches are not affected.** Pruning corrects the curator's *published*
   feeds. A browser with a warm cache keeps showing pruned posts until its cache
   expires or the user hard-refreshes.
4. **Whole-tree retrievability.** `isRetrievable` is all-or-nothing for a
   content object's chunk tree. A partially-GC'd object reads as dead — correct
   for our purposes.

## Future work

- **Incremental sweeps** — at scale, checking every submission every sweep is
  `O(N)` network probes. Add a per-row `last_checked_at` and a round-robin cursor
  so each sweep checks the `LIVENESS_BATCH_SIZE` least-recently-checked rows.
- **Bounded probe concurrency** — the sweeps probe submissions sequentially
  today (simple, and it naturally rate-limits the Bee node). The companion to
  the incremental work is a small worker pool — **never** an unbounded
  `Promise.all`, which would flood the Bee node with simultaneous retrievals
  and turn into self-inflicted timeouts the sweep misreads as strikes.
- **Metrics / observability** — expose live/stale/abandoned counts per board
  (e.g. via the dashboard, which already reads the curator SQLite DB).
- **Protocol-level liveness** — if the protocol recorded the postage batch ID
  backing each content object at submission time, the curator could check batch
  TTL on-chain instead of probing Swarm — cheaper and fully deterministic. Out
  of scope here; noted for the protocol roadmap.

## Rollout

- **Cross-repo:** WP0 ships in `swarmit-protocol` first (curator depends on it).
- Otherwise a pure curator code change — no infrastructure work, no new BZZ
  spend. The depth-17 postage batch bought during the incident is sufficient;
  pruning adds no uploads beyond the normal republish cycle.
- The SQLite migration applies automatically on startup (additive columns).
- Ships via a normal `feature/sqlite` → Coolify redeploy of the curator app
  (`q135u8mbku45zjivxt3he5an`).
- After deploy: first death sweep flags dead content (one strike), second sweep
  (~1 h later) prunes it; watch curator logs for the sweep summary.

## Resolved decisions

- **Probe `contentRef` only**, not `submissionRef`. The two objects are uploaded
  together by the same poster under the same postage batch and die together;
  probing only `contentRef` halves the stewardship/SWAP cost. (2026-05)
- **Resurrect on the first successful check** — no confirmation threshold.
  Stewardship successes are cache-immune and unambiguous. (2026-05)
- **Skip a recency grace window** in the death sweep — posts ingested within
  `LIVENESS_INGEST_GRACE` are not re-probed, since ingestion just verified them.
  Implemented via the `ingested_at` column. (2026-05)

## Open questions / to be added

- _(open)_ Confirm `bee-js` v11 method name/signature for stewardship and its
  behavior on unretrievable content (returns `false` vs. throws) — resolved at
  implementation time, not a design decision.
- _(open)_ Cross-reference the separate content-durability design once it exists.
- _(placeholder)_ Further requirements to be appended here.
