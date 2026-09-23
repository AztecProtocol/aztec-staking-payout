# aztec-staking-payout — technical reference

The runner reconstructs each beneficiary's checkpoint earnings, subtracts the configured commission, and writes an auditable payout plan. It requires archival RPC access and a config file. Safe export produces one ERC20 transfer per recipient; it never signs or broadcasts.

## Quick start

```bash
npm install
npm test
npm run build
node dist/cli.js settle --config ./config.yaml --from-epoch 2851 --to-epoch 3113 --emit-calldata
```

Pin both epoch bounds when reproducing a run. `latest-proven` means the latest **complete** epoch proven in finalized L1 state. Continue from the previous verified run's `toEpoch + 1`. Old runs may have omitted an epoch tail, so audit their checkpoint bounds before relying on that continuation rule.

## Settlement and reconciliation

1. Resolve the epoch timestamps and checkpoint boundaries. A proof may cover only a prefix of an epoch: its final checkpoint must be proven, and the epoch must have ended. Verify adjacent checkpoint epochs and resolve the L1 proof blocks.
2. Read the fixed reward configuration at the closing proof block. Scan every checkpoint in the epoch interval and recover its proposer from the signed proposal calldata. Missing checkpoints or unresolved proposers stop the run.
3. Resolve all historical stakes under the provider, including exited validators. For each proposal, select the stake that existed at that block and log position. A later restake cannot rewrite an earlier reward recipient.
4. Count checkpoints whose coinbase is the distribution wallet. A wallet-bound checkpoint without a verified beneficiary stops the run. Checkpoints routed elsewhere are recorded but excluded.
5. For each counted checkpoint, read accumulated fees from the v5 proposal header and the fee state at its proposal block. Calculate:

   ```text
   fixed = checkpointReward × sequencerBps / 10000
   available = accumulatedFees − manaUsed × congestionCost
   sequencerFee = available − min(available, manaUsed × proverCost)
   checkpointEarnings = fixed + sequencerFee
   ```

6. Independently check the sum against the rollup accounting:

   ```text
   measured = getSequencerRewards(wallet, toBlock)
            − getSequencerRewards(wallet, fromBlock)
            + sequencer claims in (fromBlock, toBlock]
   measured == sum(checkpointEarnings)
   ```

   Claims reset the reward counter, so they must be added back. Claims are identified from token transfers from the rollup to the wallet and verified against transaction calldata. Direct claims, Safe `execTransaction`, MultiSend and Multicall3 wrappers are supported; unknown wrappers stop the run. Wallet balances and arbitrary incoming transfers are not used to measure earnings. A reward configuration change inside the window also stops the run.

7. Sum earnings by the beneficiary who earned each checkpoint. Apply commission **once per recipient**, rounding down in integer token base units. Fees are not pooled by checkpoint count. Dust below the configured threshold stays with the operator.
8. Before Safe export or live sending, check that the wallet has enough tokens. Write a version 2 audit record containing the reward reconciliation, split addresses, fixed rewards, fees, proposal hashes and encoded transfers.

A mismatch at any accuracy gate stops export and sending. The current accounting model requires v5 fee headers and a stable reward configuration. It deliberately stops on unsupported protocol data instead of estimating.

## Beneficiary verification

Scan `StakedWithProvider` events for `providerId`. For every historical stake, fetch its transaction receipt and match the split address to `SplitCreated`. The event must come from the configured registry's `PULL_SPLIT_FACTORY`, name the registry as creator, and have zero owner (immutable split). Exactly two recipients must exist; nonzero `recipients[1]` is the user's beneficiary.

Missing or failed receipt lookups stop the run after retries. **Never substitute the staking caller:** it may differ from the chosen rewards recipient.

Settlement does not filter by current GSE registration. Accepted historical proposals establish earned work, including work by validators that later exited. The separate `status` command still checks rollup and bonus-instance registration; failed multicall results are retried and then rejected, rather than interpreted as inactive.

## Simulation and output modes

- `--dry-run`: run the accounting checks, print the plan, write the audit, send nothing.
- `--emit-calldata [path]`: produce Safe Transaction Builder JSON, using direct token transfers. No private key is needed.
- Live mode: sign and send with `PRIVATE_KEY`; the signer must be the configured distribution wallet. EOA multicall mode uses approval plus `aggregate3(transferFrom)`.
- `--simulate-reward`: hypothetical amount; forces dry-run and suppresses Safe export. Equal-split and delegator overrides are simulation-only.
- `--ignore-coinbase`: allowed only together with `--simulate-reward`.

Do not execute a replacement for a batch already paid. The runner does not maintain an executed-payment ledger or automatically subtract historical payouts. Reconcile paid batches separately and issue only their differences.

## Reproducibility and implementation

Fixed epoch bounds and the same commission/dust policy produce the same recipient amounts. Run identifiers, timestamps and finalized snapshots differ. The audit records integer amounts; never compare floating-point totals.

- `epochs.ts`: complete epoch boundaries and finalized proof blocks.
- `discovery.ts`: historical stakes and verified immutable split recipients.
- `proposals.ts`: deduplicated checkpoint events, signature recovery and fee headers.
- `rewards.ts`: net fees, recipient earnings, claim classification and accounting gate.
- `attribution.ts`: hypothetical weighted/equal distributions.
- `calldata.ts`: token transfer encoding and Safe export.
- `settle.ts`: orchestration and export/send preconditions.
- `audit.ts`: serialized evidence and payout plan.

RPC requests use a configurable rate limit and retry backoff. Historical state reads require an archival endpoint even though signature recovery itself only needs transaction data. Discovery caching is not yet implemented.

## Config

See [config.example.yaml](../config.example.yaml). The file is flat (no nested objects) so key ordering carries meaning — top entries have sensible defaults, bottom entries are what the operator must set.

### Section 1 — Tunable defaults (rarely change)

| Field | Type | Default | Purpose |
|---|---|---|---|
| `multicallAddress` | address | `0xcA11bde05977b3631167028862bE2a173976CA11` | Multicall3 deployment. Same address on every major EVM chain; only override if your chain has it elsewhere. |
| `logChunkSize` | numeric string | `"10000"` | Max blocks per `eth_getLogs` call during discovery. Most public RPCs cap at 10k. |
| `dustThreshold` | numeric string | `"0"` | Skip transfers below this many token base units (after the rate is applied). |
| `runsDir` | path | `"./runs"` | Where to write audit records. |
| `stakingRegistryDeployedAtBlock` | numeric string | `"0"` | Bounds the event scan. Default `"0"` auto-detects the deployment block. |
| `delegatorsOverride` | address[] | *unset* | Simulation only: bypass discovery for a hypothetical equal split. |

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
- **Enforce the registry's provider allocation as the payout commission.** The runner verifies the immutable registry-created split and uses its user recipient. The off-chain payout commission is the operator's configured `commissionBps`.
- **Cron itself.** Operator schedules `settle` and advances `--from-epoch` to (the previous run's `--to-epoch + 1`).

## Tests

```bash
npm test
```

Covers complete and partial epochs, historical exits/restakes, recipient lookup failures, failed registration calls, fee attribution, commission rounding, counter resets and claims, accounting mismatches, proposal recovery, and transfer encoding. Tests use mocked RPC; live payout verification additionally compares the generated transfers with an independently reconstructed ledger.
