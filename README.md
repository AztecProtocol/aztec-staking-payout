# aztec-staking-payout

> [!WARNING]
> This code is **not audited** and may contain bugs. Use at your own risk.

A small command-line tool Aztec sequencer operators run **once a week** to pay their delegators a share of the rewards they collected — at a commission rate the operator chooses, without redeploying any contracts.

**The problem it solves.** Provider commission rates in the Aztec staking protocol are baked into each delegation's coinbase split contract and **cannot be changed**. If your operating costs rise, you have no way to adjust the effective commission on delegations that already exist.

**The workaround.** Configure your sequencers to set the L2 `coinbase` to a wallet *you* control — a Safe (Gnosis) is a good fit if you want multisig control of the payout, but the tool works with any wallet: an EOA you sign from directly, a smart-account, a cold-wallet workflow, whatever. All your provider's rewards flow there. Each week, run this tool — it figures out which of your attesters earned what, computes per-delegator amounts at your chosen commission, and gives you ready-to-sign calldata that pays everyone.

**Two transaction shapes are available** (`--output-mode`):

- `safe` (default for `--emit-calldata`): N top-level `ERC20.transfer` calls, one per delegator. The Safe wraps them in MultiSend at submission, so `msg.sender == Safe` on every inner transfer. Works for Safes, smart-account wallets, and cold-wallet EOAs signing one by one. **Required for Safes.**
- `disperse` (default for live broadcast): an optional `ERC20.approve(Disperse, total)` plus a single `Disperse.disperseTokenSimple(token, recipients, amounts)` against `disperse.app`'s battle-tested batch contract (mainnet `0xD152f549545093347A162Dce210e7293f1452150`; override via `config.disperseAddress` on other chains). Fewer txs. Safe under a mempool race because Disperse calls `transferFrom(msg.sender, …)` internally — only the operator's own call can spend the operator's allowance to Disperse.

> **Do not batch via `Multicall3.aggregate3([token.transferFrom(operator, …)])`.** An earlier version of this tool did, and it was drained in the wild. Multicall3 lets any caller pick an arbitrary `from` for its inner calls, so an attacker seeing your `approve(Multicall3, X)` in the mempool can immediately call `Multicall3.aggregate3([token.transferFrom(you, attacker, X)])` and pull the full allowance before your own `aggregate3` lands. Never approve a router that lets the caller specify `from`.

The tool **doesn't hold any funds, doesn't deploy any contracts, and doesn't send anything by default** — it produces calldata that you (or your Safe) execute.

## What you need

- The rollup address you stake against.
- An archival RPC URL (historical `eth_call` against the rollup + event scans require archive support).
- Your provider id.
- The distribution wallet that receives your sequencers' coinbase rewards. Any wallet you control — Safe / multisig / smart-account / plain EOA all work.
- A commission rate (in basis points; you can change it between runs).

All of these go in a YAML config — see [config.example.yaml](./config.example.yaml).

## Quickstart

```bash
git clone <this repo>
cd aztec-staking-payout
npm install

# 1. Copy the example config and fill in your values.
cp config.example.yaml ./config.yaml
# Edit config.yaml — set rpcUrl, providerId, distributionWalletAddress,
# tokenAddress, stakingRegistryAddress, rollupAddress, commissionBps.

# 2. (Recommended) Run a dry-run first to sanity-check the discovered
#    delegators and the derived per-checkpoint reward:
npm run settle -- --config ./config.yaml \
  --from-epoch <previous run's to-epoch + 1> --dry-run
```

(`--to-epoch` defaults to `latest-proven`, the rollup's most recent fully-proven epoch at L1 finality.)

This prints the discovered delegators, the per-attester checkpoint counts for the window, and the full settlement plan — without sending anything. Re-run it as many times as you like.

## The weekly workflow

The intended cadence is **once a week**: pick the **epoch range** covering the past week, emit the calldata, then sign it through your Safe.

The settlement unit is the epoch, not the L1 block — an epoch lands as a single proof on L1, and that proof is the moment rewards become available. Settling whole epochs means **no epoch can ever fall between two runs**: there's no `--from-block` mid-epoch that would split a proof's rewards across settlements.

### Step 1 — emit the calldata

```bash
npm run settle -- \
  --config ./config.yaml \
  --from-epoch <last week's to-epoch + 1> \
  --emit-calldata
```

`--from-epoch` is the previous run's `--to-epoch + 1` — inclusive on both ends, no gap and no overlap. `--to-epoch` defaults to `latest-proven` (the rollup's most recent fully-proven epoch at L1 finality); pin a specific number for reproducible runs. `--emit-calldata` takes an optional path argument; omitted, it writes next to the audit JSON.

The tool runs through these phases (all read-only):

1. **Resolves** `[fromEpoch, toEpoch]` to an L1 block range by reading `getTimestampForEpoch()` and binary-searching L1 block timestamps + `getProvenCheckpointNumber()`. Errors out if `toEpoch` isn't yet proven on L1, or if its proof isn't yet in an L1-finalized block (no manual override — finality is the gate).
2. Reads the rollup's `getRewardConfig()` at the toBlock for the per-checkpoint sequencer reward (`checkpointReward × sequencerBps / 10000`).
3. Discovers your active delegators from on-chain (`StakedWithProvider` events filtered by your provider id, then `IGSE.isRegistered` to drop exits).
4. Scans `CheckpointProposed` events in the window and recovers each checkpoint's proposer attester from its `propose()` transaction's signature. **Hard-fails** if any checkpoint can't be resolved — a plan is only ever produced from 100% resolved data.
5. **Filters by coinbase.** Of the checkpoints proposed by the operator's attesters, only those whose `header.coinbase == distributionWalletAddress` are counted toward the reward. Mismatched coinbases are recorded in the audit trail but dropped from the count — their rewards routed elsewhere and aren't payable from the distribution wallet. This is the integrity gate against mid-window coinbase switches; pass `--ignore-coinbase` to disable it for testnet / what-if runs.
6. Computes the period's reward from the protocol formula: `countedCheckpoints × per-checkpoint sequencer reward`. Deterministic and reproducible — doesn't depend on whether the operator has claimed their rewards from the rollup yet.
7. Splits the reward in proportion to each delegator's attesters' proposal count (≥1 attester per recipient), applies your commission rate, and aggregates so each unique recipient gets one transfer.
8. Emits the planned transactions in the chosen `--output-mode` shape (`safe` or `disperse`; see the modes summary above).

> **Before executing the calldata**, the operator needs to claim accrued sequencer rewards from the rollup so the distribution wallet holds enough to fund the transfers: `rollup.claimSequencerRewards(distributionWallet)`. Live mode pre-flights the wallet's balance and errors clearly if it's short. Safe mode (`--emit-calldata`) trusts the operator to fund the wallet before importing the bundle.

### Step 2 — review and execute

Two files land in `./runs/`:

| File | What it is | Who reads it |
|---|---|---|
| `epoch-<from>-<to>-<runId>.json` | **The audit record.** Epoch + checkpoint + L1 block range, finalized block, the rollup's `getRewardConfig` snapshot, per-attester checkpoint counts, the full list of attributed checkpoints with tx hashes, the commission, the per-delegator transfer breakdown, **and the encoded calldata** (`to`, `value`, `data` per tx). Self-contained — cold-wallet signers can read the transactions directly from here. | **You** (review) + delegators / outside auditors (verify) + cold-wallet workflows. |
| `epoch-<from>-<to>-<runId>.safe.json` | Same transactions in Safe Transaction Builder import format. | The Safe UI (drag-and-drop). |

The console output is the human-readable summary — it prints the discovered delegators, per-attester checkpoint counts, the full settlement plan, and a final **NEXT STEPS** block listing options for whatever signer your distribution wallet uses:

```
NEXT STEPS
==========
  Pick whichever fits your distribution wallet:

  · Safe / Gnosis multisig → app.safe.global → Apps → Transaction Builder
        import ./runs/epoch-3025-3166-<runId>.safe.json
    (must use --output-mode safe — the default for --emit-calldata)

  · Other smart-account / multisig signers usually accept the same
    Safe Transaction Builder JSON — check your tool's import options.

  · Cold-wallet / scripted signer → read the encoded {to, value, data}
    from the audit JSON's `transactions` array and broadcast directly.
    Default shape is N separate transfers (safe mode); pass
    --output-mode disperse to get an approve + Disperse.disperseTokenSimple
    pair instead.

  · EOA you control → re-run with PRIVATE_KEY set and without
    --emit-calldata to sign and broadcast in one step. Defaults to
    --output-mode disperse (2 txs: approve Disperse + one call to
    Disperse.disperseTokenSimple with all N recipients). Pass
    --output-mode safe to send N individual transfers instead.
```

### Step 3 — keep the audit record

The `epoch-*.json` file is the canonical record of what happened. Push it to a public GitHub repo after every settle (see [Publish your runs/ for public audit](#publish-your-runs-for-public-audit-strongly-recommended) below) so delegators can verify your distributions without trusting your word for it.

## Publish your runs/ for public audit (strongly recommended)

The tool's trust model assumes operators are accountable to their delegators. We strongly recommend pushing the contents of `runs/` to a **public GitHub repo** after every settlement, so that delegators and any third party can verify your distributions without trusting your word for it. The audit JSON includes the `attributedCheckpoints` array — a row per checkpoint counted, with the L1 tx hash — so a delegator can spot-check any single row by fetching that tx and recovering the proposer signature themselves.

A minimal setup:

1. Create a public repo (e.g. `your-aztec-payout-audit`) with a short README naming your operator, provider id, and distribution wallet address.
2. After each weekly settle, commit the new files under `runs/`:
   - `epoch-<from>-<to>-<runId>.json` — audit record + encoded calldata. The canonical source of truth.
   - `epoch-<from>-<to>-<runId>.safe.json` — Safe Transaction Builder import. Deterministic from the audit; committing it makes "drop into Safe and verify" trivially possible for anyone.
3. Push.

What a delegator can then do, end-to-end, *without* trusting you:

1. Open the audit JSON. The `rewardConfig` snapshot + `checkpointsProposed` give the total reward (`checkpointsProposed × sequencerRewardPerCheckpoint`), and `transfers[]` is the per-delegator breakdown.
2. Jump to `attributedCheckpoints[]`, pick any row, and look up that `txHash` on a block explorer. The `propose()` calldata's signature recovers to that row's `attester` — confirming the operator actually proposed it.
3. Sum the proposals for each delegator, apply the operator's published commission, and compare to the `transfers[]` array. Numbers must match exactly.
4. Re-run this tool with the operator's published config and the same `--from-epoch`/`--to-epoch` (pin a number, not `latest-proven`). For a fixed epoch window it's deterministic, so they should get byte-identical numbers.

This turns operator margin from "trust me bro" into a verifiable artifact. There is no reason **not** to publish.

Suggested repo structure:

```
your-aztec-payout-audit/
├── README.md            (operator identity, links, signing addresses)
├── config.public.yaml   (optional: your config sans rpcUrl/secrets, for
│                          delegators who want to re-run independently)
└── runs/
    ├── epoch-100-106-<runId>.json    (audit — includes encoded calldata)
    ├── epoch-100-106-<runId>.safe.json
    ├── epoch-107-113-<runId>.json
    ├── epoch-107-113-<runId>.safe.json
    └── ...
```

> If you're an operator using this tool, you're encouraged to link your public audit repo here (via PR to the [aztec-staking-payout README](./README.md)) so delegators can find it. A short community-curated index lowers the bar for everyone.

## How accuracy is guaranteed

The tool **refuses to produce a plan from incomplete data**. Specifically:

- **Epoch-aligned windows.** Settlement is in epochs, not blocks. An epoch lands as a single proof on L1 — when the proof is submitted, *all* rewards for that epoch are credited at once. Aligning on epochs means no proof can be split between two runs.
- **Finalization gate.** A run **only ever considers epochs that are (a) proven on the rollup AND (b) in an L1-finalized block**. The resolver caps `--to-epoch` at the latest proven epoch and refuses any window whose proof block isn't yet L1-finalized. There's no opt-out — reorg safety is the default.
- **Protocol-derived reward.** The amount to distribute is computed from the rollup's `getRewardConfig` and the counted-checkpoint count: `countedCheckpoints × (checkpointReward × sequencerBps / 10000)`. The wallet's balance isn't consulted — so the result doesn't depend on whether the operator has claimed their rewards from the rollup yet, doesn't drift if random transfers hit the wallet, and is reproducible from on-chain data alone. (Known limitation: per-checkpoint variable transaction fees aren't included; the fixed `sequencerCheckpointReward` dominates.)
- **Coinbase integrity gate.** Of the checkpoints proposed by the operator's attesters, only those whose `header.coinbase == distributionWalletAddress` contribute to `countedCheckpoints`. Checkpoints routed elsewhere (a mid-window coinbase switch, a misconfigured sequencer, a builder/escrow address) are recorded in the audit trail with `counted: false` and dropped from the reward. This keeps the tool from promising delegators more than actually landed in the wallet. `--ignore-coinbase` disables the filter for testnet runs and pre-funded what-if scenarios.
- **Retry + rate limiting.** Every RPC call is retried with exponential backoff. A token-bucket rate limiter (`rpcMaxRequestsPerSecond` in config, default 100) keeps the call rate under your provider's cap so requests aren't silently dropped.
- **All-or-nothing proposer recovery.** If any single checkpoint can't be resolved to a proposer after retries, the run **stops with an error** — it won't hand you a skewed split. Re-run (or fix the RPC, lower the rate limit, etc.) and it'll be deterministic.
- **Deterministic by epoch.** For a fixed `[from-epoch, to-epoch]` window the result is **exact and reproducible** — two runs produce byte-identical plans. (`--to-epoch latest-proven` advances as epochs prove; pin a number for comparison.)
- The audit JSON records the rollup's reward config, the per-attester checkpoint counts, and the exact attestations, so a third party can re-verify the split independently.

## CLI reference

```
aztec-staking-payout <command> [options]

Commands:
  settle             Compute the period's per-delegator transfers.
  status             Print the distribution wallet balance, commission, and
                     discovered active delegators (read-only sanity check).
  help               Print the full help.

Options:
  --config <path>             Path to the YAML config. Defaults to
                              config.example.yaml.
  --from-epoch <n>            (settle) First L2 epoch in the settlement window
                              (inclusive). Required.
  --to-epoch <n|latest-proven>
                              (settle) Last L2 epoch in the window (inclusive).
                              Defaults to `latest-proven` — the rollup's most
                              recent fully-proven epoch at L1 finality.
  --dry-run                   (settle) Compute and print the plan, write the
                              audit record, don't send.
  --emit-calldata [<path>]    (settle) Don't broadcast — write a Safe
                              Transaction Builder import (.safe.json) for any
                              compatible signer (Safe, other multisigs, smart
                              accounts). Optional <path>; defaults to next to
                              the audit JSON. The encoded transactions also
                              land in the audit JSON, so cold-wallet signers
                              can read them straight from there.
  --output-mode <mode>        (settle) `safe` = N top-level ERC20.transfer
                              calls (one per delegator); the Safe bundles them
                              via MultiSend. `disperse` = optional
                              ERC20.approve(Disperse, total) +
                              Disperse.disperseTokenSimple(token, recipients,
                              amounts) against disperse.app's contract. Safe
                              under a mempool race because Disperse calls
                              transferFrom(msg.sender, …) internally — only
                              the operator's own call can spend their
                              allowance. Defaults: `safe` with
                              --emit-calldata, `disperse` for live broadcast.
                              An earlier `multicall` mode (approve Multicall3
                              + aggregate3 of transferFrom) was removed after
                              a live drain incident; do not reintroduce.
  --ignore-coinbase           (settle) Count every operator checkpoint in the
                              window regardless of `header.coinbase`. Default
                              counts only checkpoints whose coinbase matches
                              `distributionWalletAddress` — the integrity gate
                              against mid-window switches. Use for testnet /
                              what-if runs or when you've manually pre-funded
                              the distribution wallet to cover a prior-coinbase
                              period.
  --simulate-reward <amount>  (settle) Manual override of the reward amount.
                              The default is to compute the reward from the
                              protocol formula (checkpoint count × per-
                              checkpoint sequencer reward); this flag pins a
                              hypothetical amount instead. Forces dry-run.
                              Required for attributionMode=equal-split
                              (which has no proposal count to multiply by).

Environment:
  PRIVATE_KEY     Required only when sending live (i.e. distribution wallet is
                  an EOA, not a Safe; rare). Safes use --emit-calldata.
  RUNNER_CONFIG   Default config path if --config not given.
```

## Repository layout

```
.
├── README.md            this file
├── config.example.yaml  starter config (copy to ./config.yaml and edit)
├── package.json
├── tsconfig.json
├── src/                 runner source code
│   ├── cli.ts           CLI entry (settle / status / help)
│   ├── config.ts        YAML config loader (zod schema)
│   ├── discovery.ts     enumerate active delegators from chain
│   ├── proposals.ts     count checkpoints each attester proposed
│   ├── attribution.ts   proposal-weighted (or equal) split + commission
│   ├── epochs.ts        epoch-range → L1 block range resolver
│   ├── calldata.ts      planned-tx builder (safe / disperse modes) + Safe export
│   ├── settle.ts        orchestrator (the `settle` command)
│   ├── audit.ts         per-run audit record writer + plan pretty-printer
│   ├── client.ts        rate-limited viem PublicClient + RPC counter
│   ├── concurrency.ts   bounded concurrency, retry, token-bucket limiter
│   └── *.test.ts        vitest unit tests
├── runs/                per-run output (gitignored): audit JSON + Safe import
└── docs/
    ├── runner-reference.md   technical README (architecture, internals)
    ├── attribution.md        why proposals-weighted attribution is the model
    ├── math.md               the per-attester reward math
    └── trust-model.md        what an honest operator commits to + the
                              dishonest-operator failure modes
```

The design alternatives that were considered alongside this approach (an on-chain treasury contract, and a full replacement of the StakingRegistry) live in a separate folder, [`../operator-margin-design-options/`](../operator-margin-design-options/) — not part of this repo.

## Testing

```bash
npm test            # 47 unit tests, no network access required
npm run typecheck   # strict TypeScript
```

The tests use a mock viem transport so they exercise the real discovery / proposal-counting / attribution / calldata paths end-to-end without ever hitting an RPC. A failing test means something's actually broken; a passing test means the math is what it claims to be.

## Status

The tool is feature-complete for the weekly settlement workflow and has been verified against a live archival RPC. Open items:

- **Discovery caching across runs.** Each run currently rescans the full registry history (~140 `eth_getLogs` chunks + ~200 stake-tx receipts ≈ 340 RPC calls every time). Persisting that between runs would cut subsequent runs by ~330 calls. Useful if you settle on a tight schedule and care about RPC budget.
- **Per-checkpoint fee attribution.** Proposal-weighted attribution uses checkpoint *counts* — the fixed `sequencerCheckpointReward` dominates but variable tx fees per checkpoint aren't currently included. Parsing the epoch-proof calldata would give exact fee weighting.

See [docs/runner-reference.md](./docs/runner-reference.md) for the deeper technical writeup.
