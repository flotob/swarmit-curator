# Publish Latency Reduction & Postage Capacity Recovery — Implementation Plan

Cut the time between a user submitting a post and seeing it in the curator's
published feeds from minutes to seconds, and stop silently exhausting the
postage batch in the process.

> Status: **draft / planning**. Sections marked _(open)_ are still under
> discussion.

## Background

### Symptom

Posts on Swarmit take noticeably long to be picked up by the curator and
appear in the published feeds — minutes today rather than the ~tens of seconds
the chain + Swarm fundamentals would allow.

### Discovery: the curator is currently broken

While investigating the latency complaint, a separate live-production issue
surfaced. Every timed ranked-feed refresh has been failing:

```
[Ranked] Failed best-board refresh for r/crypto: Request failed with status code 400
[Ranked] Failed hot-board refresh for r/crypto: Request failed with status code 400
… (all 16 ranked board feeds + 4 ranked global feeds, every ~15 min) …
[Curator] Processing blocks 46269872 → 46269890
```

The 18-block gap (`46269872 → 46269890 ≈ 90s`) is the curator catching up
after a long, mostly-failing publish cycle. End-to-end, the curator is running
**5+ minutes behind chain tip** as a direct result.

### Root cause

A series of in-container probes pinned down two compounding problems:

1. **Over-publishing.** Every 15 minutes the curator unconditionally
   republishes all four ranked variants (`best`, `hot`, `rising`,
   `controversial`) for every board and the global feed, plus the same four
   on every event-driven publish. The `best-board-tech` feed is at index
   **3383** — 3384 updates over the lifetime of the current postage batch,
   the vast majority of which carried no new information.

2. **Immutable postage batch.** The depth-17 batch `391243ec…` bought during
   the May 2026 stamp-expiry incident was inadvertently created as
   **immutable** (the default of bee's `POST /stamps` without explicit
   `Immutable: false`). On an immutable batch, once a bucket reaches its
   `2^(depth − bucketDepth) = 2` chunks it is **permanently full** — Bee
   cannot evict older chunks to make room. The probe shows the batch's
   utilization is at the maximum (`utilization: 2`), and `updateFeed` calls
   whose new SOC chunk happens to hash to a full bucket fail with:

   ```
   { "code": 400, "message": "chunk write error" }
   ```

   `board-tech` (chronological), `probe-feed-<new>`, and many others succeed
   — their next-index SOC lands in a non-full bucket. The four ranked
   variants of each board + global all fail; their addresses happen to hash
   into already-full buckets.

The combination means: thousands of unnecessary SOC writes have permanently
locked up roughly half of the batch's buckets, and the publishes most prone
to over-write — the ranked refresh feeds — are exactly the ones whose next
SOCs now collide with full buckets.

### Side effect: confused front-end behaviour

The publish failures don't crash the curator — they're caught and logged.
But each failed publish still costs the wall-clock time of the (failed) HTTP
round-trip, and the curator's `pollOnce` is sequential. Result: the curator
falls behind chain by 90s–6min and every new post inherits that backlog as
publish latency.

## Latency budget

End-to-end "user submits a post → curator's published feeds show it":

| Stage | Today | Floor | Notes |
|---|---|---|---|
| Block production on Gnosis | ~5s | ~5s | Hard floor |
| Confirmations (`CONFIRMATIONS=2`) | ~10s | ~5s | Tunable to 1 confirmation |
| Poll interval (avg = ½ × `POLL_INTERVAL=5`) | ~2.5s | <1s | Tunable / replaceable by subscription |
| Swarm content discoverability | 0.5–few s | 0.5–few s | Poster's content reaching the curator's node |
| `processEvents` (fetch + validate) | ~0.5–1s | ~0.5–1s | Sequential fetchObject per submission |
| `publishIndexes` + `publishGlobalAndProfile` | ~10s | ~2–3s | ~11 sequential feed writes per single new post |
| Catch-up backlog from failing publishes | **~90s–5min** | 0 | The bug — every cycle wastes time on doomed writes |
| **Total (today, observed)** | **~2–5 min** | | |
| **Total (after fixing the bug only)** | **~25–30s** | | |
| **Total (after all in-scope work)** | **~8–12s** | | |

Per-event publish work, unpacked:

| Feed | Today | After scope |
|---|---|---|
| `thread-${rootRef}` | ✓ | ✓ |
| `board-${slug}` (chronological) | ✓ | ✓ |
| `hot-board-${slug}` (default view) | ✓ | ✓ |
| `best-board-${slug}` | ✓ | timer-only |
| `rising-board-${slug}` | ✓ | timer-only |
| `controversial-board-${slug}` | ✓ | timer-only |
| `global` (chronological) | ✓ | ✓ |
| `hot-global` (default view) | ✓ | ✓ |
| `best-global` / `rising-global` / `controversial-global` | ✓ | timer-only |
| **Writes per single new post** | **~11** | **~4–5** |

## Scope

### In scope

- **Postage capacity recovery** — buy a fresh mutable batch and migrate the
  curator to it, ending the silent `chunk write error` cycle.
- **No-change skip on feed publish** — the largest write reduction; do not
  rewrite a feed when the index content is unchanged.
- **Decoupling ranked variants from event-driven publish** — only the default
  feeds (`board-${slug}`, `hot-board-${slug}`, `global`, `hot-global`) plus
  the affected thread feed are written on each new event; `best` / `rising` /
  `controversial` run only on the timer, gated by the no-change skip.
- **Cheap config wins** — `CONFIRMATIONS=1`, lower `POLL_INTERVAL`, shorter
  `RANKED_REFRESH_INTERVAL`.
- **Parallel publish within a poll** — `Promise.all` the per-board feed
  writes that don't depend on one another.

### Out of scope

- **WebSocket chain subscription** — covered by WP6 below.
- **Bounded concurrency for the liveness sweep** — already tracked in
  `docs/liveness-pruning-plan.md`'s Future work; mention here only because
  the publish-parallelization pattern (WP5) is the same idiom.
- **Protocol changes** (e.g. embedding titles in board entries so the SPA
  doesn't need to fetch each post on render). Out of scope.

## Design decisions

### Skip `updateFeed` when the index is unchanged

Every `updateFeed` call writes one new SOC chunk regardless of whether the
content ref it points at has changed. With the current ranked-refresh
behaviour, ~80% of those SOC writes carry no new information.

The fix is to gate `updateFeed` (and `publishJSON`) on whether the new index
content actually differs from the last published one. Detection is done with
a content hash stored in the `meta` table:

```
last_published_hash:<feedName>  →  hex(sha256(JSON.stringify(indexObj)))
```

Rationale:
- **Hash-only, not full content compare.** A 64-character hex value per feed
  in `meta` is cheap; whole-content comparison would force re-reading the
  prior bytes from Swarm.
- **`JSON.stringify` is deterministic across runs of the same code** in V8
  (insertion-order key emission). For the curator's purposes this is stable
  enough. (See _Known limitations_ for the edge case.)
- **Skip both `publishJSON` and `updateFeed` when the hash matches.** The
  data chunk would dedupe via Swarm's content-addressing anyway, but the
  HTTP round-trip cost is non-trivial; skipping it saves wall-clock time.
- **Hash is updated only on a successful `updateFeed`.** If a publish fails,
  the next cycle will retry the same content rather than skip it.

### Decouple ranked variants from event-driven publish

On a new submission or vote, only the **default** feeds need to reflect the
change immediately:

- The post must appear in the chronological feed.
- The post must appear in the default ("hot") feed — what the SPA shows on
  landing.
- The thread feed must reflect new replies.

The non-default ranked views (`best`, `rising`, `controversial`) only
meaningfully change with **votes**, and their freshness need is bounded by
the timed refresh, not by event arrival.

Therefore the event-driven publish path will write:

- `thread-${rootRef}` (per changed thread)
- `board-${slug}` (chronological)
- `hot-board-${slug}` (default)
- `global` (chronological)
- `hot-global` (default)

Everything else is left to the timed `publishRankedRefresh`, which now
self-skips when unchanged. This cuts per-event publish work roughly in half
without sacrificing perceived freshness.

### Buy a mutable postage batch and migrate to it

The immutable batch's stuck buckets cannot be recovered. The fix is to **buy
a new mutable batch** (`POST /stamps/{amount}/{depth}` with `Immutable:
false` header) and switch the curator to it. Concretely:

- Same depth (17) and amount (~6-month TTL) as the previous purchase: ~2.2
  xBZZ. Headroom is fine because the post-WP2 write rate is roughly 10×
  lower than before, **and** mutable buckets recycle on collision.
- Funding source: either send fresh xBZZ to the node wallet
  (`0x6b44…0Ce27`), or withdraw the needed amount from the chequebook to the
  wallet via `/chequebook/withdraw/{amount}`. _(open: which?)_
- The curator's feeds resolve by manifest reference, which is derived from
  the curator's address + topic — **not** from the batch. Migrating to a
  new batch is transparent to the SPA; future updates are stamped under the
  new batch, the manifest ref is unchanged, and the latest SOC continues to
  be discoverable.
- The old immutable batch's TTL (~178 days remaining) keeps its chunks
  retrievable until the curator has had time to re-stamp anything important
  under the new batch.

### Tunable config defaults — be honest about the floor

| Var | Today | Proposed | Why |
|---|---|---|---|
| `CONFIRMATIONS` | `2` | `1` | Gnosis has PoS finality; single-block reorg risk is negligible. Saves ~5s. |
| `POLL_INTERVAL` | `5` (s) | `1` or `2` | RPC cost is trivial; the floor here is the chain RPC roundtrip, not the loop's CPU. |
| `RANKED_REFRESH_INTERVAL` | `15` (min) | `2`–`3` | With the no-change skip the volume of writes drops anyway; smaller interval keeps ranked views feeling fresh. |

### Parallelize independent feed writes within a poll

`publishIndexes` writes feeds sequentially — for each changed board: thread
feeds → board chronological → ranked-board variants. Each call is a
sequential `await`. The writes within a single board (after the chronological
is up) are **independent** of one another and can run in parallel.

Concretely: keep the chronological write first (so we have a current
boardIndex committed), then `Promise.all` the thread feeds and any ranked
variants that we do publish. On a busy poll this halves the wall-clock.

We are deliberately **not** parallelizing across boards. Independent boards
are independent, but limiting concurrency per poll keeps the Bee node from
being slammed.

## Work packages

| # | Package | Covers | Touches |
|---|---------|--------|---------|
| **WP1** | Mutable postage batch + migration | Buy a fresh mutable depth-17 batch; PATCH `POSTAGE_BATCH_ID`; redeploy. | Bee + Coolify only — no code |
| **WP2** | No-change skip in `publishAndUpdateFeed` | Hash the index JSON; store `last_published_hash:<feedName>` in `meta`; skip both `publishJSON` and `updateFeed` when unchanged. | `feed-manager.js`, `db/repos/meta.js` (new helper or inline), tests |
| **WP3** | Decouple ranked variants from event-driven publish | `publishIndexes` and `publishGlobalAndProfile` no longer write `best` / `rising` / `controversial` on event; only on the timer (`publishRankedRefresh`). | `orchestrator.js`, tests |
| **WP4** | Cheap config wins | Bump `CONFIRMATIONS=1`, `POLL_INTERVAL=2`, `RANKED_REFRESH_INTERVAL=3`. | Coolify env only |
| **WP5** | Parallel feed writes per poll | `Promise.all` the within-a-board independent writes in `publishIndexes` and the global-feed group in `publishGlobalAndProfile`. | `orchestrator.js`, tests |
| **WP6** | WebSocket chain subscription | Replace polling for new blocks/events with `eth_subscribe('logs', …)` via a WSS Gnosis RPC. Eliminates `POLL_INTERVAL` from the latency budget (~2.5s avg saved); the curator reacts the instant a confirmed log lands. Requires a new RPC provider URL (current `https://rpc.gnosischain.com` is HTTPS-only). | `chain/reader.js`, `config.js`, Coolify env, tests |

## Testing

Following `docs/testing-roadmap.md` conventions (`node --test`, `assert`,
fixtures in `test/helpers/`):

- **WP2 hash skip** — first call writes; second call with identical index
  short-circuits (mock `publishJSON` and `updateFeed`, assert they are not
  called); changing one field triggers a fresh write. Failure of
  `updateFeed` must not update the stored hash.
- **WP2 hash determinism** — same index built from the same DB state
  produces the same hash across runs.
- **WP3 event-driven scope** — given an event that produces `changedBoards`
  and `changedThreads`, the publish phase writes only the chronological +
  default + thread feeds; the `best` / `rising` / `controversial` feed
  writes are not attempted.
- **WP3 timer scope** — `publishRankedRefresh` continues to attempt all four
  ranked variants for all boards + global (gated by the WP2 skip).
- **WP5 parallel** — instrument with a counter; multiple feed writes within
  a poll execute concurrently and not sequentially.

## Known limitations

1. **`JSON.stringify` is not strictly canonical across all JS engines.**
   Across runs of the same code in the same Node version it is deterministic
   (V8 preserves insertion order on plain objects), which is what we need.
   If the curator ever runs on a different engine, the no-change skip could
   under-detect (resulting in unnecessary writes, not in missed updates).
2. **The old immutable batch's locked buckets are unrecoverable.** They will
   simply expire with the batch (~178 days). No data is lost; existing
   chunks remain retrievable until then.
3. **Decoupling ranked variants from event-driven publish trades a tiny bit
   of immediacy for a lot of write economy.** A vote on a post will, with
   `RANKED_REFRESH_INTERVAL=3`, take up to ~3 minutes to be reflected in the
   non-default views. The default ("hot") view still updates immediately on
   any change.
4. **Parallel feed writes (WP5) increase peak load on the Bee node within a
   poll**, but the per-poll volume is bounded (`~5` writes after WP3) and
   well below what a healthy Bee node handles.

## Future work

- **Bounded probe concurrency for the liveness sweep** — tracked in
  `docs/liveness-pruning-plan.md` Future work. The publish-parallelization
  idiom here is a natural prototype for it.
- **Pre-published default-feed bundles** — if perceived latency is still
  uncomfortable after this plan ships, consider including a small recent-
  posts snapshot as a sibling resource of the default board feed, so the
  SPA's first render doesn't need to follow the thread-feed chain.
- **Mutable-batch top-ups before TTL expiry** — set a reminder before the
  new batch's expiry; mutable batches accept `PATCH /stamps/topup/<id>/<amount>`.

## Rollout

Order matters. **WP1 first** to immediately end the silent failures, then
WP2/WP3 to lock in the lower write rate before the new batch starts
accumulating, then WP4/WP5 to round out the latency wins.

### Phase 0 — preparation _(open)_

- Decide depth/duration for the new batch.
- Decide funding source (fresh xBZZ to wallet, or `/chequebook/withdraw`
  back to wallet).

### Phase 1 — WP1: new batch + migration (urgent) — **✓ done 2026-05-20**

Result: mutable batch `fbdeeea2093f1bb222e4b67c15e3d4fe966f27b0195ef982251dc7e988fae99c`
(depth 17, ~375-day TTL, cost ~4.59 xBZZ, funded by `/chequebook/withdraw`
from the chequebook). Curator redeployed; every previously-failing
`[Ranked]` publish now succeeds. See `swarmit-coolify/README.md`.

1. Ensure wallet has the required xBZZ (top up or withdraw from chequebook).
2. Buy the batch:
   ```
   POST /stamps/<amount>/<depth>?label=swarmit-curator-mutable
   Headers: Immutable: false
   ```
3. Poll the batch until `usable: true`.
4. PATCH `POSTAGE_BATCH_ID` on the curator app via the Coolify API.
5. Redeploy the curator app.
6. Watch logs for `[Ranked]` lines to confirm the writes now succeed.
7. Update `swarmit-coolify/README.md` with the new batch ID, depth,
   purchase date, expiry, and **`Immutable: false`** noted prominently so
   the mistake isn't repeated.

### Phase 2 — WP2 + WP3 (code; one feature branch, two commits)

- Land WP2 first so WP3's reduced event-publish scope inherits the no-change
  skip on the timer-driven side.
- Each commit goes through `/simplify` before landing, per the project
  workflow.

### Phase 3 — WP4 (config)

- PATCH env vars via the Coolify API.
- No redeploy required for env-only changes _(verify with a curator
  restart)_.

### Phase 4 — WP5 (parallelize)

- Code change; standard simplify-and-merge.

## Open questions / to be added

- _(open)_ New batch depth/duration — same as before (depth 17, ~180d,
  ~2.2 xBZZ), or larger headroom (depth 18, ~4.4 xBZZ)?
- _(open)_ Funding source for the new batch — direct send to wallet, or
  `/chequebook/withdraw` from the funded chequebook?
- _(open)_ `RANKED_REFRESH_INTERVAL` final value — 2 minutes is responsive
  but writes more often; 5 minutes is calmer. Default proposed: 3.
- _(open)_ Should `POLL_INTERVAL` go all the way to 1s, or stop at 2s? At 1s
  with `CONFIRMATIONS=1` the average post-pickup latency would drop another
  ~0.5s; the cost is double the RPC traffic. Default proposed: 2s.
- _(placeholder)_ Further requirements to be appended here.
