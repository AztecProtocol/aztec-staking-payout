import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
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
 * proven checkpoint, in checkpoint order, and credits `rewards[i]` (plus the
 * sequencer fee) to that checkpoint's coinbase. See
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

/** Rollup's validity bound on one checkpoint's sequencer reward. */
export const MAX_SEQUENCER_REWARD_PER_CHECKPOINT = 1_000_000n * 10n ** 18n

/** The rollup forwards exactly this stipend to the calculator. */
export const CALCULATOR_GAS_BASE = 200_000n
export const CALCULATOR_GAS_PER_CHECKPOINT = 100_000n

export interface CalculatorRewardInput {
  client: PublicClient
  rollupAddress: Address
  calculator: Address
  /** This operator's checkpoints in the window, each with its proposal block. */
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

/**
 * Resolves the sequencer reward of each checkpoint through the rollup's
 * on-chain calculator.
 *
 * Rewards are read where the protocol reads them: at the L1 block where the
 * epoch proof landed, one `getSequencerRewards` call per proof, with the
 * checkpoint's proposer as the single entry. The reference
 * `RegistryReductionCalculator` decides each proposer independently, so a
 * one-entry call reproduces the rollup's per-checkpoint value; a calculator
 * that depended on the whole array would not reconcile against the counter and
 * the caller refuses the run.
 *
 * A reverting or empty-returning calculator is mirrored exactly as the rollup
 * behaves: every checkpoint of that proof falls back to `defaultReward`.
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
  const entries = [...groups.entries()]
  const resolved = await mapWithConcurrency(entries, 4, async ([index, checkpoints]) => {
    const proof = proofByIndex.get(index)!
    const rewards = await readOneProof(input, checkpoints, proof.blockNumber)
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
            to: input.calculator,
            data,
            blockNumber: proofBlock,
            gas: CALCULATOR_GAS_BASE + CALCULATOR_GAS_PER_CHECKPOINT * BigInt(proposers.length),
          })
        ).data,
      undefined,
      undefined,
      input.retryMeter,
    )
  } catch (error) {
    // The rollup pays the default when the calculator reverts or returns no
    // data (SequencerRewardCalculatorLib rejects both, then falls back).
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
 * True when the calculator call failed the way the rollup also treats as
 * "pay the default": an EVM revert or an empty response.
 */
function isCalculatorFallback(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false
  return (
    error.walk(
      (e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError,
    ) !== null
  )
}
