import { decodeFunctionData, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from "viem"
import { mapWithConcurrency, withRetry } from "./concurrency.js"
import type { AttributedCheckpoint } from "./proposals.js"
import type { DistributionEntry } from "./types.js"

const FEE_HEADER_ABI = parseAbi([
  "function getFeeHeader(uint256) view returns ((uint256 excessMana,uint256 manaUsed,uint256 ethPerFeeAsset,uint256 congestionCost,uint256 proverCost))",
])
const COUNTER_ABI = parseAbi(["function getSequencerRewards(address) view returns (uint256)"])
const CLAIM_ABI = parseAbi(["function claimSequencerRewards(address _sequencer) returns (uint256)"])
const SAFE_ABI = parseAbi(["function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool)"])
const MULTISEND_ABI = parseAbi(["function multiSend(bytes transactions) payable"])
const AGGREGATE_ABI = parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])"])
const TRANSFER = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)")
const CONFIG_CHANGED = parseAbiItem("event RewardConfigUpdated((uint32 sequencerBps,uint96 checkpointReward) rewardConfig)")

export interface PayableCheckpoint extends AttributedCheckpoint { delegator: Address }
export interface CheckpointReward extends PayableCheckpoint {
  fixedReward: bigint
  sequencerFee: bigint
  grossReward: bigint
}

/** Deployed v5 RewardLib: fee asset revenue less burn and the capped prover fee. */
export function netSequencerFee(accumulatedFees: bigint, header: {
  manaUsed: bigint; congestionCost: bigint; proverCost: bigint
}): bigint {
  const available = accumulatedFees - header.manaUsed * header.congestionCost
  if (available < 0n) throw new Error("Checkpoint fees are below the protocol burn")
  const prover = header.manaUsed * header.proverCost
  return available - (prover < available ? prover : available)
}

export async function readCheckpointRewards(input: {
  client: PublicClient; rollupAddress: Address; checkpoints: readonly PayableCheckpoint[];
  sequencerRewardPerCheckpoint: bigint; retryMeter?: { retries: number }
}): Promise<CheckpointReward[]> {
  return mapWithConcurrency(input.checkpoints, 12, async (c) => {
    if (c.accumulatedFees === undefined) {
      throw new Error(`Checkpoint ${c.checkpointNumber} has no verifiable fee header (v5 required); refusing an approximate payout`)
    }
    const sequencerFee = c.accumulatedFees === 0n ? 0n : netSequencerFee(c.accumulatedFees,
      await withRetry(() => input.client.readContract({
        address: input.rollupAddress, abi: FEE_HEADER_ABI, functionName: "getFeeHeader",
        args: [c.checkpointNumber], blockNumber: c.blockNumber,
      }), undefined, undefined, input.retryMeter))
    return { ...c, sequencerFee, fixedReward: input.sequencerRewardPerCheckpoint,
      grossReward: input.sequencerRewardPerCheckpoint + sequencerFee }
  })
}

/** Commission is applied to each beneficiary's actual earnings, never a pooled fee total. */
export function buildRewardDistribution(
  checkpoints: readonly CheckpointReward[], commissionBps: number, dustThreshold: bigint,
): DistributionEntry[] {
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10000 || dustThreshold < 0n) {
    throw new Error("Invalid commission or dust threshold")
  }
  const byRecipient = new Map<string, { delegator: Address; gross: bigint; weight: number; attesters: Set<string> }>()
  const seen = new Set<string>()
  for (const c of checkpoints) {
    const checkpoint = c.checkpointNumber.toString()
    if (seen.has(checkpoint)) throw new Error(`Duplicate checkpoint ${checkpoint}`)
    seen.add(checkpoint)
    if (c.grossReward < 0n) throw new Error("Negative checkpoint reward")
    const key = c.delegator.toLowerCase()
    const row = byRecipient.get(key) ?? { delegator: c.delegator, gross: 0n, weight: 0, attesters: new Set<string>() }
    row.gross += c.grossReward; row.weight++; row.attesters.add(c.proposer.toLowerCase())
    byRecipient.set(key, row)
  }
  return [...byRecipient.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, r]) => ({
    delegator: r.delegator, preRateShare: r.gross,
    amount: r.gross * BigInt(10000 - commissionBps) / 10000n,
    weight: r.weight, attesters: r.attesters.size,
  })).filter((r) => r.amount > 0n && r.amount >= dustThreshold)
}

/** Identify claims in direct calls, Safe execTransaction, Multisend or Multicall3.
 * Unknown wrappers fail closed rather than counting an unrelated rollup transfer. */
export function isSequencerClaim(to: Address | null, data: Hex, rollup: Address, wallet: Address, depth = 0): boolean {
  if (!to || depth > 6) return false
  if (to.toLowerCase() === rollup.toLowerCase()) {
    try { const decoded = decodeFunctionData({ abi: CLAIM_ABI, data });
      return decoded.args[0].toLowerCase() === wallet.toLowerCase()
    } catch { return false }
  }
  try {
    const decoded = decodeFunctionData({ abi: SAFE_ABI, data })
    return isSequencerClaim(decoded.args[0], decoded.args[2], rollup, wallet, depth + 1)
  } catch { /* try known batch wrappers */ }
  try {
    const decoded = decodeFunctionData({ abi: AGGREGATE_ABI, data })
    return decoded.args[0].some((call) => isSequencerClaim(call.target, call.callData, rollup, wallet, depth + 1))
  } catch { /* try Safe MultiSend */ }
  try {
    const packed = decodeFunctionData({ abi: MULTISEND_ABI, data }).args[0].slice(2)
    let offset = 0, found = false
    while (offset < packed.length) {
      if (offset + 170 > packed.length) return false
      const target = `0x${packed.slice(offset + 2, offset + 42)}` as Address
      const length = BigInt(`0x${packed.slice(offset + 106, offset + 170)}`)
      if (length > BigInt((packed.length - offset - 170) / 2)) return false
      const end = offset + 170 + Number(length) * 2
      found = isSequencerClaim(target, `0x${packed.slice(offset + 170, end)}`, rollup, wallet, depth + 1) || found
      offset = end
    }
    return found
  } catch { return false }
}

export interface RewardReconciliation {
  counterBefore: bigint
  counterAfter: bigint
  claimedInWindow: bigint
  measuredAccrual: bigint
  modeledAccrual: bigint
  claims: Array<{ transactionHash: Hex; blockNumber: bigint; amount: bigint }>
}

export function assertRewardReconciliation(before: bigint, after: bigint, claims: bigint, modeled: bigint): bigint {
  const measured = after - before + claims
  if (measured !== modeled || measured < 0n) {
    throw new Error(`Reward reconciliation failed: measured ${measured}, attributed ${modeled}, difference ${measured - modeled}. Refusing to emit or send an incomplete payout.`)
  }
  return measured
}

export async function reconcileRewards(input: {
  client: PublicClient; rollupAddress: Address; tokenAddress: Address; distributionWalletAddress: Address;
  fromBlock: bigint; toBlock: bigint; logChunkSize: bigint; modeledAccrual: bigint; retryMeter?: { retries: number }
}): Promise<RewardReconciliation> {
  const { client, rollupAddress, distributionWalletAddress, retryMeter } = input
  const read = (blockNumber: bigint) => withRetry(() => client.readContract({
    address: rollupAddress, abi: COUNTER_ABI, functionName: "getSequencerRewards",
    args: [distributionWalletAddress], blockNumber,
  }), undefined, undefined, retryMeter)
  const [counterBefore, counterAfter] = await Promise.all([read(input.fromBlock), read(input.toBlock)])
  const claims: RewardReconciliation["claims"] = []
  const verified = new Set<string>()
  // End-of-block counters imply the exact interval (fromBlock, toBlock].
  for (let fromBlock = input.fromBlock + 1n; fromBlock <= input.toBlock; fromBlock += input.logChunkSize) {
    const toBlock = fromBlock + input.logChunkSize - 1n < input.toBlock ? fromBlock + input.logChunkSize - 1n : input.toBlock
    const [transfers, changes] = await Promise.all([
      withRetry(() => client.getLogs({ address: input.tokenAddress, event: TRANSFER,
        args: { from: rollupAddress, to: distributionWalletAddress }, fromBlock, toBlock }), undefined, undefined, retryMeter),
      withRetry(() => client.getLogs({ address: rollupAddress, event: CONFIG_CHANGED, fromBlock, toBlock }), undefined, undefined, retryMeter),
    ])
    if (changes.length) throw new Error("Reward configuration changed within the window; split the settlement at that change")
    for (const log of transfers) {
      if (log.args.value === undefined || log.blockNumber === null || !log.transactionHash) throw new Error("Incomplete reward transfer log")
      if (!verified.has(log.transactionHash)) {
        const tx = await withRetry(() => client.getTransaction({ hash: log.transactionHash! }), undefined, undefined, retryMeter)
        if (!isSequencerClaim(tx.to, tx.input, rollupAddress, distributionWalletAddress)) {
          throw new Error(`Unverified rollup transfer ${log.transactionHash}; cannot classify it as sequencer rewards`)
        }
        verified.add(log.transactionHash)
      }
      claims.push({ transactionHash: log.transactionHash, blockNumber: log.blockNumber, amount: log.args.value })
    }
  }
  const claimedInWindow = claims.reduce((s, c) => s + c.amount, 0n)
  const measuredAccrual = assertRewardReconciliation(counterBefore, counterAfter, claimedInWindow, input.modeledAccrual)
  return { counterBefore, counterAfter, claimedInWindow, measuredAccrual, modeledAccrual: input.modeledAccrual, claims }
}
