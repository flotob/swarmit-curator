Curator roadmap — publish feeds for empty boards

  Goal

  A newly registered board immediately appears in the curator's profile and has a (possibly empty) chronological feed, so readers discover it via
   curator coverage.

  Scope

  Curator repo only. A matching SPA change in swarmit/js/services/curator.js:100 (accept empty entries as a valid state) is a prerequisite for
  the end-user benefit, but is out of scope for this roadmap — tracked separately.

  ---
  Step 1 — Enqueue newly registered boards for publish

  File: src/indexer/orchestrator.js around the events.boards loop at line 140.

  After addBoard(...), also add the slug to changedBoards. This is the minimum change that makes fresh registrations flow into the existing
  publishIndexes path.

  One-liner inside the existing transaction or the post-transaction block. No new DB schema.

  Step 2 — Don't publish ranked feeds for empty boards

  File: src/indexer/orchestrator.js, publishIndexes loop at line 190.

  When posts.length === 0:
  - Publish only the default board-<slug> feed (chronological, empty entries).
  - Skip the 4 ranked builders (best-board-, hot-board-, rising-board-, controversial-board-) — ranking 0 items is meaningless and each skipped
  feed is 1 avoided write + 1 avoided JSON upload per empty board.
  - The same skip logic belongs in publishRankedRefresh (line 238) — it already has if (posts.length === 0) continue; at line 243, so that one's
  already correct.

  Step 3 — Verify profile builder handles empty boards gracefully

  File: src/publisher/profile-manager.js, buildProfile at line 32.

  No code change expected, but confirm by running the first two steps:
  - boardFeeds[slug] uses hotUrl || defaultUrl at line 36 — falls back to the default feed when no hot-board- exists. ✓
  - boardViewFeeds[slug] only sets views[view] = url when the feed exists (line 60). ✓

  Empty boards should show up in the profile with only .new populated. Add a unit test covering this so it doesn't regress.

  Step 4 — Backfill existing empty boards on startup

  File: src/indexer/orchestrator.js (or a new src/indexer/backfill.js).

  Without this, boards already registered but with zero posts stay invisible until somebody submits. One-shot sweep at startup:

  1. Load all boards via getAllBoards().
  2. For each board, check getFeed('board-<slug>') in state.
  3. If missing, enqueue via addRepublishBoard(slug) — reuses existing retry machinery so the next publishIndexes picks it up.

  Runs once per startup; cheap (SQLite reads only).

  Step 5 — Spam posture decision (config gate)

  File: src/config.js + src/indexer/orchestrator.js.

  Anyone can register a board on-chain. Without a gate, a spammer who burns gas on 1,000 junk registrations causes the curator to write 1,000
  empty feeds and bloat its profile. Options, pick one:

  1. Do nothing — rely on gas cost as the natural rate limiter. Simplest, accept the risk. Fine for early mainnet.
  2. Allowlist — CURATOR_BOARD_ALLOWLIST="foo,bar,baz" env var. If set, curator only publishes feeds for listed boards. Empty list = no gating.
  Easy to operate.
  3. Denylist — inverse of above; CURATOR_BOARD_DENYLIST. Reactive.
  4. Minimum-bar heuristic — e.g., only auto-publish empty feed if the board's registration had a non-empty boardRef with real metadata. Weak
  filter; spammers can pad metadata cheaply.

  My suggestion: (1) now, (2) later — ship the feature unguarded, add an allowlist env var only if spam materializes. That keeps this change
  small.

  Step 6 — Tests

  Files: existing test layout under test/ (check pattern before adding).

  - Ingest test: registering a board adds the slug to changedBoards.
  - Publish test: publishIndexes with an empty board publishes exactly one feed (default) and skips the 4 ranked ones.
  - Profile test: buildProfile emits an entry in boardFeeds and boardViewFeeds[slug].new for an empty board, with no ranked views.
  - Backfill test: on startup, a board with no feed gets enqueued; a board with an existing feed is skipped.

  Step 7 — Docs / operator notes

  File: README.md (if it covers operator behavior) or inline comments.

  Briefly note the new behavior: "empty boards get a default chronological feed on registration so they appear in curatorProfile.boardFeeds.
  Ranked feeds are only published once a board has posts." No docs file needed if README doesn't cover this level today.

  ---
  Out of scope / deferred

  - SPA change (swarmit repo): resolveBoard must treat empty entries as a valid empty state instead of falling through. Without this, the curator
   ships feeds the SPA ignores — user-facing benefit is partial (only the curator-picker coverage list improves) until that lands.
  - Allowlist / denylist / rate limiting: flagged in Step 5, deferred to operator judgment.
  - Ranked-feed creation on first post: when a board goes from 0 → 1 posts, the current publishIndexes will naturally start publishing ranked
  feeds on that next cycle. No special migration needed.

  Rollout

  Local dev first — register an empty board via the SPA or a script, verify curator publishes the default feed, verify the profile now lists the
  slug. Ship to prod on the next real deploy; no Coolify-specific steps.

  ---
  Review this and tell me which steps to trim, reorder, or expand. Happy to also pull the SPA side into a sibling roadmap if you want both tracks
   captured.