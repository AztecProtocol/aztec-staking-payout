import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { formatUnits, type Address, type Hex } from "viem"
import type { SerializedPlannedTx } from "./calldata.js"
import type { AttributionMode, DistributionEntry, SettlementPlan } from "./types.js"

/**
 * One run's record — inputs, plan, outcome. Written to disk for local
 * diagnostics. Provides everything an auditor needs to reproduce the run
 * (block range, policy snapshot, per-delegator amounts, tx hash).
 */
export interface AuditRecord {
  runId: string
  startedAt: string
  finishedAt: string
  status: "dry-run" | "calldata-emitted" | "completed" | "failed"
  /** True when the operator pinned `--simulate-reward <amount>` — a
   *  hypothetical plan against a fabricated inflow, not a real settlement.
   *  Never present on a real run. */
  manualOverride?: boolean
  /** Sibling artifact written for Safe Transaction Builder import. Only
   *  present when `--emit-calldata` was used. */
  safeImportPath?: string

  // Inputs
  providerId: string
  distributionWallet: Address
  token: Address
  /** Settlement window's epoch range — the operator-facing unit. The L1 block
   *  fields below are derived from this. */
  fromEpoch: string
  toEpoch: string
  /** L2 checkpoint range covered by `[fromEpoch, toEpoch]`. Recorded for
   *  auditors who want to enumerate / spot-check every checkpoint. */
  fromCheckpoint: string
  toCheckpoint: string
  /** L1 block where the proof for `fromEpoch - 1` landed (so `balanceOf` at
   *  this block reflects "before any reward from `fromEpoch` had landed"). */
  fromBlock: string
  /** L1 block where the proof for `toEpoch` landed (so `balanceOf` here
   *  reflects "all rewards through `toEpoch` have landed"). */
  toBlock: string
  /** L1 finalized block at resolution time — confirms `toBlock` is finalised. */
  finalizedBlock: string

  /** Rollup's reward parameters at `toBlock` (recorded so an auditor can
   *  re-derive the per-checkpoint amount independently). `checkpointReward`
   *  and `sequencerRewardPerCheckpoint` are stringified bigints for
   *  precision; `sequencerBps` fits in a JS number. */
  rewardConfig: {
    checkpointReward: string
    sequencerBps: number
    sequencerRewardPerCheckpoint: string
  }
  /** Number of checkpoints this operator's attesters proposed in the window. */
  checkpointsProposed: number
  /** `checkpointsProposed × sequencerRewardPerCheckpoint` — what the
   *  operator earned from the rollup this period (and what gets divided
   *  among delegators per commission). */
  rewardEarned: string
  /** L1 gas spent on the propose() txs counted above — surfaced as a
   *  commission-tuning input, NOT subtracted from `rewardEarned`. Omitted
   *  on no-op runs. */
  gasCost?: {
    txCount: number
    totalGasUsed: string
    totalEthSpentWei: string
    weightedAvgGasPriceWei: string
  }

  commissionBps: number

  // How the delta was divided: "proposals" (weighted by checkpoints each
  // attester proposed) or "equal-split" (flat pool).
  attributionMode: AttributionMode

  // What got transferred
  delegatorCount: number
  transfers: AuditTransfer[]

  /** In `proposals` attribution mode: the full list of checkpoints attributed
   *  to this operator's attesters this period. Every entry corresponds to a
   *  +1 in some attester's proposal count. Delegators / outside auditors can
   *  spot-check the split by re-fetching each tx and recovering the proposer.
   *  Omitted in equal-split mode (no per-checkpoint attribution). */
  attributedCheckpoints?: AuditedCheckpoint[]

  /** The encoded on-chain transactions this settlement produces (one direct
   *  `ERC20.transfer` per recipient, executed by the distribution wallet).
   *  Self-contained — an auditor / cold-wallet signer can replay these
   *  without needing the separate Safe-import file. Omitted only when there
   *  was nothing to send (zero delegators, no rewards, or sub-dust amounts). */
  transactions?: SerializedPlannedTx[]

  txHashes: { multicall3?: Hex; transfers?: Hex[] }
  totals: { totalForwarded: string; operatorRetention: string }

  error?: string
}

export interface AuditTransfer {
  delegator: Address
  preRateShare: string
  amount: string
  /** Total proposals by this delegator's attesters in the window (proposals mode). */
  weight?: number
  /** Active attesters aggregated into this transfer. */
  attesters?: number
}

/**
 * One checkpoint attributed to one of this operator's attesters and counted
 * in the split. The full list lets a delegator or any third party replay the
 * attribution: for each entry, fetch the propose() tx, recover the signer to
 * confirm the attester, and decode `header.coinbase` to see where the reward
 * accrued.
 *
 * The `coinbase` field is recorded as-decoded — usually equal to the
 * configured `distributionWalletAddress`, but if any of the operator's
 * sequencers were set to route to a different coinbase (intermediate hot
 * wallet, multi-stage funding, or genuine misconfig), that shows up here.
 * The reward formula still counts these as earned (the rollup credited
 * *some* wallet the operator presumably controls); the console flags the
 * mismatch as a heads-up.
 */
export interface AuditedCheckpoint {
  /** L2 checkpoint number, as emitted by `CheckpointProposed`. */
  checkpointNumber: string
  /** L1 transaction hash of the `propose()` call that landed this checkpoint. */
  txHash: Hex
  /** L1 block the propose tx was mined in. */
  blockNumber: string
  /** Operator's attester that proposed this checkpoint. */
  attester: Address
  /** Delegator that gets credit for this checkpoint in the split. */
  delegator: Address
  /** `header.coinbase` of this checkpoint — the wallet the rollup credited
   *  via `sequencerRewards[…]` when the epoch's proof landed. Recorded so an
   *  auditor can spot-check by fetching the `propose()` tx and decoding the
   *  header; also makes any divergence from `distributionWalletAddress`
   *  visible to whoever's reading the audit. */
  coinbase: Address
}

export function summariseTransfersForAudit(entries: DistributionEntry[]): AuditTransfer[] {
  return entries.map((e) => ({
    delegator: e.delegator,
    preRateShare: e.preRateShare.toString(),
    amount: e.amount.toString(),
    ...(e.weight !== undefined ? { weight: e.weight } : {}),
    ...(e.attesters !== undefined ? { attesters: e.attesters } : {}),
  }))
}

export function writeAuditRecordToDisk(runsDir: string, record: AuditRecord): string {
  const absDir = resolve(process.cwd(), runsDir)
  mkdirSync(absDir, { recursive: true })
  // Filename keyed by epoch range so settlements naturally sort chronologically
  // and a glob like `runs/0-*` or `runs/*-100-*` is easy to reason about.
  const filename = `epoch-${record.fromEpoch}-${record.toEpoch}-${record.runId}.json`
  const path = join(absDir, filename)
  writeFileSync(path, JSON.stringify(record, null, 2))
  return path
}

export function newRunId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")
  return `${ts}-${rand}`
}

/** Pretty-printed plan for stdout in dry-run mode. Amounts are shown
 *  human-readable (token units) with the raw base-unit value in parens. */
export function formatPlanForHumans(plan: SettlementPlan): string {
  const sym = plan.tokenSymbol ? ` ${plan.tokenSymbol}` : ""
  // e.g. "168,168 STK"  — grouped, trimmed; raw value appended where useful.
  const human = (x: bigint): string => {
    const s = formatUnits(x, plan.tokenDecimals)
    const [whole, frac] = s.split(".")
    const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    return `${grouped}${frac ? `.${frac}` : ""}${sym}`
  }
  // Effective commission actually kept (retention as a % of reward earned),
  // which can exceed the configured rate slightly due to per-delegator
  // rounding (dust).
  const effPct =
    plan.rewardEarned > 0n
      ? (Number((plan.operatorRetention * 10000n) / plan.rewardEarned) / 100).toFixed(2)
      : "0.00"

  const lines: string[] = []
  lines.push(`SETTLEMENT PLAN`)
  lines.push(`===============`)
  lines.push(`Provider:              ${plan.providerId}`)
  lines.push(`Distribution wallet:   ${plan.distributionWallet}`)
  lines.push(`Token:                 ${plan.token}  (${plan.tokenSymbol || "?"}, ${plan.tokenDecimals} decimals)`)
  lines.push(`Epoch range:           [${plan.fromEpoch}, ${plan.toEpoch}]`)
  lines.push(`L1 block range:        [${plan.fromBlock}, ${plan.toBlock}]  (proof of epoch ${plan.fromEpoch - 1n} → proof of epoch ${plan.toEpoch})`)
  lines.push(`Per-checkpoint reward: ${human(plan.sequencerRewardPerCheckpoint)}  ` +
    `(checkpointReward=${plan.rewardConfig.checkpointReward} × sequencerBps=${plan.rewardConfig.sequencerBps} / 10000)`)
  lines.push(`Checkpoints by ours:   ${plan.checkpointsProposed}`)
  lines.push(`Reward earned:         ${human(plan.rewardEarned)}  (${plan.rewardEarned})`)
  if (plan.gasCost && plan.gasCost.txCount > 0) {
    // Format wei → human-readable ETH with 6 decimals (more than enough for
    // a weekly-scale settlement). Same for the gas-weighted avg price (→ gwei).
    const eth = formatWei(plan.gasCost.totalEthSpentWei, 18, 6)
    const gwei = formatWei(plan.gasCost.weightedAvgGasPriceWei, 9, 3)
    const gasGrouped = plan.gasCost.totalGasUsed.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    lines.push(`Gas spent (L1 propose): ${gasGrouped} gas across ${plan.gasCost.txCount} tx(s)`)
    lines.push(`ETH spent:             ${eth} ETH  (gas-weighted avg ${gwei} gwei/gas)`)
  }
  lines.push(`Commission rate:       ${(plan.commissionBps / 100).toFixed(2)}%`)
  lines.push(`Attribution:           ${plan.attributionMode}`)
  lines.push(``)
  lines.push(`Paid to delegators:    ${human(plan.totalForwarded)}  (${plan.totalForwarded})`)
  lines.push(`Operator commission:   ${human(plan.operatorRetention)}  (${plan.operatorRetention})  ≈ ${effPct}% of reward`)
  lines.push(``)
  const basis = plan.attributionMode === "proposals" ? "proposal-weighted" : "equal split"
  lines.push(`Per-delegator transfers (${plan.entries.length} unique recipients; ${basis}):`)
  for (const e of plan.entries) {
    const short = `${e.delegator.slice(0, 10)}…${e.delegator.slice(-8)}`
    const w = e.weight !== undefined ? `  proposals=${e.weight}` : ``
    const a = e.attesters !== undefined ? `  attesters=${e.attesters}` : ``
    lines.push(`  ${short}${a}${w}  →  ${human(e.amount)}  (${e.amount})`)
  }
  return lines.join("\n")
}

/**
 * Format a wei-denominated bigint as a fixed-decimal string with the given
 * number of fractional digits — used for ETH (18 decimals) and gwei (9
 * decimals) displays in the settlement plan. Avoids `formatUnits` from viem
 * here so we can pin the precision regardless of trailing zeros.
 */
function formatWei(wei: bigint, decimals: number, displayDecimals: number): string {
  if (wei === 0n) return `0.${"0".repeat(displayDecimals)}`
  const scale = 10n ** BigInt(decimals)
  const whole = wei / scale
  // Round half-up to `displayDecimals` precision by scaling, adding the half-
  // unit, then dividing.
  const fracScale = 10n ** BigInt(decimals - displayDecimals)
  const fracRaw = ((wei % scale) + fracScale / 2n) / fracScale
  // Carry if rounding bumped the fraction to the next whole unit.
  const carry = fracRaw / 10n ** BigInt(displayDecimals)
  const fracDisplay = fracRaw % 10n ** BigInt(displayDecimals)
  const wholeOut = whole + carry
  const fracStr = fracDisplay.toString().padStart(displayDecimals, "0")
  return `${wholeOut}.${fracStr}`
}
