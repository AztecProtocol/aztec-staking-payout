import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type Address, type Hex } from "viem"
import { settle, type SettleOptions } from "./settle.js"
import { makePublicClient } from "./client.js"
import { resolveEpochRange } from "./epochs.js"
import { discoverActiveDelegators } from "./discovery.js"
import { countProposalsByProposer } from "./proposals.js"
import { writeSafeImport } from "./calldata.js"
import { writeAuditRecordToDisk } from "./audit.js"

vi.mock("./client.js", () => ({ makePublicClient: vi.fn() }))
vi.mock("./epochs.js", () => ({ resolveEpochRange: vi.fn() }))
vi.mock("./discovery.js", async (original) => ({ ...await original<typeof import("./discovery.js")>(), discoverActiveDelegators: vi.fn() }))
vi.mock("./proposals.js", () => ({ countProposalsByProposer: vi.fn() }))
vi.mock("./gascost.js", () => ({ computeGasSpent: vi.fn(async () => ({ txCount: 2, totalGasUsed: 0n, totalEthSpentWei: 0n, weightedAvgGasPriceWei: 0n })) }))
vi.mock("./calldata.js", async (original) => ({ ...await original<typeof import("./calldata.js")>(), writeSafeImport: vi.fn(() => ({ safePath: "/unused/safe.json" })) }))
vi.mock("./audit.js", async (original) => ({ ...await original<typeof import("./audit.js")>(), writeAuditRecordToDisk: vi.fn(() => "/unused/audit.json") }))

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
const wallet = address(1), rollup = address(2), token = address(3), alice = address(4), bob = address(5)
const hash = `0x${"a".repeat(64)}` as Hex
const opts: SettleOptions = {
  config: { rpcUrl: "http://unused.invalid", commissionBps: 2500, providerId: "6", tokenAddress: token,
    distributionWalletAddress: wallet, rollupAddress: rollup, stakingRegistryAddress: address(6), multicallAddress: address(7),
    stakingRegistryDeployedAtBlock: 1n, rollupDeployedAtBlock: 1n, attributionMode: "proposals", logChunkSize: 100n,
    stakeLogChunkSize: 100n, dustThreshold: 0n, runsDir: "/unused", rpcMaxRequestsPerSecond: 50, rpcTimeoutMs: 30000 },
  fromEpoch: 1n, toEpoch: 1n, privateKey: null, dryRun: false, emitSafeImport: true, safeImportPath: null,
  simulateReward: null, outputMode: "safe", ignoreCoinbase: false,
}

describe("settlement export accuracy gates", () => {
  let measured: bigint
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
    measured = 800n
    const client = {
      getChainId: vi.fn(async () => 1),
      multicall: vi.fn(async () => [0, "TEST", address(8), { checkpointReward: 350n, sequencerBps: 10000 }].map((result) => ({ status: "success", result }))),
      getLogs: vi.fn(async () => []),
      readContract: vi.fn(async (q: { functionName: string; blockNumber?: bigint }) => {
        if (q.functionName === "getFeeHeader") return { manaUsed: 0n, congestionCost: 0n, proverCost: 0n }
        if (q.functionName === "getSequencerRewards") return q.blockNumber === 10n ? 0n : measured
        if (q.functionName === "balanceOf") return 1000n
        throw new Error(`Unexpected read ${q.functionName}`)
      }),
    }
    vi.mocked(makePublicClient).mockReturnValue({ client, meter: { count: 0, retries: 0 } } as never)
    vi.mocked(resolveEpochRange).mockResolvedValue({ fromEpoch: 1n, toEpoch: 1n, fromCheckpoint: 1n, toCheckpoint: 2n,
      fromBlock: 10n, toBlock: 20n, finalizedBlock: 30n, latestProvenEpoch: 1n, provenCheckpointTip: 2n, rollupDeployedAtBlock: 1n })
    vi.mocked(discoverActiveDelegators).mockResolvedValue({ delegators: [alice, bob].map((delegator, i) => ({
      delegator, attester: address(10 + i), splitAddress: address(20 + i), staker: address(30 + i),
      stakedAtBlock: 2n, stakedAtLogIndex: 0, delegatorSource: "split-recipient" as const,
    })), stats: { stakeEventsFound: 2, uniqueAttesters: 2, registeredOnRollup: 0 } })
    vi.mocked(countProposalsByProposer).mockResolvedValue({ totalCheckpoints: 2, unresolvedCheckpoints: 0,
      outOfRangeCheckpoints: 0, prunedAndReusedCheckpoints: 0, attributed: [0, 1].map((i) => ({
        checkpointNumber: BigInt(i + 1), proposer: address(10 + i), coinbase: wallet, blockNumber: 12n + BigInt(i),
        logIndex: 1, txHash: hash, accumulatedFees: i === 0 ? 100n : 0n,
      })),
    } as never)
  })
  afterEach(() => vi.restoreAllMocks())

  it("exports the actual beneficiary earnings only after reconciliation passes", async () => {
    const result = await settle(opts)
    expect(result.audit.rewardReconciliation).toMatchObject({ measuredAccrual: "800", modeledAccrual: "800" })
    expect(result.plan?.entries.map((r) => [r.delegator, r.amount])).toEqual([[alice, 337n], [bob, 262n]])
    expect(discoverActiveDelegators).toHaveBeenCalledWith(expect.objectContaining({ includeInactive: true }))
    expect(writeSafeImport).toHaveBeenCalledTimes(1)
    expect(result.audit.txHashes).toEqual([])
  })

  it("writes no Safe file or success audit when the independent counter differs", async () => {
    measured = 801n
    await expect(settle(opts)).rejects.toThrow(/Reward reconciliation failed/)
    expect(writeSafeImport).not.toHaveBeenCalled()
    expect(writeAuditRecordToDisk).not.toHaveBeenCalled()
  })

  it("writes no payout when a wallet-bound checkpoint has no historical beneficiary", async () => {
    vi.mocked(discoverActiveDelegators).mockResolvedValueOnce({ delegators: [{ delegator: alice, attester: address(10),
      splitAddress: address(20), staker: address(30), stakedAtBlock: 2n, delegatorSource: "split-recipient" }],
      stats: { stakeEventsFound: 1, uniqueAttesters: 1, registeredOnRollup: 0 } })
    await expect(settle(opts)).rejects.toThrow(/no verified historical beneficiary/)
    expect(writeSafeImport).not.toHaveBeenCalled()
  })
})
