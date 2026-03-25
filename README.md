# Swarmit Curator

Reference curator/indexer for the [Swarmit](https://github.com/user/swarmit) decentralized message board protocol.

Watches Gnosis Chain for protocol events, fetches and validates content from Swarm, builds curated indexes, and publishes them as feed-backed views that the Swarmit SPA reads.

## What it does

```
Chain Events → Fetch + Validate → Index → Publish to Swarm Feeds
```

1. Polls Gnosis Chain for `BoardRegistered`, `SubmissionAnnounced`, `CuratorDeclared` events
2. Fetches submission and content objects from Swarm, validates against protocol schemas
3. Builds `boardIndex`, `threadIndex`, and `globalIndex` sorted by announcement order
4. Publishes indexes to Swarm and updates stable feed manifests
5. Declares the curator profile on-chain so the SPA can discover it

This is a **reference implementation** — purely chronological ordering, no moderation, no ranking. Fork it to build curators with custom policies.

## Setup

### Prerequisites

- Node.js >= 18
- Access to a Bee node (e.g., Freedom Browser's built-in light node at `http://localhost:1633`)
- A postage batch on the Bee node
- A funded Gnosis Chain wallet (needs xDAI for `CuratorDeclared` gas)

### Install

```bash
npm install
cp .env.example .env
```

### Configure

Edit `.env`:

```
CURATOR_PRIVATE_KEY=0x...   # Your curator wallet private key
POSTAGE_BATCH_ID=...        # From your Bee node: curl http://localhost:1633/stamps
```

The private key is a single identity used for:
- Signing Swarm feed updates
- `curatorProfile.curator` address
- `msg.sender` on the `CuratorDeclared` transaction

All three must be the same address.

### Run

```bash
npm start
```

The curator will:
1. Catch up from the contract deploy block (or resume from last saved state)
2. Ingest all submissions, build indexes, publish feeds
3. Declare the curator profile on-chain
4. Poll for new submissions every 30 seconds

### Verify

Once running, open the Swarmit SPA in Freedom Browser and navigate to a board. The board view should discover the curator and display posts.

## Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | yes | — | Gnosis Chain RPC endpoint |
| `CONTRACT_ADDRESS` | yes | — | SwarmitRegistry contract address |
| `CONTRACT_DEPLOY_BLOCK` | yes | — | Block number the contract was deployed at |
| `CONFIRMATIONS` | no | `12` | Blocks behind latest to process (reorg safety) |
| `POLL_INTERVAL` | no | `30` | Seconds between poll cycles |
| `BEE_URL` | yes | — | Bee node API URL |
| `POSTAGE_BATCH_ID` | yes | — | Postage batch for uploads |
| `CURATOR_PRIVATE_KEY` | yes | — | Hex private key for feeds + chain tx |
| `CURATOR_NAME` | no | `Chronological Curator` | Display name in curator profile |
| `CURATOR_DESCRIPTION` | no | — | Description in curator profile |
| `STATE_FILE` | no | `./state.json` | Path to persistent state file |

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full design.

Key modules:

- `src/chain/reader.js` — polls chain events with confirmation depth
- `src/swarm/client.js` — bee-js wrapper for fetch, publish, feeds
- `src/indexer/validator.js` — validates objects before indexing
- `src/indexer/state.js` — persistent JSON state (rebuildable cache)
- `src/indexer/board-indexer.js` — builds boardIndex per board
- `src/indexer/thread-indexer.js` — builds threadIndex per thread
- `src/publisher/feed-manager.js` — creates and updates Swarm feeds
- `src/publisher/profile-manager.js` — publishes curatorProfile + CuratorDeclared tx
- `src/protocol/` — shared protocol logic (copied from SPA)

## State

`state.json` is a **rebuildable cache** — chain + Swarm are the source of truth. Deleting it and restarting will re-ingest everything from the deploy block. Writes are atomic (temp file + rename).

## Implementation Notes

### Upload method: uploadFile vs uploadData

The curator uses `bee.uploadFile()` to publish JSON objects to Swarm. This creates a manifest entry accessible at `/bzz/<ref>/`, which is the URL pattern the Swarmit SPA uses to fetch content (both via `fetch('/bzz/<ref>/')` and Freedom Browser's native `bzz://` protocol resolution).

The alternative `bee.uploadData()` stores raw bytes at `/bytes/<ref>` — more storage-efficient (no manifest wrapper) but not accessible via the `/bzz/` path that the SPA expects.

**Future optimization:** If Freedom Browser and the SPA are updated to support a raw-bytes read path (e.g., `/bytes/<ref>` or a new `swarm://` scheme), switching to `uploadData` would reduce per-object overhead. This would be a coordinated change across the curator, the SPA's `fetchObject`, and Freedom Browser's protocol handler.

### Ordering

Submissions are sorted by **announcement order** — `(blockNumber, logIndex)` from the chain event, not by author-supplied `createdAt` timestamps. This prevents ordering manipulation.

### Validation

The curator validates every object before indexing. Malformed submissions, invalid content, unknown boards, and orphaned replies are rejected. Transient fetch failures are retried on subsequent poll cycles.

### CuratorProfile lifecycle

`curatorProfile` is immutable in v1. When new boards are discovered, the curator publishes a new profile with updated `boardFeeds` and emits a fresh `CuratorDeclared` event.

## Testing

See [docs/testing-roadmap.md](docs/testing-roadmap.md) for the test plan.

```bash
npm test
```

## License

MIT
