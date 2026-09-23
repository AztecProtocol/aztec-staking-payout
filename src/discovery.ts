import {
  decodeEventLog,
  encodeEventTopics,
  getAddress,
  keccak256,
  parseAbiItem,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import { mapWithConcurrency, withRetry } from "./concurrency.js"

/**
 * `GSE.BONUS_INSTANCE_ADDRESS` is the public constant
 *   `address(uint160(uint256(keccak256("bonus-instance"))))`
 * — same for every GSE deployment. Computed locally so we don't have to spend
 * an RPC call (`getBonusInstanceAddress()`) every run.
 */
export const BONUS_INSTANCE_ADDRESS = getAddress(
  `0x${keccak256(toHex("bonus-instance")).slice(-40)}`,
) as Address

/**
 * Binary-search for the block at which `address` first had bytecode — i.e.
 * its deployment block. `eth_getCode` returns empty before deployment and
 * the bytecode after, monotonically (a staking registry won't selfdestruct),
 * so a binary search pins the exact block in ~log2(head) calls (≈25 for a
 * 25M-block chain). Lets the runner avoid scanning from genesis without the
 * operator having to look the deploy block up by hand.
 */
export async function findDeployBlock(
  client: PublicClient,
  address: Address,
  head: bigint,
): Promise<bigint> {
  const hasCode = async (block: bigint): Promise<boolean> => {
    const code = await client.getCode({ address, blockNumber: block })
    return code !== undefined && code !== "0x"
  }

  if (!(await hasCode(head))) {
    throw new Error(
      `No contract code at ${address} as of block ${head} — check the address in config.`,
    )
  }

  let lo = 0n
  let hi = head
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    if (await hasCode(mid)) {
      hi = mid
    } else {
      lo = mid + 1n
    }
  }
  return lo
}

/**
 * `StakedWithProvider` event emitted by the ignition-contracts StakingRegistry.
 *
 *   event StakedWithProvider(
 *     uint256 indexed providerIdentifier,
 *     address indexed rollupAddress,
 *     address indexed attester,
 *     address coinbaseSplitContractAddress,
 *     address stakerImplementation
 *   );
 *
 * `stakerImplementation` is the msg.sender that called `stake()`, retained
 * as provenance only; it is not a substitute for the rewards recipient.
 */
export const STAKED_WITH_PROVIDER_EVENT = parseAbiItem(
  "event StakedWithProvider(uint256 indexed providerIdentifier, address indexed rollupAddress, address indexed attester, address coinbaseSplitContractAddress, address stakerImplementation)",
)

/**
 * `SplitCreated` event emitted by 0xSplits' `PullSplitFactory.createSplit`.
 * Same tx as `StakedWithProvider` (StakingRegistry.stake calls
 * PULL_SPLIT_FACTORY.createSplit synchronously). We scan these to recover
 * the actual `_userRewardsRecipient` the staker passed — which is
 * `splitParams.recipients[1]` (recipients[0] is the operator's
 * providerRewardsRecipient, see StakingRegistry.stake).
 *
 * Note: PullSplitFactory has TWO overloaded `SplitCreated` events (one
 * with `bytes32 salt` for createSplitDeterministic, one with `uint256
 * nonce` for createSplit). StakingRegistry uses the non-deterministic
 * variant — we filter for the nonce-flavour topic0 implicitly via the
 * ABI we hand to viem.
 */
export const SPLIT_CREATED_EVENT = parseAbiItem(
  "event SplitCreated(address indexed split, (address[] recipients, uint256[] allocations, uint256 totalAllocation, uint16 distributionIncentive) splitParams, address owner, address creator, uint256 nonce)",
)

/**
 * IStaking.getGSE() — derive GSE from the rollup so the operator doesn't
 * need to configure it separately.
 */
const ISTAKING_GET_GSE_ABI = [
  {
    name: "getGSE",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const

const IGSE_IS_REGISTERED_ABI = [
  {
    name: "isRegistered",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "_instance", type: "address" },
      { name: "_attester", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const

/**
 * IGSE.getBonusInstanceAddress() — the magic instance under which attesters
 * that deposited with `moveWithLatestRollup = true` are registered. An
 * attester is "active for the rollup" if it's registered under EITHER the
 * rollup instance (moveWithLatestRollup=false) OR this bonus instance
 * (=true), so the runner must check both.
 */
const IGSE_BONUS_INSTANCE_ABI = [
  {
    name: "getBonusInstanceAddress",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const

/**
 * Structured progress events emitted during discovery. The discovery module
 * stays render-agnostic; callers decide how to display these (e.g. an
 * inline-updating terminal line — see progress.ts).
 */
export type DiscoveryProgress =
  | { phase: "scanning-stakes"; fromBlock: bigint; toBlock: bigint; scannedTo: bigint; eventsFound: number }
  | { phase: "resolving-splits"; resolved: number; total: number; matched: number }
  | { phase: "checking-attesters"; checked: number; total: number }

export interface DiscoveryInput {
  client: PublicClient
  stakingRegistryAddress: Address
  rollupAddress: Address
  /** Multicall3 deployment — the per-attester isRegistered checks are
   *  batched through it. */
  multicallAddress: Address
  providerId: bigint
  fromBlock: bigint
  toBlock: bigint
  logChunkSize: bigint
  /** Block range per stake-event `eth_getLogs` call. The query is filtered by
   *  `providerId` (indexed) so it's sparse and safe to use a much larger range
   *  than `logChunkSize`. Defaults to `logChunkSize` if omitted. */
  stakeLogChunkSize?: bigint
  /** Pre-fetched GSE address (`rollup.getGSE()`). If the caller already read
   *  it (e.g. inside a Multicall3 batch with balances/decimals), pass it here
   *  to skip an extra RPC call here. Otherwise discovery fetches it. */
  gseAddress?: Address
  /** Status-only registration probes, unioned across these blocks.
   * Defaults to [toBlock]. Settlement sets includeInactive and bypasses
   * registration filtering: endpoint probes cannot prove activity throughout
   * an epoch window or replace attribution of accepted historical proposals. */
  activityCheckBlocks?: bigint[]
  /** Optional retry counter — incremented per scheduled retry, so the caller
   *  can report primary vs retried RPC counts. */
  retryMeter?: { retries: number }
  /** Optional progress callback. Called frequently (per log chunk, per
   *  attester-check batch). Cheap renderers only. */
  onProgress?: (p: DiscoveryProgress) => void
  /** Settlement uses all historical stakes, including validators that exited. */
  includeInactive?: boolean
}

export interface DiscoveredDelegator {
  attester: Address
  /** Verified recipients[1] of the immutable registry-created split. */
  delegator: Address
  /** Where the delegator address came from. */
  delegatorSource: "split-recipient"
  splitAddress: Address
  /** The staker (msg.sender of stake()) — kept for the audit trail. */
  staker: Address
  stakedAtBlock: bigint
  stakedAtLogIndex?: number
}

/**
 * Funnel counts so a caller can see exactly where a discovery run drops to
 * zero — distinguishing "no stake events at all" (wrong providerId /
 * stakingRegistryAddress / block range) from "stakes found but none active
 * on this rollup" (wrong rollupAddress).
 */
export interface DiscoveryStats {
  stakeEventsFound: number
  uniqueAttesters: number
  registeredOnRollup: number
  /** Status-only: candidates unregistered at all requested probe blocks.
   * Historical settlement does not classify candidates as phantoms. */
  phantomAttesters: Address[]
}

export interface DiscoveryResult {
  delegators: DiscoveredDelegator[]
  stats: DiscoveryStats
}

/**
 * Enumerate the operator's stakers from on-chain:
 *
 *   1. Scan `StakedWithProvider` events filtered by `providerId`, chunked
 *      across the block range.
 *   2. For each stake, pull the `SplitCreated` log from the *same transaction*
 *      (the StakingRegistry creates the split in the stake() call) and decode
 *      `splitParams.recipients[1]`, verifying the factory, creator and owner.
 *   3. Status mode checks current GSE registration; settlement retains every
 *      historical stake and selects the applicable stake at each proposal.
 *   4. Return verified (attester, delegator, …) records; missing data aborts.
 */
export async function discoverActiveDelegators(
  input: DiscoveryInput,
): Promise<DiscoveryResult> {
  const {
    client,
    stakingRegistryAddress,
    rollupAddress,
    multicallAddress,
    providerId,
    fromBlock,
    toBlock,
    logChunkSize,
    onProgress,
  } = input
  const retryMeter = input.retryMeter

  // Scan provider history across rollups. Settlement scopes earnings by
  // accepted proposals and their coinbase; status checks registration below.
  const stakeEvents = await scanStakeEvents({
    client,
    stakingRegistryAddress,
    providerId,
    fromBlock,
    toBlock,
    // Filtered query: safe to use the wider stakeLogChunkSize (defaults to
    // logChunkSize for back-compat).
    logChunkSize: input.stakeLogChunkSize ?? logChunkSize,
    retryMeter,
    onProgress,
  })

  // Dedupe per attester (last-write wins on re-stake)
  const byAttester = new Map<string, StakeRow>()
  for (const ev of stakeEvents) {
    byAttester.set(ev.attester.toLowerCase(), ev)
  }
  const candidates = input.includeInactive ? stakeEvents : [...byAttester.values()]
  const stats: DiscoveryStats = {
    stakeEventsFound: stakeEvents.length,
    uniqueAttesters: byAttester.size,
    registeredOnRollup: 0,
    phantomAttesters: [],
  }
  if (candidates.length === 0) return { delegators: [], stats }

  // Step 2: resolve each split's userRewardsRecipient from the SplitCreated
  // log in the same transaction as the stake. Receipt fetches are bounded by
  // our stake count — no second full-range event scan.
  const splitRecipients = await resolveSplitRecipientsFromReceipts({
    client,
    candidates,
    stakingRegistryAddress,
    toBlock,
    retryMeter,
    onProgress,
  })

  // Step 3: resolve the GSE address (one read; can be skipped by the caller
  // pre-fetching it). The bonus-instance address is a contract-side constant
  // computed locally (`keccak256("bonus-instance")`), so no RPC needed.
  const activeByAttester = new Map<string, boolean>()
  if (!input.includeInactive) {
    const gseAddress =
      input.gseAddress ??
      ((await client.readContract({
        address: rollupAddress,
        abi: ISTAKING_GET_GSE_ABI,
        functionName: "getGSE",
        blockNumber: toBlock,
      })) as Address)
    const bonusInstance = BONUS_INSTANCE_ADDRESS

    // Step 4: batch the isRegistered checks via Multicall3. Each attester gets
    // two reads — under the rollup instance (moveWithLatestRollup=false) and
    // under the bonus instance (=true) — and counts as active if EITHER is
    // true. Chunked so we can show progress and bound multicall size.
    const ATTESTERS_PER_BATCH = 25
    const activityCheckBlocks = input.activityCheckBlocks ?? [toBlock]
    for (const blockNumber of activityCheckBlocks) {
      for (let i = 0; i < candidates.length; i += ATTESTERS_PER_BATCH) {
        const batch = candidates.slice(i, i + ATTESTERS_PER_BATCH)
        const contracts = batch.flatMap((c) => [
          {
            address: gseAddress,
            abi: IGSE_IS_REGISTERED_ABI,
            functionName: "isRegistered" as const,
            args: [rollupAddress, c.attester] as const,
          },
          {
            address: gseAddress,
            abi: IGSE_IS_REGISTERED_ABI,
            functionName: "isRegistered" as const,
            args: [bonusInstance, c.attester] as const,
          },
        ])
        const results = await withRetry(async () => {
          const values = await client.multicall({
            contracts, allowFailure: true, multicallAddress, blockNumber,
          })
          if (values.length !== contracts.length || values.some((r) => r.status !== "success")) {
            throw new Error("Registration checks failed; refusing to classify unknown validators as inactive")
          }
          return values
        }, undefined, undefined, retryMeter)
        for (let j = 0; j < batch.length; j++) {
          const onRollup = results[2 * j]
          const onBonus = results[2 * j + 1]
          const isActive =
            (onRollup?.status === "success" && onRollup.result === true) ||
            (onBonus?.status === "success" && onBonus.result === true)
          if (isActive) activeByAttester.set(batch[j]!.attester.toLowerCase(), true)
        }
        onProgress?.({
          phase: "checking-attesters",
          checked: Math.min(i + batch.length, candidates.length),
          total: candidates.length,
        })
      }
    }
  }

  // Historical settlement candidates are filtered by their accepted proposals, not current registration.
  const active: DiscoveredDelegator[] = []
  const phantomAttesters: Address[] = []
  for (const c of candidates) {
    if (!input.includeInactive && !activeByAttester.get(c.attester.toLowerCase())) {
      phantomAttesters.push(c.attester)
      continue
    }

    const mapped = splitRecipients.get(c.splitAddress.toLowerCase())
    if (!mapped) throw new Error(`Unresolved rewards recipient for split ${c.splitAddress}; refusing to pay the staking caller`)
    const delegator = mapped
    const delegatorSource = "split-recipient" as const

    active.push({
      attester: c.attester,
      delegator,
      delegatorSource,
      splitAddress: c.splitAddress,
      staker: c.stakerImplementation,
      stakedAtBlock: c.stakedAtBlock,
      stakedAtLogIndex: c.stakedAtLogIndex,
    })
  }

  active.sort((a, b) =>
    a.stakedAtBlock === b.stakedAtBlock ? 0 : a.stakedAtBlock < b.stakedAtBlock ? -1 : 1,
  )
  stats.registeredOnRollup = input.includeInactive ? 0 : active.length
  stats.phantomAttesters = phantomAttesters
  return { delegators: active, stats }
}

/**
 * Diagnostic: scan `StakedWithProvider` events over a range WITHOUT the
 * providerId filter, and report how many were seen plus the distinct
 * provider IDs present. Lets a caller tell apart:
 *   - "wrong providerId"      → totalEvents > 0, your id not in providerIds
 *   - "wrong address / event" → totalEvents == 0 (or none in range)
 *
 * Cheap: same chunked scan, just no indexed-arg filter.
 */
export async function probeProviderIds(input: {
  client: PublicClient
  stakingRegistryAddress: Address
  fromBlock: bigint
  toBlock: bigint
  logChunkSize: bigint
}): Promise<{ totalEvents: number; providerIds: bigint[] }> {
  const { client, stakingRegistryAddress, fromBlock, toBlock, logChunkSize } = input
  const seen = new Set<bigint>()
  let total = 0
  let cursor = fromBlock
  while (cursor <= toBlock) {
    const chunkEnd = cursor + logChunkSize - 1n < toBlock ? cursor + logChunkSize - 1n : toBlock
    const logs = await client.getLogs({
      address: stakingRegistryAddress,
      event: STAKED_WITH_PROVIDER_EVENT,
      fromBlock: cursor,
      toBlock: chunkEnd,
    })
    for (const log of logs) {
      total++
      const decoded = decodeEventLog({ abi: [STAKED_WITH_PROVIDER_EVENT], data: log.data, topics: log.topics })
      const args = decoded.args as { providerIdentifier: bigint }
      seen.add(args.providerIdentifier)
    }
    cursor = chunkEnd + 1n
  }
  return { totalEvents: total, providerIds: [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) }
}

// -----------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------

interface StakeRow {
  stakedAtLogIndex: number
  attester: Address
  splitAddress: Address
  stakerImplementation: Address
  stakedAtBlock: bigint
  /** Tx that emitted this stake — also contains the SplitCreated log. */
  txHash: Hex
}

interface ScanStakeEventsInput {
  client: PublicClient
  stakingRegistryAddress: Address
  providerId: bigint
  fromBlock: bigint
  toBlock: bigint
  logChunkSize: bigint
  retryMeter?: { retries: number }
  onProgress?: (p: DiscoveryProgress) => void
}

/** Block-range chunks fetched concurrently during a log scan. */
const LOG_SCAN_CONCURRENCY = 25

async function scanStakeEvents(input: ScanStakeEventsInput): Promise<StakeRow[]> {
  const { client, stakingRegistryAddress, providerId, fromBlock, toBlock, logChunkSize, retryMeter, onProgress } =
    input

  // Precompute chunk ranges, then fetch them concurrently. Results are kept in
  // range order so the later last-write-wins dedupe still sees the latest stake.
  const ranges: [bigint, bigint][] = []
  for (let cursor = fromBlock; cursor <= toBlock; ) {
    const chunkEnd = cursor + logChunkSize - 1n < toBlock ? cursor + logChunkSize - 1n : toBlock
    ranges.push([cursor, chunkEnd])
    cursor = chunkEnd + 1n
  }

  let scannedTo = fromBlock
  let found = 0
  const perRange = await mapWithConcurrency(ranges, LOG_SCAN_CONCURRENCY, async ([from, to]) => {
    const logs = await withRetry(
      () =>
        client.getLogs({
          address: stakingRegistryAddress,
          event: STAKED_WITH_PROVIDER_EVENT,
          args: { providerIdentifier: providerId },
          fromBlock: from,
          toBlock: to,
        }),
      undefined,
      undefined,
      retryMeter,
    )
    const rows = logs.map((log) => {
      const decoded = decodeEventLog({ abi: [STAKED_WITH_PROVIDER_EVENT], data: log.data, topics: log.topics })
      const args = decoded.args as {
        attester: Address
        coinbaseSplitContractAddress: Address
        stakerImplementation: Address
      }
      return {
        attester: getAddress(args.attester) as Address,
        splitAddress: getAddress(args.coinbaseSplitContractAddress) as Address,
        stakerImplementation: getAddress(args.stakerImplementation) as Address,
        stakedAtLogIndex: log.logIndex ?? 0,
        stakedAtBlock: log.blockNumber ?? 0n,
        txHash: log.transactionHash as Hex,
      } satisfies StakeRow
    })
    // Chunks complete out of order; report the furthest end reached so far.
    if (to > scannedTo) scannedTo = to
    found += rows.length
    onProgress?.({ phase: "scanning-stakes", fromBlock, toBlock, scannedTo, eventsFound: found })
    return rows
  })

  return perRange.flat()
}

interface ResolveSplitRecipientsInput {
  stakingRegistryAddress: Address
  toBlock: bigint
  client: PublicClient
  candidates: readonly StakeRow[]
  retryMeter?: { retries: number }
  onProgress?: (p: DiscoveryProgress) => void
}

/** How many transaction receipts to fetch concurrently. */
const RECEIPT_CONCURRENCY = 50

/**
 * Resolve each candidate's `_userRewardsRecipient` (`recipients[1]`) by
 * reading the `SplitCreated` log from the **same transaction** that emitted
 * the stake — the StakingRegistry creates the split synchronously in
 * `stake()`. The emitting factory must match `PULL_SPLIT_FACTORY()` and the
 * split must be immutable and created by the configured registry.
 *
 * Returns lowercased split address → recipients[1]. The caller rejects any
 * unresolved beneficiary; receipt failures propagate after retries.
 */
async function resolveSplitRecipientsFromReceipts(
  input: ResolveSplitRecipientsInput,
): Promise<Map<string, Address>> {
  const { client, candidates, retryMeter, onProgress, stakingRegistryAddress, toBlock } = input
  const result = new Map<string, Address>()
  if (candidates.length === 0) return result

  const factory = await withRetry(() => client.readContract({
    address: stakingRegistryAddress,
    abi: [parseAbiItem("function PULL_SPLIT_FACTORY() view returns (address)")],
    functionName: "PULL_SPLIT_FACTORY", blockNumber: toBlock,
  }), undefined, undefined, retryMeter)
  const splitTopic0 = encodeEventTopics({ abi: [SPLIT_CREATED_EVENT] })[0]

  // Group candidates by their stake tx so each receipt is fetched once (a tx
  // could, in principle, carry more than one of our stakes).
  const byTx = new Map<Hex, StakeRow[]>()
  for (const c of candidates) {
    const list = byTx.get(c.txHash)
    if (list) list.push(c)
    else byTx.set(c.txHash, [c])
  }
  const txHashes = [...byTx.keys()]

  let processed = 0
  await mapWithConcurrency(txHashes, RECEIPT_CONCURRENCY, async (txHash) => {
    const receipt = await withRetry(
      () => client.getTransactionReceipt({ hash: txHash }),
      undefined, undefined, retryMeter,
    )
    const wanted = new Map(byTx.get(txHash)!.map((c) => [c.splitAddress.toLowerCase(), true]))
    for (const log of receipt.logs) {
      if (log.topics[0] !== splitTopic0 || log.address.toLowerCase() !== factory.toLowerCase()) continue
      let decoded
      try {
        decoded = decodeEventLog({ abi: [SPLIT_CREATED_EVENT], data: log.data, topics: log.topics })
      } catch {
        continue // a different SplitCreated overload (e.g. deterministic salt)
      }
      const args = decoded.args as {
        split: Address
        splitParams: { recipients: readonly Address[] }
        creator: Address
        owner: Address
      }
      const split = args.split.toLowerCase()
      if (!wanted.has(split)) continue
      if (args.creator.toLowerCase() !== stakingRegistryAddress.toLowerCase() ||
          args.owner !== "0x0000000000000000000000000000000000000000") {
        throw new Error(`Split ${args.split} is not an immutable registry-created split`)
      }
      const recipients = args.splitParams.recipients
      // StakingRegistry creates splits with recipients =
      // [providerRewardsRecipient, _userRewardsRecipient]; we want [1].
      if (recipients.length === 2 && recipients[1] !== undefined && recipients[1] !== "0x0000000000000000000000000000000000000000") {
        const recipient = getAddress(recipients[1]) as Address
        if (result.has(split) && result.get(split) !== recipient) throw new Error(`Conflicting split ${split}`)
        result.set(split, recipient)
      }
    }
    processed++
    if (processed % RECEIPT_CONCURRENCY === 0 || processed === txHashes.length) {
      onProgress?.({ phase: "resolving-splits", resolved: processed, total: txHashes.length, matched: result.size })
    }
  })
  return result
}

/** Select the stake that existed when this accepted proposal was emitted. */
export function delegatorAtProposal(
  history: readonly DiscoveredDelegator[], attester: Address, block: bigint, logIndex: number,
): DiscoveredDelegator | undefined {
  return history.filter((d) => d.attester.toLowerCase() === attester.toLowerCase() &&
    (d.stakedAtBlock < block || (d.stakedAtBlock === block && (d.stakedAtLogIndex ?? 0) < logIndex)))
    .sort((a, b) => a.stakedAtBlock === b.stakedAtBlock
      ? (a.stakedAtLogIndex ?? 0) - (b.stakedAtLogIndex ?? 0)
      : a.stakedAtBlock < b.stakedAtBlock ? -1 : 1).at(-1)
}
