# Swarmit Curator — Testing Roadmap

## Approach

Use Node.js built-in test runner (`node --test`) with `assert`. No external test framework. Tests live in `test/` mirroring the `src/` structure.

## Test Structure

```
test/
  protocol/
    references.test.js
    objects.test.js
  indexer/
    validator.test.js
    board-indexer.test.js
    thread-indexer.test.js
    global-indexer.test.js
    state.test.js
  helpers/
    fixtures.js           # Shared test fixtures (valid objects, addresses, refs)
```

## Package.json Script

```json
"scripts": {
  "test": "node --test test/**/*.test.js"
}
```

---

## Work Packages

### TP1: Test Fixtures + Setup

**Create:** `test/helpers/fixtures.js`, update `package.json`

Shared fixtures used by all tests:
- Valid `bzz://` references (64-char lowercase hex with prefix)
- Valid Ethereum addresses
- Valid author ref `{ address, userFeed }`
- Valid body `{ kind: 'markdown', text: '...' }`
- Pre-built valid objects for each of the 9 protocol types (board, post, reply, submission, userFeedIndex, boardIndex, threadIndex, globalIndex, curatorProfile)
- A set of known board slugs for validator tests
- Chain event-like objects with blockNumber/logIndex

**Verify:** `npm test` runs and reports 0 tests (framework wired correctly).

---

### TP2: Protocol References Tests

**Create:** `test/protocol/references.test.js`

Test `src/protocol/references.js`:

- `refToHex`
  - bare 64-char hex → returns lowercase hex
  - `bzz://` prefixed → strips prefix, returns lowercase
  - mixed case → lowercased
  - too short / too long / non-hex → returns `''`
  - paths (`bzz://hex/path`) → returns `''`
  - null / undefined / number → returns `''`

- `hexToBzz`
  - bare hex → returns `bzz://<lowercase>`
  - already prefixed → normalizes
  - invalid input → returns `''`

- `isValidRef`
  - valid bare hex → true
  - valid bzz:// → true
  - garbage → false

- `isValidBzzRef`
  - valid lowercase bzz:// → true
  - uppercase hex → false (strict lowercase)
  - bare hex without prefix → false
  - invalid → false

- `hexToBytes32` / `bytes32ToHex`
  - round-trip: hexToBytes32(x) → bytes32ToHex → x
  - adds/strips 0x prefix correctly
  - rejects invalid input

- `refToBytes32` / `bytes32ToRef`
  - bzz:// ref → 0x-prefixed bytes32 → back to bzz://

- `slugToBoardId`
  - known slug → deterministic keccak256 hash
  - empty/null → throws

---

### TP3: Protocol Objects Tests

**Create:** `test/protocol/objects.test.js`

Test builders and validators from `src/protocol/objects.js`:

**Builders:**
- Each builder produces an object with correct `protocol` field
- `buildBoard` defaults `boardId` to `slug`, accepts explicit `boardId`
- `buildSubmission` with `kind: 'post'` excludes parent/root
- `buildSubmission` with `kind: 'reply'` includes parent/root
- `buildUserFeedIndex` defaults entries to `[]`
- All builders set `createdAt` / `updatedAt` to a recent timestamp

**Validators:**
- Each valid fixture object passes its validator with 0 errors
- Missing required fields → specific error messages
- Wrong protocol field → error
- `validateSubmission` with `kind: 'post'` rejects `parentSubmissionId` / `rootSubmissionId`
- `validateSubmission` with `kind: 'reply'` requires `parentSubmissionId` + `rootSubmissionId` as bzz:// refs
- `validateSubmission` with `kind: 'reply'` rejects bare hex refs (must be bzz://)
- `validateSubmission` with unknown `kind` → error
- Index validators check nested entry fields:
  - `validateUserFeedIndex` rejects entries missing `submissionId` or with bare hex
  - `validateBoardIndex` rejects entries missing `submissionRef`
  - `validateThreadIndex` rejects nodes missing `depth` or with invalid `parentSubmissionId`
  - `validateGlobalIndex` rejects entries missing `boardId`

**Generic `validate()`:**
- Dispatches to correct validator based on protocol field
- Unknown protocol → error
- Missing protocol → error
- Non-object input → error

---

### TP4: Ingestion Validator Tests

**Create:** `test/indexer/validator.test.js`

Test `src/indexer/validator.js`:

- `validateIngestedSubmission`
  - valid submission + known board → passes
  - valid submission + unknown board → fails with "not registered"
  - missing protocol field → fails
  - invalid contentRef (bare hex, not bzz://) → fails
  - missing author.address → fails

- `validateIngestedContent`
  - valid post → passes
  - valid reply → passes
  - post with missing title → fails
  - reply with missing body.text → fails
  - wrong expectedKind → fails
  - null content → fails

- `validateReplyConsistency`
  - reply with known parent + root → passes
  - reply with unknown parent → fails
  - reply with unknown root → fails
  - reply with missing parentSubmissionId → fails
  - non-reply (kind: 'post') → passes (skipped)

---

### TP5: Board Indexer Tests

**Create:** `test/indexer/board-indexer.test.js`

Test `src/indexer/board-indexer.js`:

- `buildBoardIndexForBoard`
  - Empty board (no submissions) → valid boardIndex with empty entries
  - Board with 3 posts → entries sorted by announcement order (newest first by blockNumber, then logIndex)
  - Only includes `kind: 'post'` submissions, not replies
  - Includes `threadIndexFeed` on entries where thread feed exists in state
  - Omits `threadIndexFeed` when thread feed not yet created
  - Output passes `validateBoardIndex`

Setup: these tests need to populate state with test submissions and feeds via the state.js accessors.

---

### TP6: Thread Indexer Tests

**Create:** `test/indexer/thread-indexer.test.js`

Test `src/indexer/thread-indexer.js`:

- `buildThreadIndexForRoot`
  - Root post with no replies → nodes has 1 element (root at depth 0)
  - Root with 2 direct replies → nodes has 3 elements, replies at depth 1
  - Nested replies → correct depth calculation (reply to reply = depth 2)
  - Replies sorted by announcement order (ascending — oldest first within thread)
  - Root node has `parentSubmissionId: null`
  - Output passes `validateThreadIndex`

---

### TP7: Global Indexer Tests

**Create:** `test/indexer/global-indexer.test.js`

Test `src/indexer/global-indexer.js`:

- `buildGlobalIndexFromState`
  - No boards → valid globalIndex with empty entries
  - 2 boards with posts → entries from both boards, sorted newest first
  - Only includes posts, not replies
  - Output passes `validateGlobalIndex`

---

### TP8: State Manager Tests

**Create:** `test/indexer/state.test.js`

Test `src/indexer/state.js`:

- Save + load round-trip preserves all fields
- Atomic write: temp file is cleaned up
- Missing state file → `loadState` returns false, fresh state
- Corrupt state file → `loadState` returns false with warning, fresh state
- Retry state fields (retrySubmissions, republishBoards, etc.) survive round-trip
- `getSubmissionsForBoard` filters correctly
- `getRootSubmissions` excludes replies
- `getRepliesForRoot` finds all replies for a root

Use a temp directory for state file to avoid polluting the project.

---

## Implementation Order

```
TP1  Fixtures + Setup
 ↓
TP2  References (pure, no deps)
TP3  Objects (pure, no deps)
 ↓
TP4  Validator (depends on objects)
 ↓
TP5  Board Indexer
TP6  Thread Indexer  (parallel)
TP7  Global Indexer
 ↓
TP8  State Manager
```

TP2+TP3 can run in parallel. TP5+TP6+TP7 can run in parallel.

## What Is NOT Tested Here

- **Swarm client** (client.js) — bee-js API wrapper, needs a real Bee node
- **Chain reader** (reader.js) — ethers.js wrapper, needs a real RPC endpoint
- **Feed manager** (feed-manager.js) — needs Bee node for feed operations
- **Profile manager** (profile-manager.js) — needs Bee node + chain for CuratorDeclared tx
- **Main loop** (index.js) — integration test, validated by running the service against real infra

These are best covered by manual integration testing or a future integration test suite with mocked externals.

## Notes for the Test Builder

- Import from `src/` using relative paths (the project uses ES modules with `"type": "module"`)
- State tests should use a temp directory and clean up after each test
- Indexer tests need to populate state before running — use state.js accessors directly
- Protocol modules are copied from the SPA and may be tightened during testing — that's expected
- The `TYPES` constants come from `src/protocol/constants.js`, not `src/config.js`
