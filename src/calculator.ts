import {
  BaseError,
  ExecutionRevertedError,
  InvalidInputRpcError,
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import { mapWithConcurrency, withRetry } from "./concurrency.js"
import { GET_EPOCH_FOR_CHECKPOINT_ABI } from "./epochs.js"
import type { AttributedCheckpoint } from "./proposals.js"

/**
 * Governance-set v6 sequencer reward calculator.
 *
 * The rollup calls this once per epoch proof with one proposer per newly
 * proven checkpoint — every provider's, in checkpoint order — and credits
 * `rewards[i]` (plus the sequencer fee) to that checkpoint's coinbase. See
 * `ISequencerRewardCalculator` / `RewardLib.distributeCheckpointRewards` in
 * aztec-packages.
 */
export const CALCULATOR_ABI = parseAbi([
  "function getSequencerRewards(uint256 _epoch, address[] _proposers, uint256 _defaultReward, uint256 _checkpointReward) view returns (uint256[] rewards)",
])

/** Rollup view: the calculator currently in effect (zero address = none). */
export const GET_CALCULATOR_ABI = parseAbi([
  "function getSequencerRewardCalculator() view returns (address)",
])

/** Emitted once per epoch proof, with the proven checkpoint tip after the proof. */
const PROOF_VERIFIED = parseAbiItem("event L2ProofVerified(uint256 indexed checkpointNumber, address indexed proverId)")

/** Emitted by the rollup when the calculator is installed, replaced, or removed. */
export const CALCULATOR_CHANGED = parseAbiItem("event SequencerRewardCalculatorUpdated(address oldCalculator,address newCalculator)")

/** Rollup's validity bound on one checkpoint's sequencer reward. */
export const MAX_SEQUENCER_REWARD_PER_CHECKPOINT = 1_000_000n * 10n ** 18n

/** The gas the rollup forwards to the calculator for a proof of `n` checkpoints. */
export const CALCULATOR_GAS_BASE = 200_000n
export const CALCULATOR_GAS_PER_CHECKPOINT = 100_000n

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

/** One `SequencerRewardCalculatorUpdated` event inside the window. */
export interface CalculatorChange {
  blockNumber: bigint
  oldCalculator: Address
  newCalculator: Address
}

/**
 * The calculator state over a settlement window: what was in effect at
 * `fromBlock` (read end-of-block, so a change in `fromBlock` itself is already
 * folded into `initial`), and every change strictly after it through
 * `toBlock`, in block order.
 */
export interface CalculatorTimeline {
  initial: Address
  changes: CalculatorChange[]
}

export interface CalculatorRewardInput {
  client: PublicClient
  rollupAddress: Address
  /** Calculator state over the window; each proof is resolved against the
   *  calculator in effect at its own block, so a window may span an install or
   *  removal. */
  timeline: CalculatorTimeline
  /** Every checkpoint in the settlement window — all providers, all coinbases —
   *  because the rollup passes one proposer per newly proven checkpoint of the
   *  proof, not just this operator's subset. A calculator that positions or
   *  batches rewards over that array would otherwise be modelled against a
   *  different call than the chain made. */
  checkpoints: readonly AttributedCheckpoint[]
  /** `checkpointReward * sequencerBps / 10000`, as the rollup computes it. */
  defaultReward: bigint
  /** The rollup's total checkpoint reward (`getRewardConfig().checkpointReward`). */
  checkpointReward: bigint
  /** L1 block where the previous epoch's proof landed. */
  fromBlock: bigint
  /** L1 block where `toEpoch`'s proof landed. */
  toBlock: bigint
  logChunkSize: bigint
  retryMeter?: { retries: number }
}

interface ProofEvent {
  /** Proven checkpoint tip after this proof. */
  tip: bigint
  blockNumber: bigint
  /** Position in `(block, logIndex)` order; used as the group key. */
  index: number
}

/** Reads the calculator in effect at `fromBlock` and every change event in `(fromBlock, toBlock]`. */
export async function readCalculatorTimeline(input: {
  client: PublicClient; rollupAddress: Address;
  fromBlock: bigint; toBlock: bigint; logChunkSize: bigint; retryMeter?: { retries: number }
}): Promise<CalculatorTimeline> {
  const initial = await withRetry(() => input.client.readContract({
    address: input.rollupAddress, abi: GET_CALCULATOR_ABI,
    functionName: "getSequencerRewardCalculator", blockNumber: input.fromBlock,
  }), undefined, undefined, input.retryMeter)
  return { initial, changes: await scanCalculatorChanges(input) }
}

/** Every `SequencerRewardCalculatorUpdated` event in `(fromBlock, toBlock]`, in block order. */
export async function scanCalculatorChanges(input: {
  client: PublicClient; rollupAddress: Address;
  fromBlock: bigint; toBlock: bigint; logChunkSize: bigint; retryMeter?: { retries: number }
}): Promise<CalculatorChange[]> {
  const changes: CalculatorChange[] = []
  for (let from = input.fromBlock + 1n; from <= input.toBlock; from += input.logChunkSize) {
    const to = from + input.logChunkSize - 1n < input.toBlock ? from + input.logChunkSize - 1n : input.toBlock
    const logs = await withRetry(
      () => input.client.getLogs({ address: input.rollupAddress, event: CALCULATOR_CHANGED, fromBlock: from, toBlock: to }),
      undefined,
      undefined,
      input.retryMeter,
    )
    for (const log of logs) {
      const { oldCalculator, newCalculator } = log.args
      if (oldCalculator === undefined || newCalculator === undefined || log.blockNumber === null) {
        throw new Error("Incomplete SequencerRewardCalculatorUpdated log; cannot resolve the calculator timeline")
      }
      changes.push({ blockNumber: log.blockNumber, oldCalculator, newCalculator })
    }
  }
  return changes
}

/**
 * The calculator in effect when a proof landed at `proofBlock`: the newest
 * change strictly before that block, or the window's initial state. A change
 * in the proof's own block is ambiguous (tx order decides which calculator the
 * chain used) and is refused by the caller's same-block guard, never resolved
 * here.
 */
export function calculatorInEffectAt(timeline: CalculatorTimeline, proofBlock: bigint): Address {
  let inEffect = timeline.initial
  for (const change of timeline.changes) {
    if (change.blockNumber < proofBlock) inEffect = change.newCalculator
    else break
  }
  return inEffect
}

/**
 * The gas limit an `eth_call` needs so the callee receives exactly `stipend`
 * gas: the limit pays intrinsic gas and calldata gas first, and only the
 * remainder is forwarded. The rollup's `staticcall` forwards the whole stipend,
 * so without this the modelled call would be stingier than the chain's.
 */
export function ethCallGasLimit(data: Hex, stipend: bigint): bigint {
  let zeroBytes = 0n
  let nonzeroBytes = 0n
  for (let i = 2; i < data.length; i += 2) {
    if (data.slice(i, i + 2) === "00") zeroBytes++
    else nonzeroBytes++
  }
  return 21_000n + 4n * zeroBytes + 16n * nonzeroBytes + stipend
}

/**
 * Resolves the sequencer reward of every checkpoint in the window through the
 * rollup's on-chain calculator.
 *
 * Rewards are read where the protocol reads them: at the L1 block where the
 * epoch proof landed, one `getSequencerRewards` call per proof, with the
 * proposers of all newly proven checkpoints in checkpoint order. Each proof is
 * resolved against the calculator in effect at its own block, so a single
 * window may span an install or removal: proofs before the change replay
 * against the old calculator (the default path when that is the zero
 * address), proofs after it against the new one. `eth_call` executes against
 * end-of-block state, so a calculator whose inputs change later in the same
 * block would be modelled against state the chain never used; the run refuses
 * a window where the rollup changes the calculator in a paying proof's block,
 * or where any calculator that was ever in effect emits an event in one.
 * Changes that emit no event remain a known limitation — only a trace of the
 * paying proof tx can reproduce those exactly.
 *
 * A calculator call that reverts or runs out of the stipend pays the default
 * for that proof, exactly as `SequencerRewardCalculatorLib` does on-chain.
 * Transport failures are rethrown — they are not protocol outcomes.
 */
export async function readCalculatorRewards(input: CalculatorRewardInput): Promise<Map<bigint, bigint>> {
  const byCheckpoint = new Map<bigint, bigint>()
  if (input.checkpoints.length === 0) return byCheckpoint

  const proofs = await readProofEvents(input)
  const ordered = [...input.checkpoints].sort((a, b) => (a.checkpointNumber < b.checkpointNumber ? -1 : 1))

  // Proof tips are monotone, so a single pointer assigns every checkpoint to
  // the proof that first covered it.
  const groups = new Map<number, AttributedCheckpoint[]>()
  let cursor = 0
  for (const checkpoint of ordered) {
    while (cursor < proofs.length && proofs[cursor]!.tip < checkpoint.checkpointNumber) cursor++
    const proof = proofs[cursor]
    if (!proof) {
      throw new Error(
        `No L2ProofVerified event covers checkpoint ${checkpoint.checkpointNumber} in ` +
          `L1 blocks (${input.fromBlock}, ${input.toBlock}]; cannot resolve its calculator reward.`,
      )
    }
    const group = groups.get(proof.index) ?? []
    group.push(checkpoint)
    groups.set(proof.index, group)
  }

  const proofByIndex = new Map(proofs.map((p) => [p.index, p]))
  const proofBlocks = new Set([...groups.keys()].map((i) => proofByIndex.get(i)!.blockNumber))
  refuseSameBlockTimelineChange(input.timeline, proofBlocks)
  await refuseOnSameBlockCalculatorEvents(input, proofBlocks)

  const entries = [...groups.entries()]
  const resolved = await mapWithConcurrency(entries, 4, async ([index, checkpoints]) => {
    const proof = proofByIndex.get(index)!
    const calculator = calculatorInEffectAt(input.timeline, proof.blockNumber)
    // Zero address = no calculator: the chain pays every checkpoint of this
    // proof the default, with no call to replay.
    const rewards = calculator.toLowerCase() === ZERO_ADDRESS
      ? checkpoints.map(() => input.defaultReward)
      : await readOneProof(input, checkpoints, proof.blockNumber, calculator)
    return { checkpoints, rewards }
  })
  for (const { checkpoints, rewards } of resolved) {
    for (let i = 0; i < checkpoints.length; i++) {
      byCheckpoint.set(checkpoints[i]!.checkpointNumber, rewards[i]!)
    }
  }
  return byCheckpoint
}

async function readOneProof(
  input: CalculatorRewardInput,
  checkpoints: readonly AttributedCheckpoint[],
  proofBlock: bigint,
  calculator: Address,
): Promise<bigint[]> {
  const epoch = await withRetry(
    () =>
      input.client.readContract({
        address: input.rollupAddress,
        abi: GET_EPOCH_FOR_CHECKPOINT_ABI,
        functionName: "getEpochForCheckpoint",
        args: [checkpoints[checkpoints.length - 1]!.checkpointNumber],
        blockNumber: checkpoints[checkpoints.length - 1]!.blockNumber,
      }),
    undefined,
    undefined,
    input.retryMeter,
  )

  const proposers = checkpoints.map((c) => c.proposer)
  const defaults = checkpoints.map(() => input.defaultReward)
  const stipend = CALCULATOR_GAS_BASE + CALCULATOR_GAS_PER_CHECKPOINT * BigInt(proposers.length)
  const data = encodeFunctionData({
    abi: CALCULATOR_ABI,
    functionName: "getSequencerRewards",
    args: [epoch, proposers, input.defaultReward, input.checkpointReward],
  })

  let returndata: Hex | undefined
  try {
    returndata = await withRetry(
      async () =>
        (
          await input.client.call({
            to: calculator,
            data,
            blockNumber: proofBlock,
            gas: ethCallGasLimit(data, stipend),
          })
        ).data,
      undefined,
      undefined,
      input.retryMeter,
    )
  } catch (error) {
    // The rollup pays the default when the calculator reverts or exhausts its
    // stipend (SequencerRewardCalculatorLib rejects both, then falls back).
    if (isCalculatorFallback(error)) return defaults
    throw error
  }
  if (!returndata) return defaults

  // Mirror the rollup's response checks: the return data must be exactly the
  // ABI encoding of a `uint256[]` of length n (`64 + 32 * n` bytes), and each
  // value must be within MAX_SEQUENCER_REWARD_PER_CHECKPOINT. Anything else
  // pays the default.
  if ((returndata.length - 2) / 2 !== 64 + 32 * proposers.length) return defaults
  let rewards: readonly bigint[]
  try {
    rewards = decodeFunctionResult({ abi: CALCULATOR_ABI, functionName: "getSequencerRewards", data: returndata })
  } catch {
    return defaults
  }
  if (rewards.length !== proposers.length) return defaults
  for (const reward of rewards) {
    if (reward > MAX_SEQUENCER_REWARD_PER_CHECKPOINT) return defaults
  }
  return [...rewards]
}

/**
 * A `SequencerRewardCalculatorUpdated` in the same block as a paying proof is
 * ambiguous — which calculator the chain used depends on tx order inside the
 * block, which no historical read can recover — so refuse the window.
 */
function refuseSameBlockTimelineChange(timeline: CalculatorTimeline, proofBlocks: ReadonlySet<bigint>) {
  for (const change of timeline.changes) {
    if (proofBlocks.has(change.blockNumber)) {
      throw new Error(
        `Sequencer reward calculator changed to ${change.newCalculator} in block ${change.blockNumber}, ` +
          `the same block as an epoch proof paying this window. Which calculator that proof used depends on ` +
          `transaction order within the block and cannot be reproduced from end-of-block state; ` +
          `split the settlement at that change.`,
      )
    }
  }
}

/**
 * `eth_call` executes against end-of-block state, but the rollup's staticcall
 * runs at the proof tx's position mid-block. If a calculator emits anything in
 * a paying proof's block, its configuration may have changed after the proof
 * used it, so refuse the window instead of modelling against state the chain
 * never read. Every calculator that was ever in effect is checked: one that
 * was replaced mid-window still priced the proofs before the change.
 */
async function refuseOnSameBlockCalculatorEvents(input: CalculatorRewardInput, proofBlocks: ReadonlySet<bigint>) {
  if (proofBlocks.size === 0) return
  const addresses = new Set<string>()
  for (const address of [input.timeline.initial, ...input.timeline.changes.flatMap((c) => [c.oldCalculator, c.newCalculator])]) {
    if (address.toLowerCase() !== ZERO_ADDRESS) addresses.add(address.toLowerCase())
  }
  for (const address of addresses) {
    for (let from = input.fromBlock + 1n; from <= input.toBlock; from += input.logChunkSize) {
      const to = from + input.logChunkSize - 1n < input.toBlock ? from + input.logChunkSize - 1n : input.toBlock
      const logs = await withRetry(
        () => input.client.getLogs({ address: address as Address, fromBlock: from, toBlock: to }),
        undefined,
        undefined,
        input.retryMeter,
      )
      for (const log of logs) {
        if (log.blockNumber !== null && proofBlocks.has(log.blockNumber)) {
          throw new Error(
            `Sequencer reward calculator ${address} emitted an event in block ${log.blockNumber}, ` +
              `the same block as an epoch proof paying this window. Its per-checkpoint rewards cannot be ` +
              `reproduced from end-of-block state; split the settlement at that change.`,
          )
        }
      }
    }
  }
}

async function readProofEvents(input: CalculatorRewardInput): Promise<ProofEvent[]> {
  const events: ProofEvent[] = []
  for (let from = input.fromBlock + 1n; from <= input.toBlock; from += input.logChunkSize) {
    const to = from + input.logChunkSize - 1n < input.toBlock ? from + input.logChunkSize - 1n : input.toBlock
    const logs = await withRetry(
      () =>
        input.client.getLogs({
          address: input.rollupAddress,
          event: PROOF_VERIFIED,
          fromBlock: from,
          toBlock: to,
        }),
      undefined,
      undefined,
      input.retryMeter,
    )
    for (const log of logs) {
      const tip = log.args.checkpointNumber
      if (tip === undefined || log.blockNumber === null) {
        throw new Error("Incomplete L2ProofVerified log; cannot resolve calculator rewards")
      }
      events.push({ tip, blockNumber: log.blockNumber, index: events.length })
    }
  }
  return events
}

/**
 * True when the calculator call failed the way the rollup also treats as "pay
 * the default": an EVM revert, or a call that exhausted its stipend.
 *
 * `client.call` (unlike `readContract`) surfaces these as `CallExecutionError`
 * with `ExecutionRevertedError` in the cause chain — viem maps both
 * "execution reverted" and geth's "gas required exceeds allowance" wording to
 * that class. Nodes that word an out-of-gas `eth_call` differently surface it
 * as `InvalidInputRpcError` with the node message on the cause chain.
 */
function isCalculatorFallback(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false
  if (error.walk((e) => e instanceof ExecutionRevertedError) !== null) return true
  let invalidInput = false
  error.walk((e) => {
    if (e instanceof InvalidInputRpcError) invalidInput = true
    return false
  })
  if (!invalidInput) return false
  return (
    error.walk((e) => e instanceof Error && NODE_OUT_OF_GAS.test(e.message)) !== null
  )
}

const NODE_OUT_OF_GAS = /out of gas|gas required exceeds allowance|intrinsic gas too low/i
