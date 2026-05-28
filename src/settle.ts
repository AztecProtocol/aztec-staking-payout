import {
  createWalletClient,
  formatUnits,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { RunnerConfig } from "./config.js"
import { makePublicClient } from "./client.js"
import { buildDistribution, buildWeightedDistribution, type WeightedDelegator } from "./attribution.js"
import { buildPlannedTxs, serializePlannedTxs, writeSafeImport } from "./calldata.js"
import { discoverActiveDelegators, findDeployBlock, type DiscoveredDelegator } from "./discovery.js"
import { countProposalsByProposer } from "./proposals.js"
import { computeGasSpent } from "./gascost.js"
import { resolveEpochRange, type EpochRange } from "./epochs.js"
import { createInlineProgress } from "./progress.js"
import type { AttributionMode } from "./types.js"
import {
  formatPlanForHumans,
  newRunId,
  summariseTransfersForAudit,
  writeAuditRecordToDisk,
  type AuditRecord,
} from "./audit.js"
import type { GasCost, PlannedTx, SettlementPlan } from "./types.js"

const ERC20_BALANCE_OF_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const

const ERC20_METADATA_ABI = [
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const


/** `getRewardConfig()` → the rollup's reward parameters. We read `sequencerBps`
 *  and `checkpointReward` to derive the per-checkpoint sequencer reward. */
const REWARD_CONFIG_ABI = [
  {
    name: "getRewardConfig",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "rewardDistributor", type: "address" },
          { name: "sequencerBps", type: "uint32" },
          { name: "booster", type: "address" },
          { name: "checkpointReward", type: "uint96" },
        ],
      },
    ],
  },
] as const

/** `IStaking.getGSE()` — used to derive the GSE address from the rollup. */
const ISTAKING_GET_GSE_ABI = [
  {
    name: "getGSE",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const

type RewardConfig = { sequencerBps: number; checkpointReward: bigint }

export interface SettleOptions {
  config: RunnerConfig
  privateKey: `0x${string}` | null
  /** Settlement window in **epochs** (inclusive). The resolver derives the L1
   *  block range and checkpoint range from these and enforces the proven /
   *  L1-finalized gates. */
  fromEpoch: bigint
  /** `null` means "latest proven epoch" — resolved against the rollup. */
  toEpoch: bigint | null
  dryRun: boolean
  /** True when `--emit-calldata` was used. Writes a Safe Transaction Builder
   *  import (`.safe.json`) alongside the audit; no broadcast. The audit JSON
   *  itself carries the encoded transactions, so no separate canonical
   *  bundle or human-readable summary is written. */
  emitSafeImport: boolean
  /** Explicit path for the `.safe.json` file. `null` means "sibling of the
   *  audit record" — i.e. `runs/epoch-<from>-<to>-<runId>.safe.json`. Only
   *  consulted when `emitSafeImport` is true. */
  safeImportPath: string | null
  /** Manual override of the reward amount. When non-null, the canonical
   *  protocol-derived amount (`oursProposed × per-checkpoint sequencer
   *  reward`) is ignored and this value is used instead. Forces dry-run as a
   *  safety: the operator wouldn't normally pay out a hypothetical amount.
   *  Useful for what-if sizing and as the *only* way to drive equal-split
   *  mode, which has no proposal count to multiply by. */
  simulateReward: bigint | null
}

export interface SettleResult {
  plan: SettlementPlan
  audit: AuditRecord
  auditPath: string
  /** Path of the Safe Transaction Builder import file, if `--emit-calldata`
   *  was used. The audit record itself carries the encoded calldata. */
  safeImportPath?: string
}

/**
 * Orchestration:
 *   1. Resolve `[fromEpoch, toEpoch]` to an L1-finalized block range and
 *      checkpoint range (gates: epoch proven + L1 block finalized).
 *   2. Read distribution wallet's token balance at the derived fromBlock and
 *      toBlock (requires archival RPC). Their delta = period's net inflow.
 *   3. Discover active delegators from on-chain (or use config override).
 *   4. Count checkpoints each attester proposed within the epoch range.
 *   5. Proposal-weighted split + commission; or equal-split (override path).
 *   6. Build a single Multicall3 batch of ERC20.transfer calls.
 *   7. Branch on output mode (dry-run / emit-calldata / live).
 *   8. Write audit record.
 */
export async function settle(opts: SettleOptions): Promise<SettleResult> {
  const { config, privateKey, fromEpoch, toEpoch, simulateReward } = opts
  // Mode determination is moved down to after the prelude (we need to read
  // the reward config first so we can announce the derived reward before
  // entering the manual-override branch). `willSend` etc. are set there.

  const { client: publicClient, meter } = makePublicClient(config)

  // ---- 1. Resolve the epoch range → L1 blocks + checkpoint range. This is
  //         the proven + finalized gate: it errors out if the requested
  //         toEpoch isn't proven on L1 (or proven but not yet finalized),
  //         leaving the run with nothing to do. The resolver issues ~hundreds
  //         of RPC calls (nested binary searches), so we surface live progress. ----
  console.log(
    `▸ Resolving epoch range [${fromEpoch}, ${toEpoch ?? "latest-proven"}] → L1 blocks…`,
  )
  const resolverProgress = createInlineProgress()
  let epochRange
  try {
    epochRange = await resolveEpochRange({
      client: publicClient,
      rollupAddress: config.rollupAddress,
      fromEpoch,
      toEpoch,
      // Trim binary searches by skipping pre-deploy L1 blocks if the operator
      // pinned the rollup deploy block in config. Falls back to 0 (search
      // from genesis) when omitted.
      rollupDeployedAtBlock: config.rollupDeployedAtBlock,
      retryMeter: meter,
      onProgress: resolverProgress.onProgress,
    })
  } finally {
    resolverProgress.done()
  }
  const { fromBlock, toBlock, fromCheckpoint, toCheckpoint } = epochRange
  console.log(
    `▸ Resolved: epochs [${epochRange.fromEpoch}, ${epochRange.toEpoch}]  ` +
      `checkpoints [${fromCheckpoint}, ${toCheckpoint}]  L1 blocks [${fromBlock}, ${toBlock}]`,
  )
  console.log(
    `▸ L1 finalized block: ${epochRange.finalizedBlock}  ` +
      `(latest proven epoch ${epochRange.latestProvenEpoch}, tip checkpoint ${epochRange.provenCheckpointTip})`,
  )
  if (config.rollupDeployedAtBlock === undefined || config.rollupDeployedAtBlock === 0n) {
    console.log(
      `▸ Rollup deploy block: ${epochRange.rollupDeployedAtBlock} (auto-detected). ` +
        `Pin this in config as \`rollupDeployedAtBlock\` to skip the ~25-RPC scan next run.`,
    )
  }
  if (toBlock <= fromBlock) {
    throw new Error(`Resolved toBlock (${toBlock}) must be > fromBlock (${fromBlock})`)
  }
  const reportRpc = () => {
    const primary = meter.count - meter.retries
    console.log(`▸ RPC requests sent: ${meter.count}  (${primary} primary + ${meter.retries} retries)`)
  }
  const account = privateKey ? privateKeyToAccount(privateKey) : null
  const walletClient: WalletClient | null = account
    ? createWalletClient({ account, transport: http(config.rpcUrl) })
    : null

  const commissionBps = config.commissionBps
  console.log(`▸ Commission: ${(commissionBps / 100).toFixed(2)}%`)

  // ---- 2. Initial reads — batched via Multicall3 at toBlock: token metadata,
  //         GSE address (for delegator discovery), and the rollup's reward
  //         config (for the per-checkpoint sequencer reward formula). Plus a
  //         single eth_chainId. No balance reads: the reward we distribute is
  //         derived from the protocol formula (oursProposed × per-checkpoint
  //         sequencer reward), not from the wallet's balance delta. ----
  console.log(`▸ Reading token metadata + GSE + reward config at L1 block ${toBlock}…`)
  const toContracts = [
    { address: config.tokenAddress, abi: ERC20_METADATA_ABI, functionName: "decimals" as const },
    { address: config.tokenAddress, abi: ERC20_METADATA_ABI, functionName: "symbol" as const },
    { address: config.rollupAddress, abi: ISTAKING_GET_GSE_ABI, functionName: "getGSE" as const },
    { address: config.rollupAddress, abi: REWARD_CONFIG_ABI, functionName: "getRewardConfig" as const },
  ]
  const [chainId, toResults] = await Promise.all([
    publicClient.getChainId(),
    publicClient.multicall({
      contracts: toContracts,
      allowFailure: true,
      multicallAddress: config.multicallAddress,
      blockNumber: toBlock,
    }),
  ])

  const required = <T>(r: { status: string; result?: unknown }, label: string): T => {
    if (r.status !== "success") throw new Error(`Initial read failed: ${label}`)
    return r.result as T
  }
  const decimals = Number(toResults[0]?.status === "success" ? toResults[0].result : 18)
  const symbol = String(toResults[1]?.status === "success" ? toResults[1].result : "")
  const gseAddress = required<Address>(toResults[2]!, "getGSE")
  const rewardConfig = required<RewardConfig>(toResults[3]!, "getRewardConfig @toBlock")
  const sequencerRewardPerCheckpoint =
    (rewardConfig.checkpointReward * BigInt(rewardConfig.sequencerBps)) / 10000n
  const token = { decimals, symbol }
  // Human-readable token amount, e.g. "168168 AZTEC (168168000000000000000000)".
  const fmt = (x: bigint) =>
    `${formatUnits(x, token.decimals)}${token.symbol ? ` ${token.symbol}` : ""} (${x})`

  console.log(
    `▸ Reward config @${toBlock}: checkpointReward=${fmt(rewardConfig.checkpointReward)}  ` +
      `sequencerBps=${rewardConfig.sequencerBps}  ` +
      `→ per-checkpoint sequencer reward = ${fmt(sequencerRewardPerCheckpoint)}`,
  )

  // Manual-override mode (testing): the operator pins a hypothetical reward
  // amount and forces dry-run. The plan goes through every step but never
  // sends or emits real calldata.
  const manualOverride = simulateReward !== null
  const dryRun = manualOverride ? true : opts.dryRun
  // Manual override forces dry-run, which means it suppresses both live
  // sending and Safe-import writing — the operator wouldn't normally hand a
  // Safe a hypothetical amount to execute.
  const emitSafeImport = manualOverride ? false : opts.emitSafeImport
  const safeImportPathOverride = manualOverride ? null : opts.safeImportPath
  const willSend = !dryRun && !emitSafeImport

  if (willSend && !privateKey) {
    throw new Error("settle(): privateKey is required when sending live transactions")
  }
  if (manualOverride) {
    console.log("")
    console.log(`╔══════════════════════════════════════════════════════════════════╗`)
    console.log(`║  MANUAL REWARD OVERRIDE — hypothetical, NOT a real settlement.     ║`)
    console.log(`╚══════════════════════════════════════════════════════════════════╝`)
  }

  // ---- 4. Discover delegators ----
  let discovered: DiscoveredDelegator[] = []
  let delegatorList: Address[]
  if (config.delegatorsOverride && config.delegatorsOverride.length > 0) {
    delegatorList = [...config.delegatorsOverride]
    console.log(`▸ Using ${delegatorList.length} delegators from config override`)
  } else {
    // Discovery scans from the StakingRegistry's deploy block (so it sees
    // every delegator, not just ones from this settlement window). Auto-
    // detect it if the operator didn't pin it in config.
    // A configured value of 0 (or omitted) means "auto-detect" — block 0 is
    // never a real deploy block for the registry, and scanning from genesis
    // is exactly what we're trying to avoid.
    let scanFrom: bigint
    if (config.stakingRegistryDeployedAtBlock !== undefined && config.stakingRegistryDeployedAtBlock > 0n) {
      scanFrom = config.stakingRegistryDeployedAtBlock
    } else {
      console.log(`▸ Auto-detecting StakingRegistry deploy block…`)
      scanFrom = await findDeployBlock(publicClient, config.stakingRegistryAddress, toBlock)
      console.log(`▸ StakingRegistry deployed at block ${scanFrom}`)
    }
    console.log(`▸ Discovering active delegators from StakingRegistry events…`)
    const progress = createInlineProgress()
    let result
    try {
      result = await discoverActiveDelegators({
        client: publicClient,
        stakingRegistryAddress: config.stakingRegistryAddress,
        rollupAddress: config.rollupAddress,
        multicallAddress: config.multicallAddress,
        providerId: BigInt(config.providerId),
        fromBlock: scanFrom,
        toBlock,
        logChunkSize: config.logChunkSize,
        stakeLogChunkSize: config.stakeLogChunkSize,
        gseAddress, // pre-fetched in the prelude multicall → skips a discovery RPC
        retryMeter: meter,
        onProgress: progress.onProgress,
      })
    } finally {
      progress.done()
    }
    discovered = result.delegators
    delegatorList = discovered.map((d) => d.delegator)
    console.log(
      `▸ Discovery: ${result.stats.stakeEventsFound} stake event(s) → ${result.stats.uniqueAttesters} attester(s) → ${result.stats.registeredOnRollup} active on rollup`,
    )
    for (const d of discovered) {
      console.log(`    · attester ${d.attester} → delegator ${d.delegator} (${d.delegatorSource})`)
    }
  }

  if (delegatorList.length === 0) {
    console.log("▸ No active delegators for this provider. Exiting.")
    reportRpc()
    return writeNoopAudit({
      config,
      epochRange,
      rewardConfig,
      sequencerRewardPerCheckpoint,
      rewardEarned: 0n,
      commissionBps,
      tokenDecimals: token.decimals,
      tokenSymbol: token.symbol,
      dryRun,
      emitSafeImport,
      delegatorCount: 0,
      manualOverride,
    })
  }

  // ---- 5. Distribution ----
  // "proposals" attribution needs the attester→delegator mapping that only
  // on-chain discovery produces. The delegator-override path doesn't have it,
  // so it always falls back to equal-split.
  const usingOverride = config.delegatorsOverride && config.delegatorsOverride.length > 0
  let attributionMode: AttributionMode = config.attributionMode
  if (attributionMode === "proposals" && usingOverride) {
    console.log(
      "▸ attributionMode=proposals is incompatible with delegatorsOverride " +
        "(no attester→proposer mapping) — falling back to equal-split.",
    )
    attributionMode = "equal-split"
  }

  // Equal-split mode has no per-attester proposal data, so it can't use the
  // protocol formula (which needs `oursProposed`). Require --simulate-reward
  // in that path; the operator must tell us how much to distribute.
  if (attributionMode === "equal-split" && !manualOverride) {
    throw new Error(
      `attributionMode=equal-split requires --simulate-reward <amount> to specify the total ` +
        `reward to divide. The protocol formula (oursProposed × per-checkpoint reward) needs ` +
        `the attester→proposer mapping which equal-split mode doesn't have. ` +
        `Either pin --simulate-reward, or use attributionMode=proposals (the default).`,
    )
  }

  // Unique recipients — transfers are aggregated per delegator, so this is the
  // count that matches the emitted transfers (a delegator may back many attesters).
  const uniqueDelegatorCount = new Set(delegatorList.map((d) => d.toLowerCase())).size

  // ---- Count checkpoints (always — needed for the protocol-formula reward
  //      and the per-checkpoint attribution trail in the audit). ----
  const needCounts = attributionMode === "proposals"
  let weighted: WeightedDelegator[] = []
  let oursProposed = 0
  let attributedCheckpoints: AuditRecord["attributedCheckpoints"]
  if (needCounts) {
    // The scan's *block* range is intentionally wider than [fromBlock, toBlock]:
    // proof submission lags proposals, so the proof for `fromEpoch - 1`
    // (which sets fromBlock) can land AFTER the first proposals of fromEpoch.
    // Without a margin we'd miss those. Margin = 10× logChunkSize ≈ a couple
    // weeks of L1 on a 12s chain, more than enough headroom for any
    // realistic `proofSubmissionEpochs`. The precise gate is the checkpoint
    // filter below; scanned-but-out-of-range proposals are surfaced via
    // counts.outOfRangeCheckpoints.
    const scanFrom = fromBlock > 10n * config.logChunkSize ? fromBlock - 10n * config.logChunkSize : 0n
    console.log(
      `▸ Counting checkpoints in epoch range [${epochRange.fromEpoch}, ${epochRange.toEpoch}] ` +
        `(checkpoints [${fromCheckpoint}, ${toCheckpoint}]; scanning L1 [${scanFrom}, ${toBlock}])…`,
    )
    const progress = createInlineProgress()
    let counts
    try {
      counts = await countProposalsByProposer({
        client: publicClient,
        rollupAddress: config.rollupAddress,
        multicallAddress: config.multicallAddress,
        fromBlock: scanFrom,
        toBlock,
        logChunkSize: config.logChunkSize,
        minCheckpointNumber: fromCheckpoint,
        maxCheckpointNumber: toCheckpoint,
        retryMeter: meter,
        onProgress: progress.onProgress,
      })
    } finally {
      progress.done()
    }

    // Walk the attributed-checkpoint trail once and keep every checkpoint
    // proposed by one of our attesters. The protocol formula counts what the
    // operator's attesters *earned* — rewards always accrue to whatever
    // `header.coinbase` was set per checkpoint. The operator is then
    // responsible for funding `distributionWalletAddress` (either by setting
    // `coinbase = distributionWalletAddress` directly, or by claiming from a
    // separate coinbase and transferring in).
    //
    // We still surface a warning when `header.coinbase != distributionWallet`
    // — that's a common-enough operational diagnostic (sequencer misconfig,
    // routing to the wrong wallet) that operators want to see it, even if
    // it doesn't change the reward calculation.
    const ourAttesters = new Map<string, { attester: Address; delegator: Address }>()
    for (const d of discovered) {
      ourAttesters.set(d.attester.toLowerCase(), { attester: d.attester, delegator: d.delegator })
    }
    const distWallet = config.distributionWalletAddress.toLowerCase()
    const ourPerAttester = new Map<string, number>()
    const offDistWalletPerAttester = new Map<string, { count: number; coinbases: Set<string> }>()
    attributedCheckpoints = []
    for (const c of counts.attributed) {
      const attesterKey = c.proposer.toLowerCase()
      const ours = ourAttesters.get(attesterKey)
      if (!ours) continue
      ourPerAttester.set(attesterKey, (ourPerAttester.get(attesterKey) ?? 0) + 1)
      attributedCheckpoints.push({
        checkpointNumber: c.checkpointNumber.toString(),
        txHash: c.txHash,
        blockNumber: c.blockNumber.toString(),
        attester: ours.attester,
        delegator: ours.delegator,
        coinbase: c.coinbase,
      })
      if (c.coinbase.toLowerCase() !== distWallet) {
        const m =
          offDistWalletPerAttester.get(attesterKey) ?? { count: 0, coinbases: new Set<string>() }
        m.count++
        m.coinbases.add(c.coinbase.toLowerCase())
        offDistWalletPerAttester.set(attesterKey, m)
      }
    }

    weighted = discovered.map((d) => ({
      delegator: d.delegator,
      weight: ourPerAttester.get(d.attester.toLowerCase()) ?? 0,
    }))
    oursProposed = weighted.reduce((acc, w) => acc + w.weight, 0)

    const extras: string[] = []
    if (counts.unresolvedCheckpoints > 0) extras.push(`⚠ ${counts.unresolvedCheckpoints} unresolved`)
    if (counts.outOfRangeCheckpoints > 0)
      extras.push(`${counts.outOfRangeCheckpoints} dropped (outside epoch range)`)
    if (counts.prunedAndReusedCheckpoints > 0)
      extras.push(`${counts.prunedAndReusedCheckpoints} pruned-and-reused (older event superseded)`)
    console.log(
      `▸ Checkpoints: ${counts.totalCheckpoints} in epoch range → ${oursProposed} by our attester(s)` +
        (extras.length > 0 ? `  (${extras.join("; ")})` : ``),
    )
    for (const d of discovered) {
      const n = ourPerAttester.get(d.attester.toLowerCase()) ?? 0
      console.log(`    · attester ${d.attester} → delegator ${d.delegator}: ${n} checkpoint(s)`)
    }
    if (offDistWalletPerAttester.size > 0) {
      let total = 0
      for (const { count } of offDistWalletPerAttester.values()) total += count
      console.log(
        `▸ ⓘ ${total} of those checkpoint(s) set header.coinbase to a wallet other than ` +
          `${config.distributionWalletAddress}. Rewards from those proposals accrued to that ` +
          `other wallet — fine if you fund the distribution wallet from there separately, ` +
          `worth investigating if you expected coinbase == distributionWalletAddress:`,
      )
      for (const [attesterKey, { count, coinbases }] of offDistWalletPerAttester) {
        const ours = ourAttesters.get(attesterKey)!
        const cbList = [...coinbases].join(", ")
        console.log(`    · attester ${ours.attester}: ${count} checkpoint(s) → coinbase ${cbList}`)
      }
    }

    // Accuracy gate: every checkpoint in the window must resolve to a proposer.
    // An unresolved checkpoint could be one of ours; counting it as nobody's
    // would under-pay a delegator and make the result depend on which RPC
    // calls happened to fail — so refuse to produce a plan from partial data.
    if (counts.unresolvedCheckpoints > 0) {
      throw new Error(
        `${counts.unresolvedCheckpoints} of ${counts.totalCheckpoints} checkpoints in epochs ` +
          `[${epochRange.fromEpoch}, ${epochRange.toEpoch}] could not be resolved to a proposer, ` +
          `so the split would be incomplete and non-deterministic. ` +
          `First cause: ${counts.firstUnresolvedError}. ` +
          `If this is rate-limiting, lower rpcMaxRequestsPerSecond in config; then re-run.`,
      )
    }
  }

  // ---- Fetch receipts for our propose() txs and sum gas spend. ----
  // One `eth_getTransactionReceipt` per tx (we've already fetched the txs
  // themselves for proposer/coinbase recovery; receipts are a separate RPC).
  // Scoped to the operator's proposals only — typically hundreds per week,
  // not thousands. Useful for the operator to see what they're actually
  // spending on L1 gas vs. what they're earning back from the rollup.
  let gasCost: GasCost | undefined
  if (attributedCheckpoints && attributedCheckpoints.length > 0) {
    console.log(
      `▸ Fetching receipts for ${attributedCheckpoints.length} propose() tx(s) to sum gas spend…`,
    )
    const result = await computeGasSpent({
      client: publicClient,
      txHashes: attributedCheckpoints.map((c) => c.txHash),
      retryMeter: meter,
    })
    gasCost = result
    const ethStr = formatEth(result.totalEthSpentWei)
    const gweiStr = formatGwei(result.weightedAvgGasPriceWei)
    const gasGrouped = result.totalGasUsed.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    console.log(
      `▸ Gas spent: ${gasGrouped} gas across ${result.txCount} tx(s)  →  ${ethStr} ETH ` +
        `(gas-weighted avg ${gweiStr} gwei/gas)`,
    )
  }

  // ---- Determine the reward to distribute ----
  //
  // Canonical source: the protocol formula. For each checkpoint a sequencer
  // proposes, the rollup credits `checkpointReward × sequencerBps / 10000`
  // tokens (read from `getRewardConfig` at toBlock). Total this period =
  // oursProposed × that per-checkpoint amount. Reproducible, claim-timing
  // independent, doesn't depend on the operator having actually claimed.
  //
  // Manual override (`--simulate-reward`): hypothetical amount, dry-run only.
  // Useful for what-if sizing or for equal-split mode (which has no proposal
  // count to multiply by).
  //
  // Known limitation: per-checkpoint variable transaction fees aren't
  // included in the formula. The fixed `sequencerCheckpointReward` dominates;
  // exact fee weighting would need parsing per-checkpoint `fees` from the
  // epoch-proof calldata.
  let rewardEarned: bigint
  if (manualOverride) {
    rewardEarned = simulateReward!
    console.log(`▸ Reward (manual override): ${fmt(rewardEarned)}`)
  } else {
    rewardEarned = BigInt(oursProposed) * sequencerRewardPerCheckpoint
    console.log(
      `▸ Reward earned: ${oursProposed} checkpoint(s) × ${fmt(sequencerRewardPerCheckpoint)}` +
        ` = ${fmt(rewardEarned)}`,
    )
  }

  if (rewardEarned === 0n) {
    if (attributionMode === "proposals") {
      console.log(
        `▸ None of this operator's ${discovered.length} active attester(s) proposed a ` +
          `checkpoint in epochs [${epochRange.fromEpoch}, ${epochRange.toEpoch}]. ` +
          `Nothing to distribute. Exiting.`,
      )
      console.log(
        `  Common causes: (a) genuinely no proposals — your attester(s) weren't selected ` +
          `as proposer in any slot this period; (b) discovery picked the wrong attester ` +
          `addresses — double-check the \`Active delegators\` list printed above against ` +
          `your sequencer config; (c) the epoch range is too narrow.`,
      )
    } else {
      console.log("▸ Override amount is 0 — nothing to distribute. Exiting.")
    }
    reportRpc()
    return writeNoopAudit({
      config,
      epochRange,
      rewardConfig,
      sequencerRewardPerCheckpoint,
      rewardEarned: 0n,
      commissionBps,
      tokenDecimals: token.decimals,
      tokenSymbol: token.symbol,
      dryRun,
      emitSafeImport,
      delegatorCount: uniqueDelegatorCount,
      manualOverride,
    })
  }

  const entries =
    attributionMode === "proposals"
      ? buildWeightedDistribution(weighted, rewardEarned, commissionBps, config.dustThreshold)
      : buildDistribution(delegatorList, rewardEarned, commissionBps, config.dustThreshold)

  const totalForwarded = entries.reduce((acc, e) => acc + e.amount, 0n)
  const operatorRetention = rewardEarned - totalForwarded

  const plan: SettlementPlan = {
    providerId: config.providerId,
    distributionWallet: config.distributionWalletAddress,
    token: config.tokenAddress,
    tokenDecimals: token.decimals,
    tokenSymbol: token.symbol,
    fromEpoch: epochRange.fromEpoch,
    toEpoch: epochRange.toEpoch,
    fromBlock,
    toBlock,
    rewardConfig,
    sequencerRewardPerCheckpoint,
    checkpointsProposed: oursProposed,
    rewardEarned,
    ...(gasCost ? { gasCost } : {}),
    commissionBps,
    attributionMode,
    totalForwarded,
    operatorRetention,
    entries,
  }

  if (entries.length === 0) {
    console.log("▸ All delegator amounts below dust threshold. Exiting.")
    reportRpc()
    return writeNoopAudit({
      config,
      epochRange,
      rewardConfig,
      sequencerRewardPerCheckpoint,
      rewardEarned,
      gasCost,
      commissionBps,
      tokenDecimals: token.decimals,
      tokenSymbol: token.symbol,
      dryRun,
      emitSafeImport,
      delegatorCount: uniqueDelegatorCount,
      manualOverride,
    })
  }

  // ---- 5. Calldata ----
  const plannedTxs = buildPlannedTxs({
    multicall3: config.multicallAddress,
    token: config.tokenAddress,
    entries,
  })

  // ---- 6. Render plan ----
  console.log("")
  console.log(formatPlanForHumans(plan))
  console.log("")
  // Surface the encoded `{to, value, data}` for each planned transaction. The
  // operator (or anyone else with the console output) can verify what's
  // actually getting signed without opening the audit JSON. The hex is long
  // for batches with many transfers, but it's exactly what hits the wire —
  // truncating it would defeat the point.
  console.log(`▸ Planned on-chain transactions: ${plannedTxs.length}`)
  plannedTxs.forEach((t, i) => {
    const prefix = plannedTxs.length > 1 ? `  [${i + 1}/${plannedTxs.length}] ` : "  "
    console.log("")
    console.log(`${prefix}${t.label}`)
    console.log(`    to:    ${t.to}`)
    console.log(`    value: ${t.value}`)
    console.log(`    data:  ${t.data}`)
  })
  console.log("")

  // ---- 7. Live pre-flight: signer matches the distribution wallet ----
  // Live mode signs locally with `PRIVATE_KEY`, so it requires the
  // distribution wallet to be a single-key EOA controlled by that key.
  // Multisigs / smart-account wallets need `--emit-calldata` so a separate
  // signer (Safe app, custom signing UI, hardware wallet, etc.) handles it.
  if (willSend) {
    if (account && account.address.toLowerCase() !== config.distributionWalletAddress.toLowerCase()) {
      throw new Error(
        `Signer ${account.address} is not the distribution wallet ${config.distributionWalletAddress}. ` +
          `If the wallet is a multisig or smart account, use --emit-calldata and sign through ` +
          `whatever tool controls it.`,
      )
    }
    // Live-mode pre-flight: ensure the wallet has enough to actually pay the
    // transfers. The amount comes from the protocol formula (not balance), so
    // this catches the case where the operator hasn't claimed their accrued
    // sequencer rewards yet — see `rollup.claimSequencerRewards(coinbase)`.
    const currentBalance = (await publicClient.readContract({
      address: config.tokenAddress,
      abi: ERC20_BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [config.distributionWalletAddress],
    })) as bigint
    if (currentBalance < totalForwarded) {
      throw new Error(
        `Distribution wallet's current balance (${currentBalance}) is less than totalForwarded ` +
          `(${totalForwarded}). The operator needs to claim accrued sequencer rewards from the ` +
          `rollup first (rollup.claimSequencerRewards(${config.distributionWalletAddress})) so ` +
          `the wallet holds enough to fund the distribution. Refusing to send.`,
      )
    }
  }

  // ---- 8. Branch on output mode ----
  const runId = newRunId()
  const startedAt = new Date().toISOString()
  const txHashes: AuditRecord["txHashes"] = {}
  const serializedTxs = serializePlannedTxs(plannedTxs)
  let safeImportPathOut: string | undefined

  if (emitSafeImport) {
    console.log(`▸ Mode: emit-calldata. Encoding ${plannedTxs.length} transactions, no chain sends.`)
    // Default the .safe.json next to the audit so the two files share a
    // base name and are easy to find together.
    const defaultPath = `${config.runsDir.replace(/\/$/, "")}/epoch-${epochRange.fromEpoch}-${epochRange.toEpoch}-${runId}.safe.json`
    const targetPath = safeImportPathOverride ?? defaultPath
    const written = writeSafeImport({
      path: targetPath,
      chainId,
      distributionWallet: config.distributionWalletAddress,
      fromEpoch: epochRange.fromEpoch,
      toEpoch: epochRange.toEpoch,
      fromBlock,
      toBlock,
      transactions: serializedTxs,
    })
    safeImportPathOut = written.safePath
    console.log(`▸ Wrote ${written.safePath}  (Safe Transaction Builder format)`)
    console.log("")
    console.log("NEXT STEPS")
    console.log("==========")
    console.log("  Pick whichever fits your distribution wallet:")
    console.log("")
    console.log("  · Safe / Gnosis multisig → app.safe.global → Apps → Transaction Builder")
    console.log(`        import ${written.safePath}`)
    console.log("")
    console.log("  · Other smart-account / multisig signers usually accept the same")
    console.log("    Safe Transaction Builder JSON — check your tool's import options.")
    console.log("")
    console.log("  · Cold-wallet / scripted signer → read the encoded {to, value, data}")
    console.log("    from the audit JSON's `transactions` array and broadcast directly.")
    console.log("")
    console.log("  · EOA you control → re-run with PRIVATE_KEY set and without")
    console.log("    --emit-calldata to sign and broadcast in one step.")
    console.log("")
  } else if (dryRun) {
    console.log(
      manualOverride
        ? "▸ Mode: manual reward override (dry-run). Hypothetical plan — nothing sent."
        : "▸ Mode: dry-run. Nothing sent.",
    )
  } else {
    if (!walletClient || !account) throw new Error("unreachable: live mode without signer")
    await executeLive({ plannedTxs, publicClient, walletClient, account, txHashes })
  }

  // ---- 9. Audit ----
  const status: AuditRecord["status"] = emitSafeImport
    ? "calldata-emitted"
    : dryRun
      ? "dry-run"
      : "completed"
  const audit: AuditRecord = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    status,
    providerId: config.providerId,
    distributionWallet: config.distributionWalletAddress,
    token: config.tokenAddress,
    // The encoded transactions land right after the identity block so anyone
    // opening this file to verify "what does this run actually do on chain"
    // sees the destination + calldata up front, before the long transfer
    // breakdown and per-checkpoint attribution trail. Self-contained:
    // cold-wallet signers / scripts can read straight from here without
    // needing the Safe-import sibling.
    transactions: serializedTxs,
    totals: {
      totalForwarded: totalForwarded.toString(),
      operatorRetention: operatorRetention.toString(),
    },
    fromEpoch: epochRange.fromEpoch.toString(),
    toEpoch: epochRange.toEpoch.toString(),
    fromCheckpoint: epochRange.fromCheckpoint.toString(),
    toCheckpoint: epochRange.toCheckpoint.toString(),
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    finalizedBlock: epochRange.finalizedBlock.toString(),
    rewardConfig: {
      checkpointReward: rewardConfig.checkpointReward.toString(),
      sequencerBps: rewardConfig.sequencerBps,
      sequencerRewardPerCheckpoint: sequencerRewardPerCheckpoint.toString(),
    },
    checkpointsProposed: oursProposed,
    rewardEarned: rewardEarned.toString(),
    ...(gasCost
      ? {
          gasCost: {
            txCount: gasCost.txCount,
            totalGasUsed: gasCost.totalGasUsed.toString(),
            totalEthSpentWei: gasCost.totalEthSpentWei.toString(),
            weightedAvgGasPriceWei: gasCost.weightedAvgGasPriceWei.toString(),
          },
        }
      : {}),
    commissionBps,
    attributionMode,
    delegatorCount: uniqueDelegatorCount,
    transfers: summariseTransfersForAudit(entries),
    ...(attributedCheckpoints ? { attributedCheckpoints } : {}),
    txHashes,
    ...(manualOverride ? { manualOverride: true } : {}),
    ...(safeImportPathOut ? { safeImportPath: safeImportPathOut } : {}),
  }
  const auditPath = writeAuditRecordToDisk(config.runsDir, audit)
  console.log(`▸ Audit record written: ${auditPath}`)
  reportRpc()

  return { plan, audit, auditPath, safeImportPath: safeImportPathOut }
}

interface ExecuteLiveInput {
  plannedTxs: PlannedTx[]
  publicClient: PublicClient
  walletClient: WalletClient
  account: ReturnType<typeof privateKeyToAccount>
  txHashes: AuditRecord["txHashes"]
}

async function executeLive(input: ExecuteLiveInput): Promise<void> {
  const { plannedTxs, publicClient, walletClient, account, txHashes } = input
  for (const ptx of plannedTxs) {
    console.log(`▸ Sending ${ptx.label} …`)
    const hash: Hex = await walletClient.sendTransaction({
      account,
      chain: null,
      to: ptx.to,
      value: ptx.value,
      data: ptx.data,
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== "success") throw new Error(`${ptx.label} reverted (tx ${hash})`)
    console.log(`  ✓ mined: ${hash}`)
    if (ptx.function === "aggregate3") txHashes.multicall3 = hash
  }
}

interface NoopAuditInput {
  config: RunnerConfig
  epochRange: EpochRange
  rewardConfig: RewardConfig
  sequencerRewardPerCheckpoint: bigint
  rewardEarned: bigint
  /** Only present when the noop happened *after* the proposal scan + receipt
   *  pass (i.e. the dust-threshold case). The two earlier exits (no
   *  delegators, zero proposals) reach this function before any tx receipts
   *  are fetched, so there's nothing to record. */
  gasCost?: GasCost
  commissionBps: number
  tokenDecimals: number
  tokenSymbol: string
  dryRun: boolean
  emitSafeImport: boolean
  delegatorCount: number
  manualOverride: boolean
}

function writeNoopAudit(input: NoopAuditInput): SettleResult {
  const status: AuditRecord["status"] = input.emitSafeImport
    ? "calldata-emitted"
    : input.dryRun
      ? "dry-run"
      : "completed"
  const { epochRange } = input
  const audit: AuditRecord = {
    runId: newRunId(),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status,
    providerId: input.config.providerId,
    distributionWallet: input.config.distributionWalletAddress,
    token: input.config.tokenAddress,
    fromEpoch: epochRange.fromEpoch.toString(),
    toEpoch: epochRange.toEpoch.toString(),
    fromCheckpoint: epochRange.fromCheckpoint.toString(),
    toCheckpoint: epochRange.toCheckpoint.toString(),
    fromBlock: epochRange.fromBlock.toString(),
    toBlock: epochRange.toBlock.toString(),
    finalizedBlock: epochRange.finalizedBlock.toString(),
    rewardConfig: {
      checkpointReward: input.rewardConfig.checkpointReward.toString(),
      sequencerBps: input.rewardConfig.sequencerBps,
      sequencerRewardPerCheckpoint: input.sequencerRewardPerCheckpoint.toString(),
    },
    checkpointsProposed: 0,
    rewardEarned: input.rewardEarned.toString(),
    ...(input.gasCost
      ? {
          gasCost: {
            txCount: input.gasCost.txCount,
            totalGasUsed: input.gasCost.totalGasUsed.toString(),
            totalEthSpentWei: input.gasCost.totalEthSpentWei.toString(),
            weightedAvgGasPriceWei: input.gasCost.weightedAvgGasPriceWei.toString(),
          },
        }
      : {}),
    commissionBps: input.commissionBps,
    attributionMode: input.config.attributionMode,
    delegatorCount: input.delegatorCount,
    transfers: [],
    txHashes: {},
    totals: { totalForwarded: "0", operatorRetention: input.rewardEarned.toString() },
    ...(input.manualOverride ? { manualOverride: true } : {}),
  }
  const auditPath = writeAuditRecordToDisk(input.config.runsDir, audit)
  const plan: SettlementPlan = {
    providerId: input.config.providerId,
    distributionWallet: input.config.distributionWalletAddress,
    token: input.config.tokenAddress,
    tokenDecimals: input.tokenDecimals,
    tokenSymbol: input.tokenSymbol,
    fromBlock: epochRange.fromBlock,
    toBlock: epochRange.toBlock,
    fromEpoch: epochRange.fromEpoch,
    toEpoch: epochRange.toEpoch,
    rewardConfig: input.rewardConfig,
    sequencerRewardPerCheckpoint: input.sequencerRewardPerCheckpoint,
    checkpointsProposed: 0,
    rewardEarned: input.rewardEarned,
    ...(input.gasCost ? { gasCost: input.gasCost } : {}),
    commissionBps: input.commissionBps,
    attributionMode: input.config.attributionMode,
    totalForwarded: 0n,
    operatorRetention: input.rewardEarned,
    entries: [],
  }
  return { plan, audit, auditPath }
}

/** Format a wei amount as ETH with 6 fractional digits (e.g. "0.012345"). */
function formatEth(wei: bigint): string {
  return formatFixedDecimals(wei, 18, 6)
}

/** Format a wei amount as gwei with 3 fractional digits (e.g. "12.345"). */
function formatGwei(wei: bigint): string {
  return formatFixedDecimals(wei, 9, 3)
}

/** Fixed-precision wei→decimal renderer; rounds half-up to `displayDecimals`. */
function formatFixedDecimals(wei: bigint, decimals: number, displayDecimals: number): string {
  if (wei === 0n) return `0.${"0".repeat(displayDecimals)}`
  const scale = 10n ** BigInt(decimals)
  const whole = wei / scale
  const fracScale = 10n ** BigInt(decimals - displayDecimals)
  const fracRaw = ((wei % scale) + fracScale / 2n) / fracScale
  const carry = fracRaw / 10n ** BigInt(displayDecimals)
  const fracDisplay = fracRaw % 10n ** BigInt(displayDecimals)
  const fracStr = fracDisplay.toString().padStart(displayDecimals, "0")
  return `${whole + carry}.${fracStr}`
}
