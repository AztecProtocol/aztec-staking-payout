# aztec-staking-payout — technical reference

Off-chain settlement runner for delegator payouts. Reads the operator's stakers from on-chain (no manual list to maintain), computes the period's reward from the rollup's protocol formula (`checkpointsProposed × checkpointReward × sequencerBps / 10000`), splits it across active delegators **in proportion to the checkpoints each delegator's attester actually proposed** (minus commission), and emits direct ERC20.transfer calls for the distribution wallet to execute.

Self-contained: archival RPC + one config file with the commission rate and 4 addresses. No indexer dependency, no policy file, no contract deployment.

## Quick start

```bash
cd aztec-staking-payout
npm install
npm test
```

For a real run:

```bash
# Edit config.example.yaml with your StakingRegistry + rollup + distribution wallet + token + RPC.
aztec-staking-payout settle \
  --config ./config.example.yaml \
  --from-epoch 107 \
  --emit-calldata
# (--to-epoch defaults to "latest-proven" — the rollup's most recent fully-proven
#  epoch in an L1-finalized block. Pin a number for reproducible runs.
#  --emit-calldata takes an optional path; omitted, writes next to the audit.)
# → writes:
#   runs/epoch-107-<to>-<runId>.json      — audit record + encoded calldata
#   runs/epoch-107-<to>-<runId>.safe.json — Safe Transaction Builder import
# Drag the .safe.json into your Safe app's Transaction Builder.
```

## Architecture

```
runner/
  README.md
  package.json
  tsconfig.json
  config.example.yaml
  src/
    cli.ts          CLI entry (settle / status / help)
    config.ts       config loader (zod schema, YAML)
    discovery.ts    enumerate active delegators from chain (StakedWithProvider + IGSE.isRegistered)
    proposals.ts    count checkpoints each attester proposed (recover proposer from propose() calldata signature)
    attribution.ts  proposal-weighted split (default) + equal-split fallback
    calldata.ts     ERC20.transfer calldata + Safe export
    settle.ts       orchestrator
    audit.ts        run record writer + plan pretty-printer
    types.ts        shared types
    *.test.ts       vitest unit tests
```

## What the runner does

For each `settle` run:

1. **Reads `commissionBps` from the config.** A single rate in basis points (10000 = 100%), used directly in the per-delegator math. Operators change the rate by editing the config between runs.
2. **Resolves the epoch range** to `[fromBlock, toBlock]` + `[fromCheckpoint, toCheckpoint]` via timestamp math against the rollup (`getTimestampForEpoch`, L1 timestamp binary search, `getTips`, `getProvenCheckpointNumber`). Gates: `toEpoch ≤ latestProvenEpoch`, and `toBlock ≤ L1 finalized block`. ~140 RPC.
3. **Reads `getRewardConfig()` at `toBlock`** for `checkpointReward` and `sequencerBps`. The per-checkpoint sequencer reward is `checkpointReward × sequencerBps / 10000`.
4. **Discovers active delegators from on-chain** (see below):
   - Scans the StakingRegistry's `StakedWithProvider` events filtered by `providerId`.
   - For each attester ever staked under this provider, calls `IGSE.isRegistered(rollup, attester)` to filter out exits.
   - Returns the staker (msg.sender) addresses of currently active attesters.
5. **Attributes by actual work** (`attributionMode: proposals`, the default): scans `CheckpointProposed` events in the window, recovers each checkpoint's proposer from its `propose()` transaction signature, and splits `oursProposed × per-checkpoint sequencer reward` in proportion to how many checkpoints each delegator's attester proposed — then applies the commission rate. A delegator whose attester proposed nothing earns nothing. (`attributionMode: equal-split` requires `--simulate-reward <amount>` for the total; it has no proposal count to multiply by.) Per-delegator integer division rounds down; dust accrues to the operator.
6. **Builds one direct `ERC20.transfer` transaction per recipient**. The distribution wallet itself executes these calls, so the token balance is spent from the Safe/EOA/smart account rather than from an intermediate helper contract.
7. **Branches on output mode**:
   - `--dry-run`: prints the plan, writes the audit record, doesn't send.
   - `--emit-calldata [<path>]`: writes a `.safe.json` next to the audit (or at `<path>` if given) for Safe Transaction Builder. No broadcast.
   - default (live): signs + sends via PRIVATE_KEY. Signer must equal the distribution wallet. Pre-flight checks the wallet has enough balance (operator must claim from the rollup first via `rollup.claimSequencerRewards(distributionWallet)`).
8. **Writes the audit record** with the discovered delegator list, the rollup's `getRewardConfig` snapshot, per-attester checkpoint counts, the per-checkpoint attribution trail, the per-delegator transfer breakdown, **the encoded calldata** (so cold-wallet signers can read it without needing the sibling `.safe.json`), the commission, and (if live) the tx hash.

### Manual reward override (`--simulate-reward <amount>`)

The default reward is the protocol formula above — deterministic and reproducible from on-chain data alone, no balance reads required. `--simulate-reward <amount>` pins a hypothetical reward in token base units instead (e.g. for what-if sizing), and forces dry-run as a safety. It's also the only way to drive `attributionMode: equal-split`, which has no proposal count to feed into the formula.

## On-chain delegator discovery

The runner enumerates the operator's stakers automatically — no manual list to maintain.

```
1. eth_getLogs StakingRegistry → StakedWithProvider events
   filtered by topic1=providerId
   over [stakingRegistryDeployedAtBlock, toBlock]
   in logChunkSize chunks

   Yields: (attester, split, staker=msg.sender, txHash, block) per stake event
   (rollup scoping is done by the isRegistered check in step 4, not here)

2. For each stake, fetch its transaction receipt and read the SplitCreated
   log emitted in the SAME tx (the StakingRegistry creates the split inside
   stake()). Decode splitParams.recipients[1].

   Yields: splitAddress → recipients[1] (the _userRewardsRecipient)

3. Resolve GSE + bonus instance from the rollup:
   gse   = IStaking(rollupAddress).getGSE()
   bonus = IGSE(gse).getBonusInstanceAddress()

4. For each unique attester (batched via Multicall3):
   active = IGSE.isRegistered(rollupAddress, attester)     // moveWithLatest=false
         || IGSE.isRegistered(bonus,         attester)     // moveWithLatest=true
   if active:
     delegator = splitRecipients[split]  // _userRewardsRecipient
                 ?? staker               // fallback to msg.sender
```

**The PullSplit recipient is preferred over msg.sender.** When the staker called `StakingRegistry.stake(..., _userRewardsRecipient, ...)` they may have passed a recipient address different from their own. The runner recovers this from the `SplitCreated` log emitted in the **same transaction** as each stake (the StakingRegistry calls the PullSplitFactory synchronously in `stake()`) — `splitParams.recipients[1]` is the user's chosen recipient (`recipients[0]` is the operator's `providerRewardsRecipient`). Reading it from the stake's own receipt means there's no separate event scan and no factory address to look up. If the SplitCreated log can't be matched (e.g. an unrecognised StakingRegistry version, or the receipt is unavailable), the runner falls back to `staker` (msg.sender) and tags the audit record with `delegatorSource: "msg.sender"`.

**Both deposit styles count.** An attester registers under the rollup instance (`moveWithLatestRollup = false`) or under the GSE bonus instance (`= true`); the runner checks both, so a delegator using either is discovered.

**Performance.** One full-range log scan (StakedWithProvider), chunked by `logChunkSize` (default 10,000 blocks per call) — set `stakingRegistryDeployedAtBlock` so it starts there rather than block 0. Split recipients then come from one transaction-receipt fetch per stake (≤ stake count, fetched concurrently), not a second range scan. The `isRegistered` checks are batched through Multicall3 (two reads per attester). For small operators (<100 attesters) the whole discovery is well under a second.

**Escape hatch.** `execution.delegatorsOverride` in config bypasses discovery entirely — for edge cases where the on-chain recipient resolution doesn't match the operator's intent.

## Attribution by work — how, and its limits

The protocol credits block rewards to `sequencerRewards[coinbase]`, keyed by the coinbase each checkpoint's proposer sets ([RewardLib.sol:242-245](https://github.com/AztecProtocol/aztec-packages/blob/4aeadbeffb0754388c8198694366048745477350/l1-contracts/src/core/libraries/rollup/RewardLib.sol#L242-L245)). There is **no per-attester reward ledger** — committee members who only attest earn nothing directly; only the per-checkpoint proposer and the per-epoch prover are paid. Since this design pools all coinbase rewards into one distribution wallet, the on-chain reward ledger can't tell apart which attester earned what.

So the runner reconstructs it from proposals (`attributionMode: proposals`, default):

1. Scan `CheckpointProposed` events over a block range that brackets the epoch window (a margin is added below `fromBlock` to absorb proof-submission timing skew). `checkpointNumber` is indexed; the precise gate is the resolved `[fromCheckpoint, toCheckpoint]` range — events outside it are dropped and counted in `outOfRangeCheckpoints` for the audit. Each kept event carries the `propose()` transaction hash.
2. For each transaction, fetch its calldata and **recover the proposer from the proposer's own signature** in it. `propose()` carries `_attestationsAndSignersSignature`, which the proposer signs over `keccak256(abi.encode(attestationsAndSigners, _attestations, _signers))` (EIP-191 prefixed) — see [`ValidatorSelectionLib.verifyProposer`](https://github.com/AztecProtocol/aztec-packages/blob/4aeadbeffb0754388c8198694366048745477350/l1-contracts/src/core/libraries/rollup/ValidatorSelectionLib.sol#L230). `ecrecover` on that yields the proposer attester address directly.
3. Keep only proposals by **our** attesters (the rest belong to other providers on the shared network), and split `oursProposed × per-checkpoint sequencer reward` in proportion to each attester's proposal count.

Transfers are **aggregated per unique recipient**: when several attesters resolve to the same delegator address, their weights are summed into a single `ERC20.transfer` (the audit records the contributing `attesters` count and total `weight`). The per-attester breakdown is still printed to the console for transparency.

This recovers the proposer from **transaction data + local ECDSA only** — no committee sampling, no validator-selection seed, and **no historical chain state**. That matters: reconstructing committees on-chain (`getEpochCommittee`/`getProposerAt`) requires either an archival node or on-chain history the deployment may have pruned, and in practice resolves only for epochs near the chain head. Transactions, by contrast, are retained by every node regardless of state pruning, so this path works on a plain full node.

**Limits / assumptions:**
- Weighting is by **proposal count**, not exact per-checkpoint reward. The fixed `sequencerCheckpointReward` dominates, but variable transaction fees per checkpoint are not yet accounted for (a future refinement would parse the per-checkpoint `fees` array from epoch-proof calldata).
- Assumes all the operator's sequencers pool rewards into the one configured coinbase/distribution wallet. The protocol formula computes the reward from `oursProposed` (checkpoints by *our* attesters); if none of the operator's attesters proposed in the window, the reward is 0 and the run exits as a no-op.
- One `eth_getTransactionByHash` per checkpoint, fetched through a bounded concurrency pool and **rate-limited** to `rpcMaxRequestsPerSecond` (config, default 100) so a full-window run stays under the provider's cap (e.g. QuickNode free = 125/s). Every fetch is **retried with backoff**, and a run **hard-fails if any checkpoint stays unresolved** — so a plan is only ever built from 100% resolved data (no silently-dropped checkpoints, no run-to-run drift). Set `rpcMaxRequestsPerSecond` to your plan's limit; settling shorter windows reduces the call count.

  > JSON-RPC batching was tried and removed: benchmarked against QuickNode, batched `eth_getTransactionByHash` POSTs were ~10× slower and caused HTTP failures (large multi-tx responses), so per-call requests are the reliable path.

**Determinism.** For a *fixed* `[--from-epoch, --to-epoch]` window the result is exact and reproducible. Note that `--to-epoch latest-proven` advances each run as new epochs prove, so the window (and thus the counts) genuinely changes — pin `--to-epoch <number>` to compare runs.

**Finalization gate.** The resolver pins everything to the L1 *finalized* block: it reads `getProvenCheckpointNumber()` at finality, derives the latest fully-proven epoch via a safe `getEpochForCheckpoint(provenTip)` call, and refuses any `--to-epoch` above that. It then uses `getTimestampForEpoch(toEpoch + 1)` + L1 timestamp binary search to find the L1 block at the epoch boundary, reads `getTips(B).pending` there to get `toCheckpoint`, and binary-searches `getProvenCheckpointNumber(B)` to find `toBlock` (the L1 block where `toEpoch`'s proof landed). `fromBlock`/`fromCheckpoint` are found the same way against `fromEpoch`. Both block bounds are guaranteed L1-finalized by construction, so an L1 reorg can't invalidate a settlement.

**RPC cost & reductions.** Every run reports `RPC requests sent: N (P primary + R retries)`. The primary count is deterministic for a given window (retries fluctuate with RPC weather). Optimizations applied:

- **Multicall3 prelude.** `decimals`, `symbol`, `getGSE`, and `getRewardConfig` are batched into one Multicall3 call at `toBlock` — 4 individual reads collapse into 1 multicall + 1 `eth_chainId`. No balance reads (the reward comes from the protocol formula, not balance delta).
- **Local `BONUS_INSTANCE_ADDRESS`.** The GSE bonus-instance address is the public constant `keccak256("bonus-instance")[12:]`, so we compute it locally instead of calling `getBonusInstanceAddress()` (–1 RPC per run).
- **Skip the duplicate `getGSE()`.** Settle pre-fetches the GSE address in the prelude multicall and passes it to discovery, so discovery doesn't fetch it again (–1 RPC).
- **`stakeLogChunkSize` (opt-in).** The stake-event scan is filtered by `providerId` (indexed) and is therefore sparse over the full registry history. The default (10k) matches QuickNode's cap, but on permissive RPCs (Alchemy, Infura, full archive nodes) you can raise it to e.g. 100k — collapsing a ~140-chunk scan to ~14 calls.

On QuickNode (with the 10k cap) the measured small-window run is **1,177 primary RPC calls** (was ~1,200+ before, deterministic now thanks to the prelude batching). On a permissive RPC with `stakeLogChunkSize: "100000"` the same run would drop another ~125 calls.

**The biggest remaining lever (not yet implemented): persistent discovery cache.** Each run rescans the full registry history (~140 stake-scan `eth_getLogs` + ~200 stake-tx receipts ≈ 340 RPCs every time, regardless of window length). Persisting last-scanned block + resolved stakes between runs would cut those down to ~the delta since the last run — a one-off ~340-call reduction per re-run, dwarfing every per-run optimization above. Worth doing if you settle on a regular schedule.
- Checkpoints whose proposer can't be recovered (tx fetch/decode failure) are reported as `unresolved` with the first error surfaced, never silently dropped into someone's share.
- `attributionMode: equal-split` remains available as a flat-pool fallback, and is used automatically with `delegatorsOverride` (which has no attester→proposer mapping). The audit record tags `attributionMode` so downstream auditors know which was used.

## Config

See [config.example.yaml](./config.example.yaml). The file is flat (no nested objects) so key ordering carries meaning — top entries have sensible defaults, bottom entries are what the operator must set.

### Section 1 — Tunable defaults (rarely change)

| Field | Type | Default | Purpose |
|---|---|---|---|
| `multicallAddress` | address | `0xcA11bde05977b3631167028862bE2a173976CA11` | Multicall3 deployment. Same address on every major EVM chain; only override if your chain has it elsewhere. |
| `logChunkSize` | numeric string | `"10000"` | Max blocks per `eth_getLogs` call during discovery. Most public RPCs cap at 10k. |
| `dustThreshold` | numeric string | `"0"` | Skip transfers below this many token base units (after the rate is applied). |
| `runsDir` | path | `"./runs"` | Where to write audit records. |
| `stakingRegistryDeployedAtBlock` | numeric string | `"0"` | Bounds the event scan. Default `"0"` scans the whole chain; set this for performance. |
| `delegatorsOverride` | address[] | *unset* | Escape hatch — bypass on-chain discovery and use this list instead. Rarely needed. |

### Section 2 — Network-specific (look these up for your chain)

| Field | Type | Purpose |
|---|---|---|
| `tokenAddress` | address | Reward ERC20. |
| `stakingRegistryAddress` | address | Ignition-contracts `StakingRegistry` — source of `StakedWithProvider` events. |
| `rollupAddress` | address | Rollup instance the operator stakes against; used to derive GSE via `getGSE()` and to check active status via `isRegistered`. |

### Section 3 — Operator-specific (set per operator)

| Field | Type | Purpose |
|---|---|---|
| `providerId` | numeric string | Operator's provider id. |
| `distributionWalletAddress` | address | Wallet that receives coinbase rewards (Safe / multisig / smart account / EOA — any wallet you control). |
| `commissionBps` | integer (0–10000) | Commission rate in basis points; edit to change the rate between runs. |
| `rpcUrl` | URL | **Archival** RPC — historical `eth_call` against the rollup + event scans. |

Notably absent: `chainId` (read from RPC), `delegators` (discovered from chain).

The config file is YAML so section headers and per-field rationale live as real comments. JSON is still accepted (YAML is a superset) if you'd rather hand-write that.

## CLI

```
aztec-staking-payout settle  --from-epoch <n> [--to-epoch <n|latest-proven>]
                             [--config <path>] [--dry-run | --emit-calldata [<path>]]
aztec-staking-payout status  [--config <path>]
aztec-staking-payout help
```

`status` reads the wallet balance, chain id, and runs discovery so the operator can see the active delegator set without doing a settle.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | user/config error |
| 2 | pre-flight failure (insufficient wallet balance, signer mismatch, discovery error) |
| 3 | on-chain failure (tx reverted) |

## Modes

### `--dry-run`

Resolves the epoch range + reads reward config + discovers delegators + counts proposals + prints the per-delegator plan + writes audit. Doesn't send. No `PRIVATE_KEY` needed.

### `--emit-calldata <path>`

Writes a `.safe.json` (Safe Transaction Builder format — accepted by Safe and by many other multisig / smart-account signers) next to the audit JSON. Drop it into your wallet's transaction builder, review the per-delegator amounts, collect signatures, execute. Cold-wallet workflows can skip the `.safe.json` entirely and read the encoded `{to, value, data}` straight from the audit JSON's `transactions` array.

### Live (default)

Signs + sends with `PRIVATE_KEY`. Signer must match `distributionWalletAddress` (EOA case). Safes use `--emit-calldata`.

## What this runner does NOT do

- **Maintain a signed policy file.** If an operator wants to publish a credible commitment to delegators, they do that on their own at a stable URL. The runner just executes the rate that's currently in the config.
- **Compute per-attester variance.** See "Known limitation" above.
- **Verify each split's allocation matches what StakingRegistry would have written.** Reads `recipients[1]` as the user recipient and trusts it; doesn't double-check `recipients[0] == providerRewardsRecipient` or that `allocations` matches `providerTakeRate`. A bug or non-standard StakingRegistry could mean the wrong recipient is used; the audit record exposes the `delegatorSource` so a downstream auditor can flag it.
- **Cron itself.** Operator schedules `settle` and advances `--from-epoch` to (the previous run's `--to-epoch + 1`).

## Tests

```bash
npm test
```

Covers attribution (proposal-weighted + equal split + dust + rounding), proposals (checkpoint scan → recover proposer from a genuinely-signed `propose()` calldata + unresolved handling), calldata (direct ERC20.transfer encoding + Safe export), and discovery (event scan + same-tx split resolution + GSE filter + dedupe + log-chunking). All via mocked RPC — no network or chain access required.
