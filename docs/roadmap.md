# Swarmit Curator — Roadmap

## Work Packages

### WP1: Project Setup + Config

**Create:** `package.json`, `.env.example`, `src/config.js`

- Initialize Node.js project with `bee-js`, `ethers` v6, `dotenv`
- Config loader: validate all required env vars on startup, fail fast with clear errors
- Export typed config object used by all other modules

**Verify:** `node src/config.js` with a valid `.env` prints config summary and exits cleanly. Missing vars produce actionable error messages.

---

### WP2: Chain Reader

**Create:** `src/chain/reader.js`

- Poll Gnosis Chain for all 4 event types since a given block
- Confirmation depth: only process blocks that are `CONFIRMATIONS` behind latest
- Decode events using ethers.js Interface (same ABI as the SPA)
- Return structured event objects with `(blockNumber, logIndex)` for ordering
- Handle RPC errors gracefully (retry with backoff, don't crash)

**Verify:** Run standalone, print decoded events from the deployed contract.

---

### WP3: Swarm Client

**Create:** `src/swarm/client.js`

- Fetch immutable objects by reference (with in-memory cache)
- Publish JSON objects to Swarm (returns `bzz://` reference)
- Create feed manifests with the curator's private key
- Update feeds (sign new entry pointing to latest immutable content)
- Handle Bee API errors, postage batch validation

**Verify:** Publish a test JSON object, create a feed, update it, resolve it — all from a script.

---

### WP4: Protocol + Validator

**Create:** `src/protocol/references.js`, `src/protocol/objects.js`, `src/indexer/validator.js`

- Copy pure protocol modules from SPA (references.js, objects.js) — no I/O, pure logic
- Validator module: validate fetched submissions, posts, replies before indexing
  - Check protocol field, required fields, normalized `bzz://` refs
  - Check `kind` is `post` or `reply`
  - For replies: check parent/root references exist
  - For submissions: check board is in known boards set
- Return `{ valid, errors }` for logging

**Verify:** Unit-test the validator with valid and malformed objects.

---

### WP5: State Manager

**Create:** `src/indexer/state.js`

- In-memory state: known boards, submissions (keyed by submissionId), reply trees
- Each submission stored with `(blockNumber, logIndex)` announcement order
- Persist to JSON file on each loop iteration
- Load from JSON file on startup (resume from where we left off)
- Track feed manifest references (board feeds, thread feeds, global feed)

**Verify:** Add some test data, save to file, reload, verify consistency.

---

### WP6: Board + Thread + Global Indexer

**Create:** `src/indexer/board-indexer.js`, `src/indexer/thread-indexer.js`, `src/indexer/global-indexer.js`

- **Board indexer:** build `boardIndex` per board from submissions, sorted by announcement order (newest first). Include `threadIndexFeed` on each entry.
- **Thread indexer:** build `threadIndex` per root submission from the reply tree. Nodes ordered by announcement order with correct depth.
- **Global indexer:** build `globalIndex` across all boards, recent submissions from all boards combined.
- All use protocol builders (`buildBoardIndex`, `buildThreadIndex`, `buildGlobalIndex`) and validate output.

**Verify:** Feed test submissions into indexers, verify output matches schema.

---

### WP7: Feed Manager + Profile Manager

**Create:** `src/publisher/feed-manager.js`, `src/publisher/profile-manager.js`

- **Feed manager:**
  - Create board feed, thread feed, global feed on first use
  - Update feed to point at latest published index
  - Store feed manifest references in state
  - Idempotent: creating the same feed twice returns the existing manifest

- **Profile manager:**
  - Build `curatorProfile` with current `boardFeeds` and `globalIndexFeed`
  - Publish to Swarm, emit `CuratorDeclared` on-chain
  - Track which boards are in the current profile
  - Detect when new boards require a profile update

**Verify:** Create feeds, publish a profile, verify it's fetchable and the on-chain event is emitted.

---

### WP8: Main Loop + Integration

**Create:** `src/index.js`

- Wire everything together: config → chain reader → fetch + validate → index → publish → update feeds → save state
- Poll loop with `POLL_INTERVAL`
- Graceful shutdown (SIGINT/SIGTERM: save state, exit cleanly)
- Startup: load state, resume from last block, catch up
- Logging: each loop iteration logs blocks processed, events found, objects published
- Error handling: individual submission failures don't crash the loop

**Verify:** Run the full service against the deployed contract. Create a post via the SPA, wait for the curator to pick it up, then verify the board view in the SPA shows the new post.

---

### WP9: Polish + Deploy

- Error recovery: handle Bee node downtime, RPC flakiness, postage exhaustion
- Logging improvements
- Railway deploy config (Procfile or similar)
- README with setup instructions

**Verify:** Deploy to Railway, create a post in the SPA, see it appear in the board view within one poll cycle.

---

## Implementation Order

```
WP1  Setup + Config
 ↓
WP2  Chain Reader
WP3  Swarm Client (parallel with WP2)
 ↓
WP4  Protocol + Validator
WP5  State Manager (parallel with WP4)
 ↓
WP6  Indexers (board, thread, global)
 ↓
WP7  Feed Manager + Profile Manager
 ↓
WP8  Main Loop + Integration ← end-to-end test
 ↓
WP9  Polish + Deploy
```

**Critical path:** WP1 → WP2+WP3 → WP4+WP5 → WP6 → WP7 → WP8

## Pre-implementation requirements

1. **Bee node access** — the curator needs a Bee node to publish to Swarm. Local (`bee dev`) or remote.
2. **Postage batch** — purchased on the Bee node, batch ID in config.
3. **Curator wallet** — a funded Gnosis address (needs xDAI for `declareCurator` tx gas). Private key in config.
4. **Contract already deployed** — `0x34b27b9978E05B6EfD8AFEcc133C3b1fC5431613` on Gnosis mainnet.
