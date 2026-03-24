# Swarmit Curator — Architecture

## Overview

The Swarmit Curator is a Node.js background service that watches Gnosis Chain for protocol events, fetches and validates content from Swarm, builds curated indexes, and publishes them as feed-backed views that the Swarmit SPA reads.

This is a **reference implementation** — it implements a purely chronological, no-moderation curator. Anyone can fork it to build curators with custom ranking, spam filtering, or moderation policies.

## What the curator does

```
Chain Events → Fetch + Validate → Index → Publish to Swarm Feeds
```

1. **Watch** — poll Gnosis Chain for `BoardRegistered`, `BoardMetadataUpdated`, `SubmissionAnnounced`, and `CuratorDeclared` events
2. **Fetch** — download submission and content objects (post/reply) from Swarm
3. **Validate** — reject malformed objects, unknown boards, orphaned replies
4. **Index** — maintain in-memory state of boards, submissions, and reply trees
5. **Publish** — build and publish `boardIndex`, `threadIndex`, and `globalIndex` objects to Swarm
6. **Update feeds** — sign feed updates with the curator's key so stable URLs always resolve to latest indexes
7. **Announce** — emit `CuratorDeclared` on-chain when the curator profile changes (e.g., new board discovered)

## Core loop

```
1. Read last processed block from state (or CONTRACT_DEPLOY_BLOCK)
2. Fetch latest block number, subtract CONFIRMATIONS for reorg safety
3. Fetch all 4 event types from (lastBlock + 1) to (latest - CONFIRMATIONS)
4. Process BoardRegistered + BoardMetadataUpdated → update known boards
5. Process SubmissionAnnounced → for each:
   a. Skip if board not in known boards set
   b. Fetch submission from Swarm, validate
   c. Fetch content (post/reply) from Swarm, validate
   d. For replies: verify parent/root exist in state
   e. If valid: add to state with (blockNumber, logIndex) as announcement order
   f. If invalid: log warning, skip
6. For each board with changes:
   a. Build boardIndex (sorted by announcement order, newest first)
   b. For each root post with new replies: build threadIndex
   c. Publish indexes to Swarm, update board + thread feeds
   d. Include threadIndexFeed in boardIndex entries
7. Build globalIndex across all boards, publish, update global feed
8. If new boards discovered since last profile publish:
   re-publish curatorProfile with updated boardFeeds, emit CuratorDeclared
9. Save state (lastProcessedBlock, boards, submissions, feed refs)
10. Sleep POLL_INTERVAL, repeat
```

## Ordering

The reference curator sorts by **announcement order** — `(blockNumber, logIndex)` from the chain event, newest first. This is tamper-resistant: authors cannot game ordering by manipulating `createdAt` timestamps.

## Validation

The contract layer explicitly allows malformed off-chain objects and expects curators to reject them. Before indexing, the curator validates:

- `submission`: protocol field, required fields, normalized `bzz://` refs, `kind` is `post` or `reply`
- `post`: protocol field, author, title, body
- `reply`: protocol field, author, body
- Reply consistency: `parentSubmissionId` and `rootSubmissionId` must reference known submissions
- Board existence: submissions for unregistered boards are ignored

Malformed or orphaned items are logged and excluded from published indexes.

## CuratorProfile lifecycle

`curatorProfile` is an immutable Swarm object. When the curator needs to update it (e.g., a new board is discovered and added to `boardFeeds`), it must:

1. Build a new `curatorProfile` object with the updated `boardFeeds`
2. Publish it immutably to Swarm
3. Emit a fresh `CuratorDeclared` event on-chain with the new ref

This is compatible with the v1 spec — clients always use the latest `CuratorDeclared` event to find the current profile.

## Feed model

The curator owns and manages these feeds:

- **One global index feed** — cross-board front page
- **One board feed per board** — the `boardIndex` for each curated board
- **One thread feed per root post** — the `threadIndex` for each top-level submission

All feeds are signed with the curator's private key. Feed manifest references are stable — clients store them in the `curatorProfile` (for board feeds and global feed) and in `boardIndex` entries (for thread feeds via `threadIndexFeed`).

## Project structure

```
swarmit-curator/
  package.json
  .env.example
  docs/
    architecture.md       # This file
    roadmap.md            # Work packages
  src/
    index.js              # Entry: init, poll loop, graceful shutdown
    config.js             # Load .env, validate required vars
    chain/
      reader.js           # Poll events with confirmation depth
    swarm/
      client.js           # bee-js wrapper: fetch, publish, feeds
    indexer/
      state.js            # Persistent state: boards, submissions, feeds, last block
      validator.js        # Validate fetched objects before indexing
      board-indexer.js    # Build boardIndex sorted by announcement order
      thread-indexer.js   # Build threadIndex from reply tree
      global-indexer.js   # Build globalIndex across boards
    publisher/
      feed-manager.js     # Create/update feeds with curator key
      profile-manager.js  # Build + publish curatorProfile, emit CuratorDeclared
    protocol/             # Pure protocol logic (shared with SPA)
      references.js
      objects.js
```

## Configuration

```
# Chain
RPC_URL=https://rpc.gnosischain.com
CONTRACT_ADDRESS=0x34b27b9978E05B6EfD8AFEcc133C3b1fC5431613
CONTRACT_DEPLOY_BLOCK=45315302
CONFIRMATIONS=12
POLL_INTERVAL=30

# Swarm
BEE_URL=http://localhost:1633
POSTAGE_BATCH_ID=<your batch id>

# Curator identity
CURATOR_PRIVATE_KEY=<hex private key for feed signing + tx signing>
CURATOR_NAME=Chronological Curator
CURATOR_DESCRIPTION=Spam-filtered chronological board views

# State
STATE_FILE=./state.json
```

## Dependencies

- `@ethersphere/bee-js` — Swarm API (fetch, publish, feeds)
- `ethers` v6 — chain reads + curator wallet signing for `CuratorDeclared` tx
- `dotenv` — environment configuration

## What this implementation does NOT do

- No moderation logic (reference impl is purely chronological)
- No ranking or scoring algorithms
- No spam filtering beyond protocol validation
- No database (JSON file state is sufficient for MVP)
- No HTTP API (background worker only)

## Deploy

- **Local**: `node src/index.js` with `.env` pointing at a Bee node
- **Railway/Cloud**: same, with env vars in the platform dashboard
- **Requirements**: Bee node access with postage stamps, funded Gnosis wallet for `declareCurator` tx, curator Ethereum private key
