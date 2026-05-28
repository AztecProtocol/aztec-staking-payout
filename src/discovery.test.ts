import { describe, expect, it } from "vitest"
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem"
import {
  BONUS_INSTANCE_ADDRESS,
  SPLIT_CREATED_EVENT,
  STAKED_WITH_PROVIDER_EVENT,
  discoverActiveDelegators,
  findDeployBlock,
} from "./discovery.js"

const STAKING_REGISTRY = getAddress("0x0000000000000000000000000000000000000001") as Address
const ROLLUP = getAddress("0x0000000000000000000000000000000000000002") as Address
const GSE = getAddress("0x0000000000000000000000000000000000000003") as Address
const PULL_SPLIT_FACTORY = getAddress("0x0000000000000000000000000000000000000004") as Address
const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11") as Address
// The canonical GSE bonus-instance address (keccak256("bonus-instance"))[12:],
// matching the production constant so the isRegistered mock + production agree.
const BONUS_INSTANCE = BONUS_INSTANCE_ADDRESS
const PROVIDER_REWARDS_RECIPIENT = getAddress("0x00000000000000000000000000000000000000Aa") as Address

const addr = (hex: string) => getAddress(`0x${hex.padEnd(40, "0")}`) as Address

interface StakeFixture {
  attester: Address
  /** msg.sender of stake(). */
  staker: Address
  /** _userRewardsRecipient baked into the split. If unset, no SplitCreated
   *  event is emitted for this stake (simulating the fallback case). */
  userRewardsRecipient?: Address
  split: Address
  blockNumber: bigint
  /** Currently registered in GSE? */
  active: boolean
  /** If active: registered under the bonus instance (moveWithLatestRollup
   *  =true, the default/common case) vs the rollup instance (=false). */
  viaBonus?: boolean
}

const IS_REGISTERED_ABI = [
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

const AGGREGATE3_ABI = [
  {
    name: "aggregate3",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const

const ADDR_RESULT_ABI = (name: string) =>
  [
    {
      name,
      type: "function",
      stateMutability: "view",
      inputs: [],
      outputs: [{ name: "", type: "address" }],
    },
  ] as const

function makeMockTransport(fixtures: StakeFixture[]) {
  const getGSESelector = toFunctionSelector("function getGSE() view returns (address)").toLowerCase()
  const bonusSelector = toFunctionSelector(
    "function getBonusInstanceAddress() view returns (address)",
  ).toLowerCase()
  const pullSplitFactorySelector = toFunctionSelector(
    "function PULL_SPLIT_FACTORY() view returns (address)",
  ).toLowerCase()
  const isRegisteredSelector = toFunctionSelector(
    "function isRegistered(address,address) view returns (bool)",
  ).toLowerCase()
  const aggregate3Selector = toFunctionSelector(
    "function aggregate3((address,bool,bytes)[]) returns ((bool,bytes)[])",
  ).toLowerCase()

  const stakeEventTopic0 = encodeEventTopics({ abi: [STAKED_WITH_PROVIDER_EVENT] })[0]
  const splitEventTopic0 = encodeEventTopics({ abi: [SPLIT_CREATED_EVENT] })[0]

  // Each stake fixture gets a deterministic tx hash derived from its (unique)
  // split address, so the receipt lookup can find it.
  const txHashFor = (f: StakeFixture): Hex => `0x${f.split.slice(2).toLowerCase().padEnd(64, "0")}` as Hex

  // The SplitCreated log the StakingRegistry emits in the same tx as the stake.
  const splitCreatedLog = (f: StakeFixture) => ({
    address: PULL_SPLIT_FACTORY.toLowerCase(),
    topics: encodeEventTopics({ abi: [SPLIT_CREATED_EVENT], args: { split: f.split } }),
    data: encodeAbiParameters(
      [
        {
          name: "splitParams",
          type: "tuple",
          components: [
            { name: "recipients", type: "address[]" },
            { name: "allocations", type: "uint256[]" },
            { name: "totalAllocation", type: "uint256" },
            { name: "distributionIncentive", type: "uint16" },
          ],
        },
        { name: "owner", type: "address" },
        { name: "creator", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
      [
        {
          recipients: [PROVIDER_REWARDS_RECIPIENT, f.userRewardsRecipient!],
          allocations: [500n, 9500n],
          totalAllocation: 10000n,
          distributionIncentive: 0,
        },
        "0x0000000000000000000000000000000000000000",
        STAKING_REGISTRY,
        0n,
      ],
    ),
    blockNumber: `0x${f.blockNumber.toString(16)}`,
    blockHash: `0x${"a".repeat(64)}`,
    transactionHash: txHashFor(f),
    transactionIndex: "0x0",
    logIndex: "0x1",
    removed: false,
  })

  // Dispatch a single eth_call (target + calldata) → ABI-encoded hex result.
  function singleCall(to: string, data: Hex): Hex {
    const toL = to.toLowerCase()
    const sel = data.slice(0, 10).toLowerCase()
    if (toL === ROLLUP.toLowerCase() && sel === getGSESelector) {
      return encodeFunctionResult({ abi: ADDR_RESULT_ABI("getGSE"), functionName: "getGSE", result: GSE })
    }
    if (toL === GSE.toLowerCase() && sel === bonusSelector) {
      return encodeFunctionResult({
        abi: ADDR_RESULT_ABI("getBonusInstanceAddress"),
        functionName: "getBonusInstanceAddress",
        result: BONUS_INSTANCE,
      })
    }
    if (toL === STAKING_REGISTRY.toLowerCase() && sel === pullSplitFactorySelector) {
      return encodeFunctionResult({
        abi: ADDR_RESULT_ABI("PULL_SPLIT_FACTORY"),
        functionName: "PULL_SPLIT_FACTORY",
        result: PULL_SPLIT_FACTORY,
      })
    }
    if (toL === GSE.toLowerCase() && sel === isRegisteredSelector) {
      const { args } = decodeFunctionData({ abi: IS_REGISTERED_ABI, data })
      const [instance, attester] = args as readonly [Address, Address]
      const fix = fixtures.find((f) => f.attester.toLowerCase() === attester.toLowerCase())
      let registered = false
      if (fix?.active) {
        const viaBonus = fix.viaBonus !== false // default true
        if (instance.toLowerCase() === ROLLUP.toLowerCase()) registered = !viaBonus
        else if (instance.toLowerCase() === BONUS_INSTANCE.toLowerCase()) registered = viaBonus
      }
      return encodeFunctionResult({ abi: IS_REGISTERED_ABI, functionName: "isRegistered", result: registered })
    }
    throw new Error(`mock: unexpected eth_call to ${to} with data ${data}`)
  }

  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      switch (method) {
        case "eth_chainId":
          return "0x1"
        case "eth_blockNumber":
          return "0x1000"
        case "eth_getLogs": {
          const filter = (params as Array<{
            address?: string
            fromBlock: Hex
            toBlock: Hex
            topics: (Hex | Hex[] | null)[]
          }>)[0]!
          const from = BigInt(filter.fromBlock)
          const to = BigInt(filter.toBlock)
          const addressLower = filter.address?.toLowerCase()
          const topic0 = filter.topics[0] as Hex | undefined

          if (addressLower === STAKING_REGISTRY.toLowerCase() && topic0 === stakeEventTopic0) {
            return fixtures
              .filter((f) => f.blockNumber >= from && f.blockNumber <= to)
              .map((f) => {
                const topics = encodeEventTopics({
                  abi: [STAKED_WITH_PROVIDER_EVENT],
                  args: { providerIdentifier: 42n, rollupAddress: ROLLUP, attester: f.attester },
                })
                const data = encodeAbiParameters(
                  [
                    { name: "coinbaseSplitContractAddress", type: "address" },
                    { name: "stakerImplementation", type: "address" },
                  ],
                  [f.split, f.staker],
                )
                return {
                  address: STAKING_REGISTRY.toLowerCase(),
                  topics,
                  data,
                  blockNumber: `0x${f.blockNumber.toString(16)}`,
                  blockHash: `0x${"a".repeat(64)}`,
                  transactionHash: txHashFor(f),
                  transactionIndex: "0x0",
                  logIndex: "0x0",
                  removed: false,
                }
              })
          }

          return []
        }
        case "eth_getTransactionReceipt": {
          const hash = (params as [Hex])[0]
          // The stake tx's receipt carries the SplitCreated log (only when the
          // fixture defines a userRewardsRecipient — else fallback to staker).
          const logs = fixtures
            .filter((f) => txHashFor(f) === hash && f.userRewardsRecipient !== undefined)
            .map((f) => splitCreatedLog(f))
          return {
            transactionHash: hash,
            status: "0x1",
            logs,
            blockNumber: "0x1",
            blockHash: `0x${"a".repeat(64)}`,
            transactionIndex: "0x0",
            from: STAKING_REGISTRY.toLowerCase(),
            to: STAKING_REGISTRY.toLowerCase(),
            cumulativeGasUsed: "0x0",
            gasUsed: "0x0",
            contractAddress: null,
            logsBloom: `0x${"0".repeat(512)}`,
            effectiveGasPrice: "0x0",
            type: "0x2",
          }
        }
        case "eth_call": {
          const call = (params as Array<{ to: string; data: Hex }>)[0]!
          const data = call.data
          // Multicall3.aggregate3 → decode inner calls, dispatch each, wrap.
          if (
            call.to.toLowerCase() === MULTICALL3.toLowerCase() &&
            data.slice(0, 10).toLowerCase() === aggregate3Selector
          ) {
            const { args } = decodeFunctionData({ abi: AGGREGATE3_ABI, data })
            const calls = args[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[]
            const returnData = calls.map((c) => {
              try {
                return { success: true, returnData: singleCall(c.target, c.callData) }
              } catch (e) {
                if (!c.allowFailure) throw e
                return { success: false, returnData: "0x" as Hex }
              }
            })
            return encodeFunctionResult({ abi: AGGREGATE3_ABI, functionName: "aggregate3", result: returnData })
          }
          return singleCall(call.to, data)
        }
        default:
          throw new Error(`mock: unsupported method ${method}`)
      }
    },
  }, { retryCount: 0 })
}

function makeClient(fixtures: StakeFixture[]) {
  return createPublicClient({ transport: makeMockTransport(fixtures) })
}

describe("discoverActiveDelegators", () => {
  it("uses recipients[1] from SplitCreated as the delegator (preferred path)", async () => {
    const fixtures: StakeFixture[] = [
      {
        attester: addr("a1"),
        staker: addr("d1"),
        userRewardsRecipient: addr("e1"), // different from staker
        split: addr("51"),
        blockNumber: 100n,
        active: true,
      },
    ]
    const client = makeClient(fixtures)
    const { delegators: out } = await discoverActiveDelegators({
      client,
      stakingRegistryAddress: STAKING_REGISTRY,
      rollupAddress: ROLLUP,
      multicallAddress: MULTICALL3,
      providerId: 42n,
      fromBlock: 0n,
      toBlock: 1000n,
      logChunkSize: 10000n,
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.delegator).toBe(addr("e1"))
    expect(out[0]?.delegatorSource).toBe("split-recipient")
    expect(out[0]?.staker).toBe(addr("d1"))
  })

  it("falls back to msg.sender (staker) when no SplitCreated event found", async () => {
    const fixtures: StakeFixture[] = [
      {
        attester: addr("a1"),
        staker: addr("d1"),
        // userRewardsRecipient omitted → mock doesn't emit SplitCreated
        split: addr("51"),
        blockNumber: 100n,
        active: true,
      },
    ]
    const client = makeClient(fixtures)
    const { delegators: out } = await discoverActiveDelegators({
      client,
      stakingRegistryAddress: STAKING_REGISTRY,
      rollupAddress: ROLLUP,
      multicallAddress: MULTICALL3,
      providerId: 42n,
      fromBlock: 0n,
      toBlock: 1000n,
      logChunkSize: 10000n,
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.delegator).toBe(addr("d1"))
    expect(out[0]?.delegatorSource).toBe("msg.sender")
    expect(out[0]?.staker).toBe(addr("d1"))
  })

  it("handles mixed cases: some with split-recipient, some with fallback", async () => {
    const fixtures: StakeFixture[] = [
      {
        attester: addr("a1"),
        staker: addr("d1"),
        userRewardsRecipient: addr("e1"),
        split: addr("51"),
        blockNumber: 100n,
        active: true,
      },
      {
        attester: addr("a2"),
        staker: addr("d2"),
        // No split-created event → fallback to msg.sender
        split: addr("52"),
        blockNumber: 200n,
        active: true,
      },
    ]
    const client = makeClient(fixtures)
    const { delegators: out } = await discoverActiveDelegators({
      client,
      stakingRegistryAddress: STAKING_REGISTRY,
      rollupAddress: ROLLUP,
      multicallAddress: MULTICALL3,
      providerId: 42n,
      fromBlock: 0n,
      toBlock: 1000n,
      logChunkSize: 10000n,
    })
    expect(out).toHaveLength(2)
    expect(out[0]?.delegator).toBe(addr("e1"))
    expect(out[0]?.delegatorSource).toBe("split-recipient")
    expect(out[1]?.delegator).toBe(addr("d2"))
    expect(out[1]?.delegatorSource).toBe("msg.sender")
  })

  it("filters out attesters not currently registered in GSE", async () => {
    const fixtures: StakeFixture[] = [
      {
        attester: addr("a1"),
        staker: addr("d1"),
        userRewardsRecipient: addr("e1"),
        split: addr("51"),
        blockNumber: 100n,
        active: true,
      },
      {
        attester: addr("a2"),
        staker: addr("d2"),
        userRewardsRecipient: addr("e2"),
        split: addr("52"),
        blockNumber: 200n,
        active: false,
      },
      {
        attester: addr("a3"),
        staker: addr("d3"),
        userRewardsRecipient: addr("e3"),
        split: addr("53"),
        blockNumber: 300n,
        active: true,
      },
    ]
    const client = makeClient(fixtures)
    const { delegators: out } = await discoverActiveDelegators({
      client,
      stakingRegistryAddress: STAKING_REGISTRY,
      rollupAddress: ROLLUP,
      multicallAddress: MULTICALL3,
      providerId: 42n,
      fromBlock: 0n,
      toBlock: 1000n,
      logChunkSize: 10000n,
    })
    expect(out).toHaveLength(2)
    expect(out.map((d) => d.attester)).toEqual([addr("a1"), addr("a3")])
    expect(out.map((d) => d.delegator)).toEqual([addr("e1"), addr("e3")])
  })

  it("returns empty list when no stake events found", async () => {
    const client = makeClient([])
    const { delegators: out } = await discoverActiveDelegators({
      client,
      stakingRegistryAddress: STAKING_REGISTRY,
      rollupAddress: ROLLUP,
      multicallAddress: MULTICALL3,
      providerId: 42n,
      fromBlock: 0n,
      toBlock: 1000n,
      logChunkSize: 10000n,
    })
    expect(out).toEqual([])
  })

  it("returns results sorted by stake block (ascending)", async () => {
    const lateAtt = addr("af")
    const earlyAtt = addr("a1")
    const fixtures: StakeFixture[] = [
      {
        attester: lateAtt,
        staker: addr("df"),
        userRewardsRecipient: addr("ef"),
        split: addr("5f"),
        blockNumber: 500n,
        active: true,
      },
      {
        attester: earlyAtt,
        staker: addr("d1"),
        userRewardsRecipient: addr("e1"),
        split: addr("51"),
        blockNumber: 100n,
        active: true,
      },
    ]
    const client = makeClient(fixtures)
    const { delegators: out } = await discoverActiveDelegators({
      client,
      stakingRegistryAddress: STAKING_REGISTRY,
      rollupAddress: ROLLUP,
      multicallAddress: MULTICALL3,
      providerId: 42n,
      fromBlock: 0n,
      toBlock: 1000n,
      logChunkSize: 10000n,
    })
    expect(out.map((d) => d.attester)).toEqual([earlyAtt, lateAtt])
  })

  it("dedupes by attester across multiple stake events (latest wins)", async () => {
    const fixtures: StakeFixture[] = [
      {
        attester: addr("a1"),
        staker: addr("d1"),
        userRewardsRecipient: addr("e1"),
        split: addr("51"),
        blockNumber: 100n,
        active: true,
      },
      {
        attester: addr("a1"),
        staker: addr("d1b"),
        userRewardsRecipient: addr("e1b"),
        split: addr("51b"),
        blockNumber: 500n,
        active: true,
      },
    ]
    const client = makeClient(fixtures)
    const { delegators: out } = await discoverActiveDelegators({
      client,
      stakingRegistryAddress: STAKING_REGISTRY,
      rollupAddress: ROLLUP,
      multicallAddress: MULTICALL3,
      providerId: 42n,
      fromBlock: 0n,
      toBlock: 1000n,
      logChunkSize: 10000n,
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.delegator).toBe(addr("e1b"))
    expect(out[0]?.stakedAtBlock).toBe(500n)
  })

  it("chunks the eth_getLogs scan to respect logChunkSize", async () => {
    const fixtures: StakeFixture[] = [
      {
        attester: addr("a1"),
        staker: addr("d1"),
        userRewardsRecipient: addr("e1"),
        split: addr("51"),
        blockNumber: 50n,
        active: true,
      },
      {
        attester: addr("a2"),
        staker: addr("d2"),
        userRewardsRecipient: addr("e2"),
        split: addr("52"),
        blockNumber: 1500n,
        active: true,
      },
      {
        attester: addr("a3"),
        staker: addr("d3"),
        userRewardsRecipient: addr("e3"),
        split: addr("53"),
        blockNumber: 2500n,
        active: true,
      },
    ]
    const client = makeClient(fixtures)
    const { delegators: out } = await discoverActiveDelegators({
      client,
      stakingRegistryAddress: STAKING_REGISTRY,
      rollupAddress: ROLLUP,
      multicallAddress: MULTICALL3,
      providerId: 42n,
      fromBlock: 0n,
      toBlock: 3000n,
      logChunkSize: 1000n,
    })
    expect(out).toHaveLength(3)
    expect(out.map((d) => d.delegator)).toEqual([addr("e1"), addr("e2"), addr("e3")])
  })

  it("emits progress events through all three phases", async () => {
    const fixtures: StakeFixture[] = [
      {
        attester: addr("a1"),
        staker: addr("d1"),
        userRewardsRecipient: addr("e1"),
        split: addr("51"),
        blockNumber: 50n,
        active: true,
      },
      {
        attester: addr("a2"),
        staker: addr("d2"),
        userRewardsRecipient: addr("e2"),
        split: addr("52"),
        blockNumber: 1500n,
        active: true,
      },
    ]
    const client = makeClient(fixtures)
    const phases = new Set<string>()
    await discoverActiveDelegators({
      client,
      stakingRegistryAddress: STAKING_REGISTRY,
      rollupAddress: ROLLUP,
      multicallAddress: MULTICALL3,
      providerId: 42n,
      fromBlock: 0n,
      toBlock: 3000n,
      logChunkSize: 1000n,
      onProgress: (p) => phases.add(p.phase),
    })
    expect(phases.has("scanning-stakes")).toBe(true)
    expect(phases.has("resolving-splits")).toBe(true)
    expect(phases.has("checking-attesters")).toBe(true)
  })
})

describe("findDeployBlock", () => {
  // Mock transport: address has code at/after `deployedAt`, empty before.
  function makeCodeClient(deployedAt: bigint) {
    const transport = custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === "eth_getCode") {
          const blockTag = (params as [string, string])[1]
          const block = BigInt(blockTag)
          return block >= deployedAt ? "0x60806040" : "0x"
        }
        throw new Error(`mock: unsupported ${method}`)
      },
    })
    return createPublicClient({ transport })
  }

  it("pins the exact deploy block via binary search", async () => {
    const client = makeCodeClient(24_800_000n)
    const found = await findDeployBlock(client, addr("a1"), 25_184_582n)
    expect(found).toBe(24_800_000n)
  })

  it("finds block 0 when code exists from genesis", async () => {
    const client = makeCodeClient(0n)
    const found = await findDeployBlock(client, addr("a1"), 1_000_000n)
    expect(found).toBe(0n)
  })

  it("throws when there is no code at head (wrong address)", async () => {
    const client = makeCodeClient(50n)
    await expect(findDeployBlock(client, addr("a1"), 40n)).rejects.toThrow(/No contract code/)
  })
})
