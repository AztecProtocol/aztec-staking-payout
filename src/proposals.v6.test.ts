import { describe, expect, it } from "vitest"
import { createPublicClient, custom, decodeFunctionData, encodeFunctionData, parseAbi, type Address, type Hex } from "viem"
import fixture from "./fixtures/v6-mainnet-proposal.json"
import feesFixture from "./fixtures/v6-mainnet-fees.json"
import { countProposalsByProposer } from "./proposals.js"
import { readCheckpointRewards } from "./rewards.js"

const BATCH = parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable"])
const rollup = fixture.expected.rollup as Address
const calls = decodeFunctionData({ abi: BATCH, data: fixture.transaction.input as Hex }).args[0]

async function recover(input: Hex, address = rollup, source = fixture) {
  const client = createPublicClient({ transport: custom({ async request({ method }) {
    if (method === "eth_chainId") return "0x1"
    if (method === "eth_getLogs") return source.receipt.logs.filter((log) => log.address.toLowerCase() === rollup)
    if (method === "eth_getTransactionByHash") return { ...source.transaction, input }
    throw new Error(`Unexpected RPC method ${method}`)
  } }) })
  return countProposalsByProposer({ client, rollupAddress: address, multicallAddress: fixture.transaction.to as Address,
    fromBlock: BigInt(fixture.transaction.blockNumber), toBlock: BigInt(fixture.transaction.blockNumber), logChunkSize: 1n })
}

describe("v6 deployed mainnet proposal", () => {
  it.each(["multicall", "direct"])("recovers %s calldata against the independent historical getProposerAt result", async (shape) => {
    const out = await recover(shape === "direct" ? calls[0]!.callData : fixture.transaction.input as Hex)
    expect(out.unresolvedCheckpoints).toBe(0)
    expect(out.attributed).toHaveLength(1)
    expect(out.attributed[0]).toMatchObject({ proposer: fixture.expected.proposer, coinbase: fixture.expected.coinbase,
      checkpointNumber: BigInt(fixture.expected.checkpointNumber), accumulatedFees: BigInt(fixture.expected.accumulatedFees),
      proposalVersion: "v6" })
  })

  it("rejects two matching v6 calls instead of guessing which earned the reward", async () => {
    const out = await recover(encodeFunctionData({ abi: BATCH, functionName: "aggregate3", args: [[calls[0]!, calls[0]!]] }))
    expect(out.unresolvedCheckpoints).toBe(1)
    expect(out.firstUnresolvedError).toContain("Ambiguous proposal batch")
  })

  it("rejects a v6 call targeting another rollup", async () => {
    const out = await recover(fixture.transaction.input as Hex, "0x0000000000000000000000000000000000000001")
    expect(out.unresolvedCheckpoints).toBe(1)
    expect(out.resolvedCheckpoints).toBe(0)
  })

  it("unwraps aggregate batches and ignores a proposal aimed at another target", async () => {
    const abi = parseAbi(["function aggregate((address target,bytes callData)[] calls) payable"])
    const out = await recover(encodeFunctionData({ abi, functionName: "aggregate", args: [[
      { target: "0x0000000000000000000000000000000000000001", callData: calls[0]!.callData },
      calls[0]!,
    ]] }))
    expect(out.unresolvedCheckpoints).toBe(0)
    expect(out.attributed[0]?.proposer).toBe(fixture.expected.proposer)
  })

  it("leaves truncated v6 calldata unresolved rather than falling back to another ABI", async () => {
    const out = await recover(calls[0]!.callData.slice(0, 100) as Hex)
    expect(out.unresolvedCheckpoints).toBe(1)
    expect(out.attributed).toEqual([])
  })
})

describe("v6 fee-bearing mainnet proposal", () => {
  it("recovers the historical proposer and decodes protocol fee state through the real ABI", async () => {
    const out = await recover(feesFixture.transaction.input as Hex, rollup, feesFixture)
    expect(out.unresolvedCheckpoints).toBe(0)
    expect(out.attributed[0]).toMatchObject({ proposer: feesFixture.expected.proposer,
      coinbase: feesFixture.expected.coinbase, accumulatedFees: BigInt(feesFixture.expected.accumulatedFees), proposalVersion: "v6" })
    const header = feesFixture.expected.feeHeader
    const client = createPublicClient({ transport: custom({ async request({ method }) {
      if (method !== "eth_call") throw new Error(`Unexpected RPC ${method}`)
      return `0x${Object.values(header).map((v) => BigInt(v).toString(16).padStart(64, "0")).join("")}`
    } }) })
    const rewards = await readCheckpointRewards({ client, rollupAddress: rollup,
      checkpoints: [{ ...out.attributed[0]!, delegator: feesFixture.expected.coinbase as Address }],
      sequencerRewardPerCheckpoint: 450n * 10n ** 18n })
    expect(rewards[0]?.sequencerFee).toBe(211555426201881543n)
    expect(rewards[0]?.grossReward).toBe(450211555426201881543n)
  })
})
