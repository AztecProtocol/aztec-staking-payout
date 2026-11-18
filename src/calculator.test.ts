import { describe, expect, it, vi } from "vitest"
import {
  CallExecutionError,
  ExecutionRevertedError,
  InvalidInputRpcError,
  decodeFunctionData,
  encodeFunctionResult,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import {
  CALCULATOR_ABI,
  CALCULATOR_GAS_BASE,
  CALCULATOR_GAS_PER_CHECKPOINT,
  ethCallGasLimit,
  readCalculatorRewards,
} from "./calculator.js"

const rollup = "0x0000000000000000000000000000000000000022" as Address
const calculator = "0x0000000000000000000000000000000000000033" as Address
const alice = "0x0000000000000000000000000000000000000044" as Address
const bob = "0x0000000000000000000000000000000000000055" as Address
const carol = "0x0000000000000000000000000000000000000066" as Address
const hash = `0x${"a".repeat(64)}` as Hex
const DEFAULT = 450n

const checkpoint = (checkpointNumber: bigint, blockNumber: bigint, proposer: Address) => ({
  checkpointNumber, blockNumber, proposer, coinbase: "0x0000000000000000000000000000000000000099" as Address,
  logIndex: 0, txHash: hash,
})

/** Errors as viem's `client.call` actually throws them, not as `readContract` does. */
const reverted = () => new CallExecutionError(
  new ExecutionRevertedError({ message: "execution reverted" }), {},
)
const outOfGas = () => new CallExecutionError(
  new InvalidInputRpcError(Object.assign(new Error("out of gas"), { code: -32000 } as never)), {},
)

const encodeRewards = (rewards: readonly bigint[]): Hex =>
  encodeFunctionResult({ abi: CALCULATOR_ABI, functionName: "getSequencerRewards", result: rewards })

function fixture(options: {
  proofs: Array<{ tip: bigint; block: bigint }>
  rewards?: (proposers: readonly Address[]) => Hex
  calculatorError?: Error
  calculatorEvents?: Array<{ block: bigint }>
}) {
  const getLogs = vi.fn(async (query: { address?: Address; event?: { name: string }; fromBlock: bigint; toBlock: bigint }) => {
    if (query.address === calculator && !query.event) {
      return (options.calculatorEvents ?? [])
        .filter((e) => e.block >= query.fromBlock && e.block <= query.toBlock)
        .map((e) => ({ blockNumber: e.block, args: {} }))
    }
    if (query.event?.name === "L2ProofVerified") {
      return options.proofs
        .filter((p) => p.block >= query.fromBlock && p.block <= query.toBlock)
        .map((p) => ({ blockNumber: p.block, args: { checkpointNumber: p.tip } }))
    }
    return []
  })
  const readContract = vi.fn(async () => 7n)
  const call = vi.fn(async (request: { data: Hex; blockNumber?: bigint; gas?: bigint }) => {
    if (options.calculatorError) throw options.calculatorError
    const { args } = decodeFunctionData({ abi: CALCULATOR_ABI, data: request.data })
    return { data: options.rewards?.(args[1] as readonly Address[]) }
  })
  const client = { getLogs, readContract, call } as unknown as PublicClient
  return { client, getLogs, readContract, call }
}

const baseInput = (client: PublicClient, checkpoints: ReturnType<typeof checkpoint>[]) => ({
  client, rollupAddress: rollup, calculator,
  checkpoints, defaultReward: DEFAULT, checkpointReward: 500n,
  fromBlock: 90n, toBlock: 200n, logChunkSize: 50n,
})

describe("sequencer reward calculator", () => {
  it("calls each proof with every newly proven proposer, all providers, in checkpoint order", async () => {
    // Carol is another provider's proposer on a checkpoint the wallet never sees.
    const ours = [checkpoint(10n, 100n, alice), checkpoint(11n, 101n, bob)]
    const other = checkpoint(12n, 102n, carol)
    const { client, readContract, call } = fixture({
      proofs: [{ tip: 9n, block: 95n }, { tip: 12n, block: 120n }],
      rewards: (proposers) => encodeRewards(proposers.map((p) => (p === alice ? 0n : 450n))),
    })
    const rewards = await readCalculatorRewards(baseInput(client, [...ours, other]))

    expect([...rewards.entries()]).toEqual([[10n, 0n], [11n, 450n], [12n, 450n]])
    expect(call).toHaveBeenCalledTimes(1)
    const request = call.mock.calls[0]![0]
    expect(request.blockNumber).toBe(120n)
    const { args } = decodeFunctionData({ abi: CALCULATOR_ABI, data: request.data })
    expect(args[1]).toEqual([alice, bob, carol])
    // Exactly the rollup's stipend reaches the callee after intrinsic + calldata gas.
    const stipend = CALCULATOR_GAS_BASE + CALCULATOR_GAS_PER_CHECKPOINT * 3n
    expect(request.gas).toBe(ethCallGasLimit(request.data, stipend))
    // The epoch is read at the proposal block, where the slot buffer still holds it.
    expect(readContract.mock.calls[0]![0]).toMatchObject({ args: [12n], blockNumber: 102n })
  })

  it("splits checkpoints by the proof that covered them", async () => {
    const { client, call } = fixture({
      proofs: [{ tip: 5n, block: 100n }, { tip: 9n, block: 150n }],
      rewards: () => encodeRewards([DEFAULT]),
    })
    await readCalculatorRewards(baseInput(client, [checkpoint(3n, 80n, alice), checkpoint(7n, 140n, bob)]))
    expect(call.mock.calls.map(([r]) => r.blockNumber)).toEqual([100n, 150n])
  })

  it("pays the default when the calculator reverts, as the rollup does", async () => {
    const { client } = fixture({
      proofs: [{ tip: 10n, block: 100n }], calculatorError: reverted(),
    })
    const rewards = await readCalculatorRewards(baseInput(client, [checkpoint(10n, 90n, alice)]))
    expect([...rewards.values()]).toEqual([DEFAULT])
  })

  it("pays the default when the calculator exhausts the stipend", async () => {
    const { client } = fixture({
      proofs: [{ tip: 10n, block: 100n }], calculatorError: outOfGas(),
    })
    const rewards = await readCalculatorRewards(baseInput(client, [checkpoint(10n, 90n, alice)]))
    expect([...rewards.values()]).toEqual([DEFAULT])
  })

  it("rejects malformed or out-of-bounds responses by falling back to the default", async () => {
    // A response sized for a different proposer count than the proof's.
    const short = fixture({ proofs: [{ tip: 10n, block: 100n }], rewards: () => "0x1234" })
    expect([...(await readCalculatorRewards(baseInput(short.client, [checkpoint(10n, 90n, alice)]))).values()])
      .toEqual([DEFAULT])

    const huge = fixture({ proofs: [{ tip: 10n, block: 100n }], rewards: () => encodeRewards([10n ** 30n]) })
    expect([...(await readCalculatorRewards(baseInput(huge.client, [checkpoint(10n, 90n, alice)]))).values()])
      .toEqual([DEFAULT])
  })

  it("rethrows transport failures instead of silently paying the default", async () => {
    const { client } = fixture({ proofs: [{ tip: 10n, block: 100n }], calculatorError: new Error("ECONNRESET") })
    await expect(readCalculatorRewards(baseInput(client, [checkpoint(10n, 90n, alice)])))
      .rejects.toThrow(/ECONNRESET/)
  })

  it("refuses a checkpoint that no proof covers", async () => {
    const { client } = fixture({ proofs: [{ tip: 5n, block: 100n }], rewards: () => encodeRewards([DEFAULT]) })
    await expect(readCalculatorRewards(baseInput(client, [checkpoint(10n, 90n, alice)])))
      .rejects.toThrow(/No L2ProofVerified event covers checkpoint 10/)
  })

  it("refuses a window when the calculator changes state in a paying proof's block", async () => {
    const { client } = fixture({
      proofs: [{ tip: 10n, block: 100n }],
      rewards: () => encodeRewards([DEFAULT]),
      calculatorEvents: [{ block: 100n }],
    })
    await expect(readCalculatorRewards(baseInput(client, [checkpoint(10n, 90n, alice)])))
      .rejects.toThrow(/same block as an epoch proof paying this window/)
  })
})
