import {
  type Address,
  type PublicClient,
} from "viem"
import { withRetry } from "./concurrency.js"
import { findDeployBlock } from "./discovery.js"

/**
 * Epoch-range resolver.
 *
 * The settlement unit is the **epoch**, not the L1 block. An epoch is "ours to
 * settle" once two things are true:
 *
 *   1. The rollup proof for that epoch has landed on L1 (rewards have been
 *      credited to the operator's coinbase in `sequencerRewards`).
 *   2. The L1 block where that proof landed is itself L1-finalized (so a reorg
 *      can never invalidate it).
 *
 * This module takes an operator-supplied `[fromEpoch, toEpoch]` and produces:
 *
 *   - `fromCheckpoint`, `toCheckpoint`  — the L2 checkpoint range that
 *     comprises those epochs (since `CheckpointProposed` carries only
 *     `checkpointNumber`, the proposal scan filters on this range).
 *   - `fromBlock`, `toBlock`            — the L1 block range bounding the
 *     period's *rewards*: `fromBlock` is the L1 block where the proof for
 *     epoch `fromEpoch - 1` landed; `toBlock` is the L1 block where the proof
 *     for epoch `toEpoch` landed. `balanceOf(fromBlock)` and
 *     `balanceOf(toBlock)` define the period's net inflow.
 *
 * Both gates are enforced here. Caller gets a fully-resolved, finalised window
 * or an error — there is no "maybe proven, maybe not" middle state.
 */

/** Rollup view: epoch number that contains a given L2 checkpoint. The rollup
 *  walks the on-chain slot store internally — this is a single uint256 view
 *  but it does touch state, so cheaper than a multi-call scan would be. */
export const GET_EPOCH_FOR_CHECKPOINT_ABI = [
  {
    name: "getEpochForCheckpoint",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_checkpointNumber", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const

/** Rollup view: highest L2 checkpoint number with a posted proof. Called at a
 *  specific historical L1 block to binary-search for the block where a given
 *  proof landed. */
export const GET_PROVEN_CHECKPOINT_NUMBER_ABI = [
  {
    name: "getProvenCheckpointNumber",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const

/** Rollup view: both the pending tip (last proposed checkpoint) and the proven
 *  tip (last with a posted proof). We use `pending` to locate the L1 block at
 *  which a given checkpoint was proposed (epoch lookup) and to read the
 *  pending tip at an epoch boundary (checkpoint-range lookup). */
export const GET_TIPS_ABI = [
  {
    name: "getTips",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "pendingCheckpointNumber", type: "uint256" },
          { name: "provenCheckpointNumber", type: "uint256" },
        ],
      },
    ],
  },
] as const

/** Rollup view: L2 timestamp at the start of an L2 epoch. The whole resolver
 *  pivots on this: given the timestamp where epoch `E` begins, we can binary-
 *  search L1 blocks directly (by `block.timestamp`) instead of searching
 *  checkpoint-space with `getEpochForCheckpoint` (which the rollup gates
 *  behind its circular slot buffer and reverts for old checkpoints). */
export const GET_TIMESTAMP_FOR_EPOCH_ABI = [
  {
    name: "getTimestampForEpoch",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_epoch", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const

export interface EpochRange {
  /** Caller's input, echoed for the audit. */
  fromEpoch: bigint
  /** Resolved (after `latest-proven` sentinel substitution). */
  toEpoch: bigint
  /** Latest epoch fully proven on L1 at the resolution moment. */
  latestProvenEpoch: bigint
  /** Latest checkpoint with a posted proof at the resolution moment. */
  provenCheckpointTip: bigint
  /** First L2 checkpoint number whose epoch == `fromEpoch`. */
  fromCheckpoint: bigint
  /** Last L2 checkpoint number whose epoch == `toEpoch`. */
  toCheckpoint: bigint
  /** L1 block immediately after the proof for `fromEpoch - 1` landed (or 0 if
   *  `fromEpoch == 0`). `balanceOf(fromBlock)` includes all rewards from
   *  epochs `< fromEpoch` and **none** of `fromEpoch`'s rewards. */
  fromBlock: bigint
  /** L1 block where the proof for `toEpoch` landed. `balanceOf(toBlock)`
   *  includes all rewards from epochs `[fromEpoch, toEpoch]`. */
  toBlock: bigint
  /** L1 finalized block at resolution time, recorded for the audit. */
  finalizedBlock: bigint
  /** L1 block at which the rollup was deployed — either pinned via config or
   *  auto-detected. Used as the lower bound for all binary searches over L1
   *  history; recorded so reruns with the same config are byte-identical. */
  rollupDeployedAtBlock: bigint
}

/** Progress events emitted by `resolveEpochRange` so the caller can render a
 *  live status line through its ~140-call resolution. */
export type EpochResolverProgress =
  | { phase: "fetching-finalized-block" }
  | { phase: "auto-detecting-rollup-deploy-block" }
  | { phase: "reading-proven-tip"; finalizedBlock: bigint }
  | {
      phase: "computing-latest-proven-epoch"
      provenCheckpointTip: bigint
      /** Inner binary search progress for the proposal block of the proven
       *  tip. `step` starts at 1 and counts upward. */
      step: number
      lo: bigint
      hi: bigint
    }
  | {
      phase: "finding-from-checkpoint" | "finding-to-checkpoint"
      step: "reading-epoch-timestamp"
      epochBoundary: bigint
    }
  | {
      phase: "finding-from-checkpoint" | "finding-to-checkpoint"
      step: "searching-l1-block"
      boundaryTimestamp: bigint
      binStep: number
      lo: bigint
      hi: bigint
    }
  | {
      phase: "finding-from-checkpoint" | "finding-to-checkpoint"
      step: "reading-pending-at-boundary"
      boundaryBlock: bigint
    }
  | {
      phase: "finding-to-block" | "finding-from-block"
      step: number
      lo: bigint
      hi: bigint
    }

export interface ResolveEpochRangeInput {
  client: PublicClient
  rollupAddress: Address
  /** Pinned by caller. Must be ≤ `toEpoch` (else throws). */
  fromEpoch: bigint
  /** Pinned, or `null` for `latest-proven` (resolved to `latestProvenEpoch`). */
  toEpoch: bigint | null
  /** Optional lower bound for binary searches over L1 history (typically the
   *  rollup's deploy block). Trims a handful of RPC calls per search by
   *  skipping pre-deploy blocks where the rollup contract doesn't exist.
   *  Defaults to 0 (search from genesis). */
  rollupDeployedAtBlock?: bigint
  /** Optional retry counter — passed through to `withRetry`. */
  retryMeter?: { retries: number }
  /** Live progress callback — fired before each RPC the resolver issues so
   *  the caller can render a status line through the ~140-call resolution. */
  onProgress?: (p: EpochResolverProgress) => void
}

/**
 * Resolve `[fromEpoch, toEpoch]` to a fully-bounded settlement window.
 *
 * Method: timestamp math. L2 slots have deterministic L1 timestamps, and the
 * rollup exposes `getTimestampForEpoch(E)` directly — given the L2 timestamp
 * where epoch `E` starts, we find the L1 block at that timestamp (binary
 * search on `block.timestamp`) and read `getTips(B).pending` there to get the
 * checkpoint number at the epoch boundary. This sidesteps `getEpochForCheckpoint`'s
 * circular-buffer limitation (see `readEpochForCheckpointSafe` for the full
 * story) and replaces ~17×2 outer × ~26 inner binary searches with ~5 plain
 * binary searches.
 *
 * RPC budget (rough, on a non-batching RPC):
 *   - 1   : `getBlock({blockTag: 'finalized'})`
 *   - 1   : `getProvenCheckpointNumber()` at finalized
 *   - ~28 : safe lookup for `latestProvenEpoch` (binary search for the
 *           proposal block of the proven tip + 1 `getEpochForCheckpoint`)
 *   - ~28 : timestamp lookup for `fromCheckpoint` (1 `getTimestampForEpoch`
 *           + binary search L1 by timestamp + 1 `getTips`; skipped when
 *           `fromEpoch == 0`)
 *   - ~28 : timestamp lookup for `toCheckpoint` (skipped when
 *           `toEpoch == latestProvenEpoch` — toCheckpoint = provenTip)
 *   - ~26 : binary-search `getProvenCheckpointNumber` for `toBlock`
 *   - ~26 : same for `fromBlock` (skipped when `fromEpoch == 0`)
 *
 * Total: ~140 RPC calls, paid once per settlement. ~7× cheaper than the
 * previous nested-binary-search implementation, and constant in chain age.
 */
export async function resolveEpochRange(input: ResolveEpochRangeInput): Promise<EpochRange> {
  const {
    client,
    rollupAddress,
    fromEpoch,
    toEpoch: toEpochInput,
    rollupDeployedAtBlock: rollupDeployedAtBlockInput,
    retryMeter,
    onProgress,
  } = input

  if (fromEpoch < 0n) {
    throw new Error(`fromEpoch must be ≥ 0 (got ${fromEpoch})`)
  }
  if (toEpochInput !== null && toEpochInput < fromEpoch) {
    throw new Error(`toEpoch (${toEpochInput}) must be ≥ fromEpoch (${fromEpoch})`)
  }

  // ---- 1. Fetch the L1 finalized block. Everything we compute is pinned to
  //         this height so a reorg between resolver and proposal-scan can't
  //         leave us with an in-flight window. ----
  onProgress?.({ phase: "fetching-finalized-block" })
  const finalizedBlock = await withRetry(
    async () => {
      const blk = await client.getBlock({ blockTag: "finalized" })
      return blk.number ?? null
    },
    undefined,
    undefined,
    retryMeter,
  )
  if (finalizedBlock === null) {
    throw new Error(
      `RPC didn't return an L1 finalized block (block.number is null). This usually means ` +
        `the RPC is on a non-finalizing devnet/anvil; epoch settlement requires a chain with ` +
        `Casper finality (Ethereum mainnet / Sepolia / Holesky).`,
    )
  }

  // ---- 1b. Determine the rollup's L1 deploy block — the lower bound for
  //          all subsequent binary searches over L1 history. If pinned in
  //          config, use that directly (one-time read of one number). If
  //          omitted, auto-detect via `findDeployBlock` — binary-searches
  //          `eth_getCode(rollupAddress, B)` to find the first block with
  //          contract code (~25 RPC). Mirrors the same pattern discovery.ts
  //          uses for the StakingRegistry — operators don't have to look
  //          deploy blocks up by hand. ----
  let rollupDeployedAtBlock: bigint
  if (rollupDeployedAtBlockInput !== undefined && rollupDeployedAtBlockInput > 0n) {
    rollupDeployedAtBlock = rollupDeployedAtBlockInput
  } else {
    onProgress?.({ phase: "auto-detecting-rollup-deploy-block" })
    rollupDeployedAtBlock = await withRetry(
      () => findDeployBlock(client, rollupAddress, finalizedBlock),
      undefined,
      undefined,
      retryMeter,
    )
  }

  // ---- 2. Read the proven tip *at the finalized block*. Using the finalized
  //         block (not head) means the tip we read is itself finalised — no
  //         need to re-check later. ----
  onProgress?.({ phase: "reading-proven-tip", finalizedBlock })
  const provenCheckpointTip = await readProvenCheckpointTip(
    client,
    rollupAddress,
    finalizedBlock,
    retryMeter,
  )
  if (provenCheckpointTip === 0n) {
    throw new Error(
      `Rollup ${rollupAddress} has no proven checkpoints at L1 finalized block ${finalizedBlock}. ` +
        `Either the rollup is newly deployed and no epoch has been proven yet, or rollupAddress is wrong.`,
    )
  }
  // For provenTip's epoch we use the safe lookup (proposal-block query) — the
  // checkpoint-range lookups below avoid `getEpochForCheckpoint` entirely via
  // timestamp math, but for the proven tip we just want one epoch number, and
  // the safe path is the simplest known-good route. See
  // `readEpochForCheckpointSafe` for why we can't just call at the finalized
  // block (the rollup's per-checkpoint slot data lives in a circular buffer
  // that overwrites old entries; on chains where pruning isn't being
  // triggered, the buffer rolls past even the proven tip).
  const latestProvenEpoch = await readEpochForCheckpointSafe(
    client,
    rollupAddress,
    provenCheckpointTip,
    rollupDeployedAtBlock,
    finalizedBlock,
    retryMeter,
    (step, lo, hi) =>
      onProgress?.({
        phase: "computing-latest-proven-epoch",
        provenCheckpointTip,
        step,
        lo,
        hi,
      }),
  )

  // ---- 3. Resolve the `latest-proven` sentinel and apply the proven gate. ----
  const toEpoch = toEpochInput ?? latestProvenEpoch
  if (toEpoch > latestProvenEpoch) {
    throw new Error(
      `toEpoch ${toEpoch} is not yet proven on L1 (latest proven epoch is ${latestProvenEpoch} ` +
        `at finalized block ${finalizedBlock}). Re-run later, or use --to-epoch latest-proven.`,
    )
  }

  // ---- 4. Find the checkpoint range via timestamp math. ----
  //
  // toCheckpoint is the last checkpoint in `toEpoch`. When toEpoch is the
  // latest proven epoch, that's just provenTip (proofs end at epoch
  // boundaries, so the proven tip is always the last checkpoint of *some*
  // epoch). Otherwise: epoch `toEpoch` ends at L2 timestamp
  // `getTimestampForEpoch(toEpoch + 1) - 1`; the L1 block at that timestamp
  // has `getTips().pending == toCheckpoint` (all proposals for slots through
  // the end of toEpoch are published by then, and no proposals for later
  // epochs can have landed yet — slots have strict L1 deadlines).
  const toCheckpoint =
    toEpoch === latestProvenEpoch
      ? provenCheckpointTip
      : await readCheckpointAtEpochBoundary(
          client,
          rollupAddress,
          toEpoch + 1n, // boundary = start of (toEpoch + 1) = end of toEpoch + 1
          rollupDeployedAtBlock,
          finalizedBlock,
          retryMeter,
          "to",
          onProgress,
        )

  // fromCheckpoint is the first checkpoint in `fromEpoch`. fromEpoch starts at
  // L2 timestamp `getTimestampForEpoch(fromEpoch)`; the L1 block immediately
  // before that has `pending == fromCheckpoint - 1`, so fromCheckpoint =
  // `pending + 1`. When `fromEpoch == 0`, the answer is 0 by construction
  // (skip the on-chain lookup).
  const fromCheckpoint =
    fromEpoch === 0n
      ? 0n
      : (await readCheckpointAtEpochBoundary(
          client,
          rollupAddress,
          fromEpoch,
          rollupDeployedAtBlock,
          finalizedBlock,
          retryMeter,
          "from",
          onProgress,
        )) + 1n

  // No proposals in [fromEpoch, toEpoch] at all (every epoch in the range was
  // empty). Valid input, just yields a no-op settlement; surface clearly.
  if (fromCheckpoint > toCheckpoint) {
    throw new Error(
      `No L2 checkpoints found in epoch range [${fromEpoch}, ${toEpoch}]. The epochs are proven ` +
        `but contain no proposals — likely all sequencer slots were missed. Nothing to settle.`,
    )
  }

  // ---- 5. Binary-search for the L1 blocks where these proofs landed. We
  //         look up `getProvenCheckpointNumber()` at historical L1 blocks; the
  //         function is monotone non-decreasing in block number, so binary
  //         search is valid here too. ----
  //
  // toBlock = smallest B such that getProvenCheckpointNumber(B) >= toCheckpoint.
  //   This is the block of the L2ProofVerified event that proved `toEpoch`'s
  //   last checkpoint — i.e. the block where toEpoch's rewards landed.
  const toBlock = await findBlockWhereTipReachesWithProgress(
    client,
    rollupAddress,
    toCheckpoint,
    rollupDeployedAtBlock,
    finalizedBlock,
    retryMeter,
    (step, lo, hi) => onProgress?.({ phase: "finding-to-block", step, lo, hi }),
  )

  // fromBlock = smallest B such that getProvenCheckpointNumber(B) >= fromCheckpoint - 1.
  //   That's the block where the *previous* epoch's proof landed. balance(B) at
  //   that point includes all rewards through epoch (fromEpoch - 1) but none of
  //   fromEpoch's. When fromEpoch == 0, there's no prior epoch — use the
  //   rollup-deploy block (the earliest balance read can be).
  const fromBlock =
    fromEpoch === 0n
      ? rollupDeployedAtBlock
      : await findBlockWhereTipReachesWithProgress(
          client,
          rollupAddress,
          fromCheckpoint - 1n,
          rollupDeployedAtBlock,
          finalizedBlock,
          retryMeter,
          (step, lo, hi) => onProgress?.({ phase: "finding-from-block", step, lo, hi }),
        )

  // Sanity — by construction `fromBlock ≤ toBlock ≤ finalizedBlock`, but
  // surface clearly if the rollup state ever violates this.
  if (toBlock > finalizedBlock) {
    throw new Error(
      `Resolved toBlock ${toBlock} is past the L1 finalized block ${finalizedBlock}. ` +
        `This shouldn't happen — the resolver reads only finalized state.`,
    )
  }
  if (fromBlock > toBlock) {
    throw new Error(
      `Resolved fromBlock ${fromBlock} > toBlock ${toBlock}. Inconsistent rollup state.`,
    )
  }

  return {
    fromEpoch,
    toEpoch,
    latestProvenEpoch,
    provenCheckpointTip,
    fromCheckpoint,
    toCheckpoint,
    fromBlock,
    toBlock,
    finalizedBlock,
    rollupDeployedAtBlock,
  }
}

async function readProvenCheckpointTip(
  client: PublicClient,
  rollupAddress: Address,
  blockNumber: bigint,
  retryMeter?: { retries: number },
): Promise<bigint> {
  return withRetry(
    () =>
      client.readContract({
        address: rollupAddress,
        abi: GET_PROVEN_CHECKPOINT_NUMBER_ABI,
        functionName: "getProvenCheckpointNumber",
        blockNumber,
      }) as Promise<bigint>,
    undefined,
    undefined,
    retryMeter,
  )
}

async function readEpochForCheckpoint(
  client: PublicClient,
  rollupAddress: Address,
  checkpointNumber: bigint,
  blockNumber: bigint,
  retryMeter?: { retries: number },
): Promise<bigint> {
  return withRetry(
    () =>
      client.readContract({
        address: rollupAddress,
        abi: GET_EPOCH_FOR_CHECKPOINT_ABI,
        functionName: "getEpochForCheckpoint",
        args: [checkpointNumber],
        blockNumber,
      }) as Promise<bigint>,
    undefined,
    undefined,
    retryMeter,
  )
}

/**
 * Read the `pending` checkpoint tip at the L1 block immediately before L2
 * epoch `epochBoundary` begins. Used twice:
 *
 *   - With `epochBoundary = fromEpoch`: pending at the L1 block before fromEpoch
 *     started = last checkpoint of (fromEpoch − 1) = `fromCheckpoint − 1`.
 *   - With `epochBoundary = toEpoch + 1`: pending at the L1 block before
 *     (toEpoch + 1) started = last checkpoint of toEpoch = `toCheckpoint`.
 *
 * Method:
 *   1. `getTimestampForEpoch(epochBoundary)` → L2 start timestamp T of that
 *      epoch.
 *   2. Binary search L1 blocks for the largest B with `block.timestamp < T`.
 *      Aztec L2 slot timestamps line up with L1 block timestamps (the
 *      proposer publishes the L2 block to L1 in a block whose timestamp is
 *      ≥ the slot's timestamp), so any proposal with slot.timestamp < T is
 *      visible at block B, and no later-epoch proposal can be.
 *   3. Read `getTips(B).pending`.
 */
async function readCheckpointAtEpochBoundary(
  client: PublicClient,
  rollupAddress: Address,
  epochBoundary: bigint,
  lowerBound: bigint,
  finalizedBlock: bigint,
  retryMeter: { retries: number } | undefined,
  which: "from" | "to",
  onProgress?: (p: EpochResolverProgress) => void,
): Promise<bigint> {
  const phase = which === "from" ? "finding-from-checkpoint" : "finding-to-checkpoint"
  onProgress?.({ phase, step: "reading-epoch-timestamp", epochBoundary })
  const boundaryTimestamp = await withRetry(
    () =>
      client.readContract({
        address: rollupAddress,
        abi: GET_TIMESTAMP_FOR_EPOCH_ABI,
        functionName: "getTimestampForEpoch",
        args: [epochBoundary],
        blockNumber: finalizedBlock,
      }) as Promise<bigint>,
    undefined,
    undefined,
    retryMeter,
  )

  // Largest B with block.timestamp < boundaryTimestamp = the L1 block right
  // before the epoch boundary. We find it via "smallest B with timestamp >=
  // boundary, minus 1". If the boundary is past the finalized block's
  // timestamp (the epoch hasn't started yet on L1), the search saturates at
  // finalizedBlock + 1 and we clamp.
  const firstAtOrAfter = await findFirstL1BlockAtOrAfterTimestamp(
    client,
    boundaryTimestamp,
    lowerBound,
    finalizedBlock,
    retryMeter,
    (step, lo, hi) =>
      onProgress?.({ phase, step: "searching-l1-block", boundaryTimestamp, binStep: step, lo, hi }),
  )
  const boundaryBlock =
    firstAtOrAfter > finalizedBlock
      ? finalizedBlock
      : firstAtOrAfter > lowerBound
        ? firstAtOrAfter - 1n
        : lowerBound

  onProgress?.({ phase, step: "reading-pending-at-boundary", boundaryBlock })
  const tips = (await withRetry(
    () =>
      client.readContract({
        address: rollupAddress,
        abi: GET_TIPS_ABI,
        functionName: "getTips",
        blockNumber: boundaryBlock,
      }),
    undefined,
    undefined,
    retryMeter,
  )) as { pendingCheckpointNumber: bigint; provenCheckpointNumber: bigint }
  return tips.pendingCheckpointNumber
}

/**
 * Smallest L1 block `B ∈ [0, upperBound]` with `block.timestamp ≥ target`.
 *
 * Standard "find first true" binary search over L1 block timestamps (which
 * are monotone non-decreasing). Pre-deploy / non-existent blocks shouldn't
 * happen inside `[0, finalizedBlock]`, but a fetch failure is absorbed as
 * `timestamp = 0` so the search just moves past it.
 */
async function findFirstL1BlockAtOrAfterTimestamp(
  client: PublicClient,
  target: bigint,
  lowerBound: bigint,
  upperBound: bigint,
  retryMeter: { retries: number } | undefined,
  onStep?: (step: number, lo: bigint, hi: bigint) => void,
): Promise<bigint> {
  let lo = lowerBound
  // hi is exclusive: we want a result in [0, upperBound], so search [0, upperBound + 1)
  // and let the caller clamp if the result equals upperBound + 1 (no L1 block in
  // range hits the target — boundary is in the future).
  let hi = upperBound + 1n
  let step = 0
  while (lo < hi) {
    step++
    onStep?.(step, lo, hi)
    const mid = (lo + hi) / 2n
    let timestampAtMid: bigint
    try {
      const blk = await withRetry(
        () => client.getBlock({ blockNumber: mid }),
        undefined,
        undefined,
        retryMeter,
      )
      timestampAtMid = blk.timestamp
    } catch {
      timestampAtMid = 0n
    }
    if (timestampAtMid >= target) hi = mid
    else lo = mid + 1n
  }
  return lo
}

/**
 * Read `getEpochForCheckpoint(c)` safely.
 *
 * The naive approach — calling at the L1 finalized block — fails on real
 * chains: the rollup stores per-checkpoint slot metadata in a small circular
 * buffer (`tempCheckpointLogs[checkpointNumber % size]` in STFLib), where
 * `size = epochDuration * (proofSubmissionEpochs + 1) + 1`. The view reverts
 * with `Rollup__UnavailableTempCheckpointLog` whenever `pending - c >= size`,
 * i.e. once enough new checkpoints have piled up since `c` for its slot to
 * have been overwritten.
 *
 * On a healthy chain that's getting pruned regularly, `pending - proven <
 * size` always holds. But on a testnet where pruning isn't being triggered,
 * `pending - proven` can drift past `size` — at which point *even the proven
 * tip itself* can't be looked up at the head. Observed in the wild: error
 * `0x8711786b` on a `getEpochForCheckpoint(provenTip)` call at finality.
 *
 * The robust fix: query at the L1 block where `c` was *proposed*. At that
 * block, `pending == c` (the proposal is the one that just bumped pending), so
 * `pending - c == 0 < size` — always inside the buffer, no matter how far the
 * chain has drifted since. We find that block via a binary search over
 * historical `getTips().pendingCheckpointNumber`.
 *
 * Cost: ~26 `getTips` calls (log2 of L1 block height) plus 1
 * `getEpochForCheckpoint` per safe lookup. Heavier than the naive call but
 * the only correct option on a chain that isn't aggressively pruning.
 */
async function readEpochForCheckpointSafe(
  client: PublicClient,
  rollupAddress: Address,
  checkpointNumber: bigint,
  lowerBound: bigint,
  finalizedBlock: bigint,
  retryMeter?: { retries: number },
  /** Inner-search progress: called per binary-search step of the proposal-
   *  block lookup. `step` is 1-indexed. */
  onInnerStep?: (step: number, lo: bigint, hi: bigint) => void,
): Promise<bigint> {
  if (checkpointNumber === 0n) {
    // Checkpoint 0 is initialised at rollup deploy; epoch 0 by construction.
    // Treat as a known answer rather than poking a pre-deploy block.
    return 0n
  }
  const proposalBlock = await findProposalBlockForCheckpoint(
    client,
    rollupAddress,
    checkpointNumber,
    lowerBound,
    finalizedBlock,
    retryMeter,
    onInnerStep,
  )
  return readEpochForCheckpoint(client, rollupAddress, checkpointNumber, proposalBlock, retryMeter)
}

/**
 * Smallest L1 block `B ∈ [0, upperBound]` with `getTips(B).pending ≥ target`.
 *
 * That block is precisely where the target checkpoint was first proposed
 * (pending advances by exactly +1 each `propose()`). Same "find first true"
 * shape as `findBlockWhereTipReaches`; pre-deploy reverts are absorbed as
 * `pending = 0`.
 */
async function findProposalBlockForCheckpoint(
  client: PublicClient,
  rollupAddress: Address,
  target: bigint,
  lowerBound: bigint,
  upperBound: bigint,
  retryMeter?: { retries: number },
  onStep?: (step: number, lo: bigint, hi: bigint) => void,
): Promise<bigint> {
  if (target === 0n) return lowerBound
  let lo = lowerBound
  let hi = upperBound
  let step = 0
  while (lo < hi) {
    step++
    onStep?.(step, lo, hi)
    const mid = (lo + hi) / 2n
    let pendingAtMid: bigint
    try {
      pendingAtMid = await readPendingCheckpointTip(client, rollupAddress, mid, retryMeter)
    } catch {
      // Pre-deploy block — no rollup state. Treat as pending = 0.
      pendingAtMid = 0n
    }
    if (pendingAtMid >= target) hi = mid
    else lo = mid + 1n
  }
  return lo
}

async function readPendingCheckpointTip(
  client: PublicClient,
  rollupAddress: Address,
  blockNumber: bigint,
  retryMeter?: { retries: number },
): Promise<bigint> {
  return withRetry(
    async () => {
      const tips = (await client.readContract({
        address: rollupAddress,
        abi: GET_TIPS_ABI,
        functionName: "getTips",
        blockNumber,
      })) as { pendingCheckpointNumber: bigint; provenCheckpointNumber: bigint }
      return tips.pendingCheckpointNumber
    },
    undefined,
    undefined,
    retryMeter,
  )
}

/**
 * Smallest L1 block `B ∈ [0, upperBound]` with `getProvenCheckpointNumber(B)
 * ≥ target`. Standard "find first true" binary search.
 *
 * `getProvenCheckpointNumber` reverts at L1 blocks before the rollup was
 * deployed (no contract code). We treat any revert as "proven = 0" so the
 * search just moves past pre-deploy blocks without needing to know the deploy
 * block up-front.
 */
async function findBlockWhereTipReachesWithProgress(
  client: PublicClient,
  rollupAddress: Address,
  target: bigint,
  lowerBound: bigint,
  upperBound: bigint,
  retryMeter: { retries: number } | undefined,
  onStep: (step: number, lo: bigint, hi: bigint) => void,
): Promise<bigint> {
  if (target <= 0n) return lowerBound
  let lo = lowerBound
  let hi = upperBound
  let step = 0
  while (lo < hi) {
    step++
    onStep(step, lo, hi)
    const mid = (lo + hi) / 2n
    let tipAtMid: bigint
    try {
      tipAtMid = await readProvenCheckpointTip(client, rollupAddress, mid, retryMeter)
    } catch {
      tipAtMid = 0n
    }
    if (tipAtMid >= target) hi = mid
    else lo = mid + 1n
  }
  return lo
}

