import type { Address, Hex } from "viem"

/**
 * A single planned on-chain transaction. Built once, then consumed by either
 * the live-send path or the calldata-emit path. A settlement is always one
 * Multicall3 transaction containing N inner ERC20.transfer calls.
 */
export interface PlannedTx {
  label: string
  to: Address
  value: bigint
  data: Hex
  function: string
  args: Record<string, unknown>
}

/** How the period's reward delta is divided among delegators. */
export type AttributionMode = "proposals" | "equal-split"

/**
 * One delegator's transfer for the period, after the operator's effective
 * rate has been applied.
 */
export interface DistributionEntry {
  delegator: Address
  /** Pre-rate allocation (for audit): the delegator's slice of the delta
   *  before commission — weighted by proposals, or equal across delegators. */
  preRateShare: bigint
  /** Post-rate amount actually transferred. */
  amount: bigint
  /** In "proposals" mode: total checkpoints this delegator's attesters
   *  proposed in the window (the weight that earned the share). Omitted in
   *  "equal-split" mode. */
  weight?: number
  /** How many of the operator's active attesters map to this delegator and
   *  were aggregated into this single transfer. */
  attesters?: number
}

/** Snapshot of the rollup's reward parameters at `toBlock`. Drives the
 *  per-checkpoint sequencer reward formula:
 *  `sequencerRewardPerCheckpoint = checkpointReward × sequencerBps / 10000`. */
export interface RewardConfigSnapshot {
  /** Raw `checkpointReward` from `getRewardConfig()` (uint96, in token base
   *  units per checkpoint — the full reward before the sequencer split). */
  checkpointReward: bigint
  /** Raw `sequencerBps` from `getRewardConfig()` — the basis-points share of
   *  `checkpointReward` that goes to the sequencer (proposer's coinbase). */
  sequencerBps: number
}

/** L1 gas the operator spent submitting `propose()` calls during the
 *  settlement period. Aggregated across every checkpoint attributed to one
 *  of the operator's attesters in the window. Useful as a commission-tuning
 *  signal: if gas cost is a meaningful fraction of the reward, the operator
 *  may want to bump their rate. */
export interface GasCost {
  /** Distinct propose() transactions counted. */
  txCount: number
  /** Sum of `gasUsed` across those receipts. */
  totalGasUsed: bigint
  /** Sum of `gasUsed × effectiveGasPrice` across those receipts (wei). */
  totalEthSpentWei: bigint
  /** Gas-weighted average price (= `totalEthSpentWei / totalGasUsed`, in
   *  wei/gas). Reflects what the operator actually paid per unit gas, not a
   *  simple mean of per-tx prices. */
  weightedAvgGasPriceWei: bigint
}

/** Plan rendered in dry-run mode + recorded in audit on a real run. */
export interface SettlementPlan {
  providerId: string
  distributionWallet: Address
  token: Address
  /** Reward-token decimals + symbol, for human-readable rendering. */
  tokenDecimals: number
  tokenSymbol: string
  /** Settlement window — primary unit. */
  fromEpoch: bigint
  toEpoch: bigint
  /** L1 blocks the epoch window resolved to (proof of `fromEpoch-1` and
   *  `toEpoch` respectively). Recorded for transparency / spot-checking. */
  fromBlock: bigint
  toBlock: bigint
  /** Reward params read from the rollup at `toBlock`. */
  rewardConfig: RewardConfigSnapshot
  /** Derived: `checkpointReward × sequencerBps / 10000`. */
  sequencerRewardPerCheckpoint: bigint
  /** Number of checkpoints this operator's attesters proposed in the epoch
   *  window. The reward formula's only variable input. */
  checkpointsProposed: number
  /** `checkpointsProposed × sequencerRewardPerCheckpoint`. The canonical
   *  amount to distribute this period (commission applies on top of this). */
  rewardEarned: bigint
  /** L1 gas the operator's sequencers spent on the propose() calls counted
   *  above. Recorded but not subtracted from the reward — operators bake
   *  their gas costs into `commissionBps` rather than netting them per-run.
   *  Omitted only on no-op runs (no proposals fetched). */
  gasCost?: GasCost
  commissionBps: number
  attributionMode: AttributionMode
  totalForwarded: bigint
  operatorRetention: bigint
  entries: DistributionEntry[]
}
