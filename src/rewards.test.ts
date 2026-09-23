import { describe, expect, it, vi } from "vitest"
import { encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from "viem"
import { assertRewardReconciliation, buildRewardDistribution, isSequencerClaim, netSequencerFee,
  readCheckpointRewards, reconcileRewards, type CheckpointReward } from "./rewards.js"

const wallet = "0x0000000000000000000000000000000000000011" as Address
const rollup = "0x0000000000000000000000000000000000000022" as Address
const alice = "0x0000000000000000000000000000000000000033" as Address
const bob = "0x0000000000000000000000000000000000000044" as Address
const token = "0x0000000000000000000000000000000000000055" as Address
const hash = `0x${"a".repeat(64)}` as Hex
const claimAbi = parseAbi(["function claimSequencerRewards(address) returns (uint256)"])
const claim = encodeFunctionData({ abi: claimAbi, functionName: "claimSequencerRewards", args: [wallet] })
const checkpoint = (n: bigint, delegator: Address, fee = 0n): CheckpointReward => ({
  checkpointNumber: n, delegator, proposer: alice, coinbase: wallet, blockNumber: 10n, logIndex: 2,
  txHash: hash, accumulatedFees: fee, fixedReward: 350n, sequencerFee: fee, grossReward: 350n + fee,
})

describe("exact checkpoint rewards", () => {
  it("subtracts the burn and caps the prover fee before crediting the sequencer", () => {
    expect(netSequencerFee(100n, { manaUsed: 3n, congestionCost: 2n, proverCost: 4n })).toBe(82n)
    expect(netSequencerFee(10n, { manaUsed: 3n, congestionCost: 2n, proverCost: 4n })).toBe(0n)
    expect(() => netSequencerFee(5n, { manaUsed: 3n, congestionCost: 2n, proverCost: 4n })).toThrow(/below/)
  })

  it("attributes variable fees to the checkpoint beneficiary, not to the whole pool", () => {
    const rows = buildRewardDistribution([checkpoint(1n, alice, 100n), checkpoint(2n, bob)], 2500, 0n)
    expect(rows.map((r) => [r.delegator, r.preRateShare, r.amount])).toEqual([
      [alice, 450n, 337n], [bob, 350n, 262n],
    ])
    // A pooled 800-unit reward would incorrectly pay 300 to each recipient.
  })

  it("rounds once per beneficiary and counts distinct attesters", () => {
    const rows = buildRewardDistribution([checkpoint(1n, alice), checkpoint(2n, alice)], 2500, 0n)
    expect(rows).toMatchObject([{ amount: 525n, weight: 2, attesters: 1 }])
    expect(buildRewardDistribution([checkpoint(1n, alice)], 10000, 0n)).toEqual([])
    expect(buildRewardDistribution([checkpoint(1n, alice)], 0, 351n)).toEqual([])
    expect(() => buildRewardDistribution([checkpoint(1n, alice), checkpoint(1n, bob)], 0, 0n)).toThrow(/Duplicate/)
  })

  it("reads fee state at the proposal block and rejects an unverifiable header", async () => {
    const readContract = vi.fn().mockResolvedValue({ manaUsed: 3n, congestionCost: 2n, proverCost: 4n })
    const input = { client: { readContract } as unknown as PublicClient, rollupAddress: rollup,
      checkpoints: [checkpoint(1n, alice, 100n)], sequencerRewardPerCheckpoint: 350n }
    expect(await readCheckpointRewards(input)).toMatchObject([{ sequencerFee: 82n, grossReward: 432n }])
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 10n, args: [1n] }))
    await expect(readCheckpointRewards({ ...input, checkpoints: [{ ...checkpoint(1n, alice), accumulatedFees: undefined }] }))
      .rejects.toThrow(/v5 required/)
  })
})

describe("independent reward reconciliation", () => {
  it("accounts for a counter reset by a claim and rejects even a one-unit gap", () => {
    expect(assertRewardReconciliation(100n, 50n, 400n, 350n)).toBe(350n)
    expect(() => assertRewardReconciliation(100n, 50n, 400n, 349n)).toThrow(/difference 1/)
    expect(() => assertRewardReconciliation(100n, 50n, 0n, 0n)).toThrow(/failed/)
  })

  it("recognizes direct and Safe/MultiSend claims with the correct beneficiary", () => {
    expect(isSequencerClaim(rollup, claim, rollup, wallet)).toBe(true)
    expect(isSequencerClaim(rollup, claim, rollup, alice)).toBe(false)
    expect(isSequencerClaim(rollup, "0x12345678", rollup, wallet)).toBe(false)
    const packed = `0x00${rollup.slice(2)}${"0".repeat(64)}${BigInt((claim.length - 2) / 2).toString(16).padStart(64, "0")}${claim.slice(2)}` as Hex
    const multiAbi = parseAbi(["function multiSend(bytes transactions) payable"])
    const multi = encodeFunctionData({ abi: multiAbi, functionName: "multiSend", args: [packed] })
    const safeAbi = parseAbi(["function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns (bool)"])
    const safe = encodeFunctionData({ abi: safeAbi, functionName: "execTransaction",
      args: [bob, 0n, multi, 1, 0n, 0n, 0n, wallet, wallet, "0x"] })
    expect(isSequencerClaim(wallet, safe, rollup, wallet)).toBe(true)
    expect(isSequencerClaim(bob, encodeFunctionData({ abi: multiAbi, functionName: "multiSend", args: ["0x00"] }), rollup, wallet)).toBe(false)
  })

  const fixture = (options: { badClaim?: boolean; configChanged?: boolean } = {}) => {
    const getLogs = vi.fn(async (q: { event: { name: string }; fromBlock: bigint; toBlock: bigint }) => {
      if (q.event.name === "RewardConfigUpdated") return options.configChanged ? [{}] : []
      return q.fromBlock <= 12n && q.toBlock >= 12n ? [{ args: { value: 400n }, blockNumber: 12n, transactionHash: hash }] : []
    })
    const client = { getLogs,
      readContract: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => blockNumber === 10n ? 100n : 50n),
      getTransaction: vi.fn(async () => ({ to: rollup, input: options.badClaim ? "0x12345678" : claim })),
    } as unknown as PublicClient
    return { client, getLogs, input: { client, rollupAddress: rollup, tokenAddress: token,
      distributionWalletAddress: wallet, fromBlock: 10n, toBlock: 15n, logChunkSize: 2n, modeledAccrual: 350n } }
  }

  it("scans the exact counter interval (fromBlock, toBlock] and verifies claim transactions", async () => {
    const { input, getLogs } = fixture()
    expect(await reconcileRewards(input)).toMatchObject({ claimedInWindow: 400n, measuredAccrual: 350n })
    expect(getLogs.mock.calls.map(([q]) => [q.fromBlock, q.toBlock])).toEqual([
      [11n, 12n], [11n, 12n], [13n, 14n], [13n, 14n], [15n, 15n], [15n, 15n],
    ])
  })

  it("refuses an unclassified transfer or a mid-window reward configuration change", async () => {
    await expect(reconcileRewards(fixture({ badClaim: true }).input)).rejects.toThrow(/Unverified rollup transfer/)
    await expect(reconcileRewards(fixture({ configChanged: true }).input)).rejects.toThrow(/configuration changed/)
  })
})
