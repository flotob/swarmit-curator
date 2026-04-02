# Swarm Message Board v1 Vote Signals Patch

Date: 2026-03-28
Status: Draft patch proposal

## Purpose

This document proposes a v1 protocol extension that adds canonical public vote signals on-chain through a new `SwarmitRegistryV2` contract surface.

The core decision is:

- raw vote inputs live on-chain
- immutable post and reply content remains on Swarm
- ranking, scoring interpretation, and curated feed views remain curator-defined

This patch is intended to provide a strong common signal layer for future curator views such as:

- `best`
- `hot`
- `rising`
- `controversial`

without turning the contract into the canonical ranking engine.

## Summary of Changes

1. Add on-chain vote signaling to `SwarmitRegistryV2`
2. Make every announced `submissionId` votable, including both posts and replies
3. Define one active vote per `(submissionId, voter)` pair
4. Add a `VoteSet` event
5. Add a `setVote(submissionId, direction)` write method
6. Require `announceSubmission` to persist minimal submission bookkeeping needed for voting:
   - existence
   - `boardId`
   - `rootSubmissionId`
7. Keep ranking and feed ordering off-chain and curator-defined
8. Do not add any new Swarm object type for votes

## Rationale

Votes are different from post and reply content.

Unlike bodies and attachments, votes are:

- small
- highly discoverable coordination signals
- naturally wallet-bound
- most useful when globally indexable

Putting votes on-chain makes it easy for:

- curators to build ranked board, thread, and global views
- clients to inspect the public raw signal layer
- indexers to derive consistent score inputs without crawling many user-owned Swarm feeds

At the same time, this patch preserves a key Swarmit principle:

- the contract defines raw public signals
- curators define how those signals affect visibility and ranking

So there is still no single mandatory front page, score interpretation, or `hot` algorithm.

## Design Principles

1. Raw vote signals MUST be globally discoverable.
2. Raw vote signals MUST be tied to wallet identity (`msg.sender`).
3. A voter MUST have at most one active vote per submission.
4. Changing a vote and clearing a vote MUST be first-class operations.
5. Vote inputs MAY be canonical without making ranking canonical.
6. Curators MAY ignore votes, partially use votes, or weight votes differently.
7. This patch MUST NOT introduce a Swarm `vote` object.
8. `SwarmitRegistryV2` SHOULD expose only one canonical on-chain submission identity: `bytes32 submissionId`.
9. `SwarmitRegistryV2` SHOULD NOT accept or emit an independent `submissionRef` string.

## Canonical Vote Semantics

Votes target `submissionId`, not `contentRef`.

That means:

- top-level posts are votable
- replies are votable

This aligns voting with the protocol's existing canonical identity model:

- off-chain `submissionId` is the normalized `bzz://<hex>` form
- on-chain `submissionId` is the `bytes32` binary form

For `SwarmitRegistryV2`, the on-chain contract surface SHOULD use only the `bytes32` form.

Off-chain systems SHOULD reconstruct the normalized `bzz://<hex>` form from `submissionId` when needed.

### `direction`

`direction` is the canonical vote operation value:

- `1` = upvote
- `-1` = downvote
- `0` = clear existing vote / unvote

Rules:

- a voter can move directly from `1` to `-1`
- a voter can move directly from `-1` to `1`
- a voter can clear a previous vote using `0`
- submitting the same effective direction twice SHOULD fail rather than emit a no-op event

## Raw Signal vs Curated Score

This patch deliberately separates:

- canonical raw vote inputs
- curator-defined scoring and ranking outputs

What becomes canonical:

- who voted
- which submission they voted on
- whether the current vote is up, down, or cleared
- the current contract-maintained up/down totals for that submission

What does not become canonical:

- a single mandatory `score`
- a single mandatory `best` algorithm
- a single mandatory `hot` algorithm
- a single mandatory board or front-page ordering

Clients MAY display simple raw values such as:

- upvotes
- downvotes
- net score (`upvotes - downvotes`)

But curated feed ordering remains a curator responsibility.

## Normative Patch for `swarm-message-board-v1-spec.md`

### Patch Section 1 `Scope`

Amend the "This v1 spec defines:" list to include:

```md
- canonical public vote signals
```

Amend the "This v1 spec does not define:" list to replace:

```md
- ranking algorithms
```

with:

```md
- canonical ranking algorithms
```

### Patch Section 3 `Design Principles`

Add the following principle after current principle 4:

```md
5. Raw vote signals MAY be canonical and on-chain, but ranking and display order remain curator-defined.
```

Renumber subsequent items accordingly.

### Patch Section 4.3 `Gnosis Chain`

Amend the list of what Gnosis provides to include:

```md
- public vote signals
```

### Add New Section: `Voting Model`

Insert a new normative section after the canonical object types section:

```md
## Voting Model

Voting in v1 does not introduce a new immutable Swarm object type.

Instead:

- votes are public on-chain coordination signals
- votes target `submissionId`
- both posts and replies are votable

One active vote exists per `(submissionId, voter)` pair.

Canonical vote operations:

- `1` = upvote
- `-1` = downvote
- `0` = clear / unvote

Clients and curators MAY use contract-maintained vote totals as raw signal inputs.

However:

- no single ranking algorithm is canonical
- no single displayed score interpretation is mandatory
- curator views remain the default end-user reading surface
```

### Patch Read Expectations

Amend the client/indexer read expectations section to include:

```md
- `VoteSet` as the canonical raw vote signal log
```

And add:

```md
Curators MAY use public vote signals to derive ranked views, but clients SHOULD still prefer curator-backed feed views over directly rendering raw chain data as the primary reading surface.
```

### Add New Client Write Flow: `Vote Write`

Insert a new write-flow section:

```md
## Vote Write

Given a user interaction such as upvote, downvote, or clear vote, a compliant client SHOULD:

1. identify the target `submissionId`
2. convert it to the on-chain `bytes32` form if needed
3. call `setVote(submissionId, direction)` through the wallet provider
4. wait for transaction confirmation or surface pending state clearly
5. refresh local vote state and any dependent curator views as appropriate
```

### Patch Curator Responsibilities

Amend curator responsibilities to include:

```md
- MAY watch public vote events and incorporate them into curator-defined board, thread, and global ranking views
```

## Normative Patch for `swarm-message-board-v1-contract-spec.md`

### Patch Section 1 `Scope`

Amend the "This v1 contract spec defines:" list to include:

```md
- canonical public vote signaling
```

Amend the "This v1 contract spec does not define:" list to replace:

```md
- votes or DAO internals
```

with:

```md
- DAO internals
- canonical ranking algorithms
```

### Add New Canonical Type: `voteDirection`

Insert after current canonical types:

```md
### `voteDirection`

- Type: `int8`
- Meaning: current voter intent for a submission

Allowed values:

- `1` = upvote
- `-1` = downvote
- `0` = clear / unvote
```

### Add New Required Event: `VoteSet`

Insert after `CuratorDeclared`:

```solidity
event VoteSet(
  bytes32 indexed boardId,
  bytes32 indexed submissionId,
  address indexed voter,
  bytes32 rootSubmissionId,
  int8 direction,
  int8 previousDirection,
  uint64 upvotes,
  uint64 downvotes
);
```

Semantics:

- emitted whenever a voter sets, flips, or clears their vote for an announced submission
- `boardId` is derived from the previously announced submission metadata
- `rootSubmissionId` is derived from the previously announced submission metadata
- `direction` is the voter's new effective direction
- `previousDirection` is the voter's prior effective direction
- `upvotes` and `downvotes` are the contract-maintained totals after the state transition

### Add New Submission Bookkeeping Expectations

Insert before the minimal write interface section:

```md
## Submission Bookkeeping Expectations

To support voting, a compliant `SwarmitRegistryV2` deployment MUST persist minimal submission metadata when `announceSubmission` succeeds:

- whether the submission exists
- its `boardId`
- its `rootSubmissionId`

This bookkeeping exists only to support auditable vote signaling and vote-scoped indexing.

The contract still MUST NOT store post bodies, reply bodies, board indexes, or thread indexes.
```

### Patch Submission Announcement Identity Surface

Insert into the submission-announcement and minimal-interface sections:

```md
In `SwarmitRegistryV2`, `submissionId` SHOULD be the only canonical on-chain submission identity.

`SwarmitRegistryV2` SHOULD therefore:

- accept `bytes32 submissionId` in `announceSubmission`
- emit `bytes32 submissionId` in `SubmissionAnnounced`
- NOT accept an additional `submissionRef` string argument
- NOT emit an additional `submissionRef` string field

Off-chain clients and indexers SHOULD reconstruct the canonical normalized `bzz://<hex>` form from `submissionId`.
```

Recommended `SwarmitRegistryV2` submission-announcement surface:

```solidity
event SubmissionAnnounced(
  bytes32 indexed boardId,
  bytes32 indexed submissionId,
  bytes32 parentSubmissionId,
  bytes32 rootSubmissionId,
  address author
);

function announceSubmission(
  bytes32 boardId,
  bytes32 submissionId,
  bytes32 parentSubmissionId,
  bytes32 rootSubmissionId
) external;
```

### Patch Minimal Write Interface

Amend the minimal write interface to include:

```solidity
function setVote(
  bytes32 submissionId,
  int8 direction
) external;
```

### Add Recommended Read Interface

Add the following recommended public read methods:

```solidity
function getVote(
  bytes32 submissionId,
  address voter
) external view returns (int8);

function getVoteTotals(
  bytes32 submissionId
) external view returns (uint64 upvotes, uint64 downvotes);
```

Equivalent public getters are acceptable.

### Patch Access Control Expectations

Add a new subsection:

```md
### Vote Setting

`setVote` SHOULD be permissionless and tied to `msg.sender` as the effective voter identity.
```

### Patch Event-Level Validation Rules

Add a new subsection:

```md
## `VoteSet`

- the target `submissionId` MUST already exist
- `direction` MUST be one of:
  - `-1`
  - `0`
  - `1`
- setting the same effective direction twice SHOULD fail
- clearing a vote with `direction == 0` SHOULD only succeed if a non-zero vote already exists
- contract-maintained `upvotes` and `downvotes` MUST reflect the post-transition totals
```

### Patch `announceSubmission` Expectations

Amend the submission-announcement expectations to include:

```md
Additionally, in `SwarmitRegistryV2`, `announceSubmission` SHOULD fail if `submissionId` has already been announced.
```

And add:

```md
On success, `announceSubmission` MUST persist minimal submission bookkeeping sufficient for later `setVote` calls.
```

And add:

```md
In `SwarmitRegistryV2`, `announceSubmission` SHOULD use only `bytes32 submissionId` as the on-chain submission identity. Off-chain consumers SHOULD derive the normalized `submissionRef` string form from `submissionId`.
```

### Add Contract State Guidance

Add the following implementation guidance:

```md
Recommended state shape:

- `submissionExists[submissionId] -> bool`
- `submissionBoard[submissionId] -> boardId`
- `submissionRoot[submissionId] -> rootSubmissionId`
- `voteOf[submissionId][voter] -> int8`
- `upvoteCount[submissionId] -> uint64`
- `downvoteCount[submissionId] -> uint64`

Equivalent struct-based layouts are acceptable.
```

### Patch Non-Goals for v1 Contracts

Replace:

```md
- store votes or scores
```

with:

```md
- store post or reply bodies
- store board indexes or thread indexes
- provide canonical ranking or feed ordering
- enforce curator quality
```

And add:

```md
This patch allows contracts to store raw vote state and vote totals, but not canonical ranking outputs.
```

### Patch Deferred Beyond v1

Replace:

```md
- voting or karma systems
```

with:

```md
- stake-weighted or identity-weighted voting
- tokenized karma systems
- vote-market resistance or anti-sybil economics
```

## Reference `SwarmitRegistryV2` Semantics

For this patch, the intended implementation target is a new contract generation rather than a migration shim.

`SwarmitRegistryV2` SHOULD therefore:

1. keep board registration and curator declaration behavior equivalent to v1
2. tighten `announceSubmission` by recording submission existence and preventing duplicate `submissionId` announcements
3. remove the redundant `submissionRef` string from the V2 on-chain surface
4. require off-chain consumers to derive canonical `bzz://<hex>` refs from `submissionId`
5. add first-class vote state and vote totals
6. emit `VoteSet` whenever vote state changes

## Why This Enables Multi-View Feeds

This patch does not define `best`, `hot`, `rising`, or `controversial`.

What it does define is the shared raw signal layer that those views can build on.

That means the later multi-view feeds patch can remain what it should be:

- discovery metadata for named curator views

rather than trying to invent ranked views without any common public signal input.

## Explicit Non-Goals of This Patch

This patch does not:

- make any one score display canonical
- make any one feed ordering canonical
- require curators to use votes
- add token economics
- add sybil resistance
- add quadratic, stake-weighted, or reputation-weighted voting
- require new Swarm object types

## Backward Compatibility

This patch is intentionally not framed as a migration patch.

The target is a new `SwarmitRegistryV2` implementation.

Protocol-level content objects on Swarm remain unchanged:

- no post schema change
- no reply schema change
- no submission schema change
- no curator profile schema change is required just to support voting

## Recommendation

If adopted, this patch should be merged into:

- `docs/swarm-message-board-v1-spec.md`
- `docs/swarm-message-board-v1-contract-spec.md`

No changes are required to:

- `docs/swarm-message-board-v1-schemas.md`

because this patch introduces no new Swarm object type.
