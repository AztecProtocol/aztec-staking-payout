import { describe, expect, it } from "vitest"
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  type Address,
  type Hex,
} from "viem"
import {
  GET_EPOCH_FOR_CHECKPOINT_ABI,
  GET_PROVEN_CHECKPOINT_NUMBER_ABI,
  GET_TIMESTAMP_FOR_EPOCH_ABI,
  GET_TIPS_ABI,
  resolveEpochRange,
} from "./epochs.js"

const ROLLUP = getAddress("0x0000000000000000000000000000000000000002") as Address

/**
 * Mock L1 state model:
 *   - `provenTipAtBlock(B)`: highest proven checkpoint at L1 block B (monotone).
 *   - `epochOfCheckpoint(c)`: epoch number for an L2 checkpoint (monotone).
 *   - `finalizedBlock`: current L1 finalized block height.
 *
 * The resolver only calls two view functions plus `getBlock({tag:'finalized'})`,
 * so the mock is small.
 */
interface MockChain {
  finalizedBlock: bigint
  epochOfCheckpoint: (c: bigint) => bigint
  provenTipAtBlock: (B: bigint) => bigint
  /** Pending tip at L1 block B. Defaults to `B` (one proposal per L1 block
   *  from genesis onward — keeps `pending == c` at L1 block `c`, which is
   *  what the safe epoch lookup expects). Override to model an unusual
   *  proposal cadence. */
  pendingTipAtBlock?: (B: bigint) => bigint
  /** L1 timestamp at L1 block B. Defaults to `B` (one tick per block) — pairs
   *  cleanly with the default `getTimestampForEpoch` that returns
   *  `epoch × epochDuration` (32 slots × 1 unit/slot). */
  timestampAtBlock?: (B: bigint) => bigint
  /** L2 timestamp at the start of L2 epoch E. Defaults to `E × 32` — 32
   *  slots per epoch × 1 timestamp unit per slot. */
  timestampForEpoch?: (E: bigint) => bigint
  /** L1 block at which the rollup was deployed. Defaults to 0 (always
   *  deployed). The resolver's auto-detect path uses `eth_getCode` —
   *  `hasCodeAtBlock(B)` is true iff `B >= rollupDeployBlock`. */
  rollupDeployBlock?: bigint
}

function makeMockTransport(chain: MockChain) {
  return custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        switch (method) {
          case "eth_chainId":
            return "0x1"
          case "eth_getCode": {
            const [, blockTag] = params as [string, string]
            const blockNumber = blockTag.startsWith("0x")
              ? BigInt(blockTag)
              : chain.finalizedBlock
            const deployBlock = chain.rollupDeployBlock ?? 0n
            return blockNumber >= deployBlock ? "0x6080604052" : "0x"
          }
          case "eth_getBlockByNumber": {
            const [tag] = params as [string, boolean]
            const blockNumber =
              tag === "finalized"
                ? chain.finalizedBlock
                : tag.startsWith("0x")
                  ? BigInt(tag)
                  : (() => {
                      throw new Error(`mock: unsupported block tag ${tag}`)
                    })()
            const timestampFn = chain.timestampAtBlock ?? ((B: bigint) => B)
            const timestamp = timestampFn(blockNumber)
            return {
              number: `0x${blockNumber.toString(16)}` as Hex,
              hash: `0x${"a".repeat(64)}`,
              parentHash: `0x${"b".repeat(64)}`,
              timestamp: `0x${timestamp.toString(16)}` as Hex,
              gasLimit: "0x0",
              gasUsed: "0x0",
              baseFeePerGas: "0x0",
              difficulty: "0x0",
              extraData: "0x",
              logsBloom: `0x${"0".repeat(512)}`,
              miner: "0x0000000000000000000000000000000000000000",
              mixHash: `0x${"0".repeat(64)}`,
              nonce: "0x0000000000000000",
              receiptsRoot: `0x${"0".repeat(64)}`,
              sha3Uncles: `0x${"0".repeat(64)}`,
              size: "0x0",
              stateRoot: `0x${"0".repeat(64)}`,
              transactionsRoot: `0x${"0".repeat(64)}`,
              transactions: [],
              uncles: [],
              withdrawals: [],
              withdrawalsRoot: `0x${"0".repeat(64)}`,
            }
          }
          case "eth_call": {
            const [{ to, data }, blockTag] = params as [{ to: string; data: Hex }, string]
            if (to.toLowerCase() !== ROLLUP.toLowerCase()) throw new Error(`mock: unexpected call target ${to}`)
            const blockNumber = blockTag.startsWith("0x") ? BigInt(blockTag) : chain.finalizedBlock
            // Try all ABIs and dispatch on the matching selector.
            try {
              const { functionName, args } = decodeFunctionData({
                abi: [
                  ...GET_PROVEN_CHECKPOINT_NUMBER_ABI,
                  ...GET_EPOCH_FOR_CHECKPOINT_ABI,
                  ...GET_TIPS_ABI,
                  ...GET_TIMESTAMP_FOR_EPOCH_ABI,
                ],
                data,
              })
              if (functionName === "getProvenCheckpointNumber") {
                const tip = chain.provenTipAtBlock(blockNumber)
                return encodeAbiParameters([{ type: "uint256" }], [tip])
              }
              if (functionName === "getEpochForCheckpoint") {
                const [c] = args as readonly [bigint]
                return encodeAbiParameters([{ type: "uint256" }], [chain.epochOfCheckpoint(c)])
              }
              if (functionName === "getTips") {
                const pendingFn = chain.pendingTipAtBlock ?? ((B: bigint) => B)
                const pending = pendingFn(blockNumber)
                const proven = chain.provenTipAtBlock(blockNumber)
                return encodeAbiParameters(
                  [
                    {
                      type: "tuple",
                      components: [
                        { name: "pendingCheckpointNumber", type: "uint256" },
                        { name: "provenCheckpointNumber", type: "uint256" },
                      ],
                    },
                  ],
                  [{ pendingCheckpointNumber: pending, provenCheckpointNumber: proven }],
                )
              }
              if (functionName === "getTimestampForEpoch") {
                const [E] = args as readonly [bigint]
                const fn = chain.timestampForEpoch ?? ((e: bigint) => e * 32n)
                return encodeAbiParameters([{ type: "uint256" }], [fn(E)])
              }
            } catch (e) {
              throw new Error(`mock: failed to decode call data: ${(e as Error).message}`)
            }
            throw new Error(`mock: unknown call`)
          }
          default:
            throw new Error(`mock: unsupported method ${method}`)
        }
      },
    },
    { retryCount: 0 },
  )
}

const makeClient = (chain: MockChain) => createPublicClient({ transport: makeMockTransport(chain) })

/**
 * Default mock chain for most tests:
 *   - 32 checkpoints per epoch (the simplest sensible mapping for testing).
 *   - At L1 block B, the proven tip is `(B / 100) * 32 - 1`, i.e. every 100
 *     L1 blocks one full L2 epoch becomes proven. So at L1 block 1000, 10
 *     full epochs (0–9) are proven, tip is checkpoint 319.
 *   - finalized at L1 block 1000 → latest proven epoch is 9.
 */
function defaultChain(overrides: Partial<MockChain> = {}): MockChain {
  return {
    finalizedBlock: 1000n,
    epochOfCheckpoint: (c) => c / 32n,
    // After L1 block 100, epoch 0 is proven; after 200, epoch 1; …
    provenTipAtBlock: (B) => (B >= 100n ? (B / 100n) * 32n - 1n : 0n),
    ...overrides,
  }
}

describe("resolveEpochRange", () => {
  it("resolves a happy-path window to the correct checkpoint range and L1 blocks", async () => {
    const chain = defaultChain()
    const out = await resolveEpochRange({
      client: makeClient(chain),
      rollupAddress: ROLLUP,
      fromEpoch: 3n,
      toEpoch: 5n,
    })

    expect(out.fromEpoch).toBe(3n)
    expect(out.toEpoch).toBe(5n)
    expect(out.latestProvenEpoch).toBe(9n) // tip = 319 → epoch 9
    expect(out.provenCheckpointTip).toBe(319n)
    expect(out.finalizedBlock).toBe(1000n)
    // Epoch 3 starts at checkpoint 96 (= 3*32), epoch 5 ends at checkpoint
    // 191 (= 6*32 - 1).
    expect(out.fromCheckpoint).toBe(96n)
    expect(out.toCheckpoint).toBe(191n)
    // toBlock = first L1 block where tip ≥ 191 → tip becomes 191 at block
    // 600 (epoch 5's proof) → 600 is the answer.
    expect(out.toBlock).toBe(600n)
    // fromBlock = first L1 block where tip ≥ 95 (= fromCheckpoint - 1) → tip
    // becomes 95 only at the L1 block where epoch 2's proof landed = 300.
    expect(out.fromBlock).toBe(300n)
  })

  it("resolves --to-epoch latest-proven against the rollup tip", async () => {
    const chain = defaultChain()
    const out = await resolveEpochRange({
      client: makeClient(chain),
      rollupAddress: ROLLUP,
      fromEpoch: 8n,
      toEpoch: null, // "latest-proven"
    })
    expect(out.toEpoch).toBe(9n)
    expect(out.latestProvenEpoch).toBe(9n)
    // Epoch 8 starts at checkpoint 256, epoch 9 ends at checkpoint 319.
    expect(out.fromCheckpoint).toBe(256n)
    expect(out.toCheckpoint).toBe(319n)
  })

  it("treats fromEpoch == 0 specially: fromBlock = 0 (no prior proof)", async () => {
    const chain = defaultChain()
    const out = await resolveEpochRange({
      client: makeClient(chain),
      rollupAddress: ROLLUP,
      fromEpoch: 0n,
      toEpoch: 2n,
    })
    expect(out.fromBlock).toBe(0n)
    expect(out.fromCheckpoint).toBe(0n)
    expect(out.toCheckpoint).toBe(95n) // 3 * 32 - 1
    // toBlock = first block with tip ≥ 95 = block 300 (where epoch 2's proof landed).
    expect(out.toBlock).toBe(300n)
  })

  it("rejects a toEpoch beyond the latest proven epoch", async () => {
    const chain = defaultChain()
    await expect(
      resolveEpochRange({
        client: makeClient(chain),
        rollupAddress: ROLLUP,
        fromEpoch: 8n,
        toEpoch: 10n, // latestProven is 9
      }),
    ).rejects.toThrow(/not yet proven on L1/)
  })

  it("rejects fromEpoch > toEpoch", async () => {
    const chain = defaultChain()
    await expect(
      resolveEpochRange({
        client: makeClient(chain),
        rollupAddress: ROLLUP,
        fromEpoch: 5n,
        toEpoch: 3n,
      }),
    ).rejects.toThrow(/must be ≥ fromEpoch/)
  })

  it("rejects a chain with no proven checkpoints", async () => {
    const chain = defaultChain({ provenTipAtBlock: () => 0n })
    await expect(
      resolveEpochRange({
        client: makeClient(chain),
        rollupAddress: ROLLUP,
        fromEpoch: 0n,
        toEpoch: null,
      }),
    ).rejects.toThrow(/no proven checkpoints/)
  })

  it("queries getEpochForCheckpoint at the proposal block, not at the finalized block (handles buffer-overflow chains)", async () => {
    // Regression for the testnet bug: when pruning isn't being triggered,
    // pending - proven drifts past the circular-buffer size and
    // `getEpochForCheckpoint(provenTip)` at the finalized block reverts.
    // Our safe lookup queries at the proposal block instead, where
    // pending = c by construction.
    //
    // Model: pending grows by 1 per L1 block from block 50 onward (one
    // proposal per L1 block); proven advances 32 checkpoints every 100 L1
    // blocks (one full epoch proven per ~100 blocks). At any block past
    // proof-landing, pending - proven > 0 and grows steadily — by the
    // finalized block, the gap is huge (hundreds of checkpoints), well past
    // any realistic circular-buffer size.
    const epochOfCheckpoint = (c: bigint) => c / 32n
    const pendingTipAtBlock = (B: bigint) => (B >= 50n ? B - 50n : 0n)
    const provenTipAtBlock = (B: bigint) => (B >= 100n ? (B / 100n) * 32n : 0n)
    const wrappedChain: MockChain = {
      finalizedBlock: 1000n,
      epochOfCheckpoint,
      provenTipAtBlock,
      pendingTipAtBlock,
    }
    // Wire a transport wrapper that mirrors the on-chain revert:
    // `getEpochForCheckpoint(c)` at block B reverts whenever pending(B) - c
    // exceeds a small "circular buffer" size (here: 100). If our safe
    // lookup routes every call through the proposal block, this never fires.
    const SIZE = 100n
    const blockedQueries: { c: bigint; block: bigint; pending: bigint }[] = []
    const inner = makeMockTransport(wrappedChain)
    const recordedClient = createPublicClient({
      transport: custom(
        {
          async request(args: { method: string; params?: unknown }) {
            if (args.method === "eth_call") {
              const [{ data }, blockTag] = args.params as [
                { to: string; data: Hex },
                string,
              ]
              try {
                const { functionName, args: callArgs } = decodeFunctionData({
                  abi: GET_EPOCH_FOR_CHECKPOINT_ABI,
                  data,
                })
                if (functionName === "getEpochForCheckpoint") {
                  const [c] = callArgs as readonly [bigint]
                  const block = blockTag.startsWith("0x")
                    ? BigInt(blockTag)
                    : wrappedChain.finalizedBlock
                  const pending = pendingTipAtBlock(block)
                  if (pending > c + SIZE) {
                    blockedQueries.push({ c, block, pending })
                    throw new Error(
                      `mock revert: getEpochForCheckpoint(${c}) at block ${block} — pending(${pending}) - c = ${pending - c} > size(${SIZE})`,
                    )
                  }
                }
              } catch (e) {
                // Re-throw mock-revert errors so they reach the caller as
                // the actual contract revert would; swallow decode errors
                // (which just mean "not a getEpochForCheckpoint call").
                if ((e as Error).message.startsWith("mock revert:")) throw e
              }
            }
            return inner({ retryCount: 0 }).request(args as { method: string; params?: unknown })
          },
        },
        { retryCount: 0 },
      ),
    })
    // The resolver should succeed: every epoch lookup routes through the
    // proposal block, where pending = c and the buffer-overflow check passes.
    const out = await resolveEpochRange({
      client: recordedClient,
      rollupAddress: ROLLUP,
      fromEpoch: 3n,
      toEpoch: 5n,
    })
    expect(out.fromEpoch).toBe(3n)
    expect(out.toEpoch).toBe(5n)
    expect(blockedQueries).toEqual([])
  })

  it("auto-detects the rollup deploy block when config doesn't pin one", async () => {
    // Chain: rollup deployed at L1 block 30 (well before epoch 3's boundary
    // at L1 block 96), finalized at 1000. The resolver should auto-detect
    // deployBlock=30 via `eth_getCode` binary search and use it as the lower
    // bound for subsequent searches.
    const chain = defaultChain({ rollupDeployBlock: 30n })
    const out = await resolveEpochRange({
      client: makeClient(chain),
      rollupAddress: ROLLUP,
      fromEpoch: 3n,
      toEpoch: 5n,
      // rollupDeployedAtBlock intentionally omitted → triggers auto-detect.
    })
    expect(out.rollupDeployedAtBlock).toBe(30n)
    // Sanity: produces the same checkpoint range as the happy-path test —
    // a tighter lower bound doesn't change the answer, just trims search cost.
    expect(out.fromCheckpoint).toBe(96n)
    expect(out.toCheckpoint).toBe(191n)
  })

  it("uses the pinned rollup deploy block instead of auto-detecting", async () => {
    // Mock chain has rollup deployed at L1 block 30; we pin a different
    // value (50) and verify the resolver uses it as-is. 50 is still ≤ the
    // epoch boundaries (96 and 192) so the resolution math is unaffected.
    const chain = defaultChain({ rollupDeployBlock: 30n })
    const out = await resolveEpochRange({
      client: makeClient(chain),
      rollupAddress: ROLLUP,
      fromEpoch: 3n,
      toEpoch: 5n,
      rollupDeployedAtBlock: 50n,
    })
    expect(out.rollupDeployedAtBlock).toBe(50n)
    expect(out.fromCheckpoint).toBe(96n)
    expect(out.toCheckpoint).toBe(191n)
  })

  it("rejects when the RPC returns a null finalized block (non-finalizing chain)", async () => {
    // Override the eth_getBlockByNumber response to return number: null,
    // simulating an anvil/devnet that doesn't expose finality.
    const transport = custom(
      {
        async request({ method }: { method: string }) {
          if (method === "eth_chainId") return "0x1"
          if (method === "eth_getBlockByNumber") {
            return { number: null, hash: `0x${"a".repeat(64)}` }
          }
          throw new Error(`mock: unsupported method ${method}`)
        },
      },
      { retryCount: 0 },
    )
    const client = createPublicClient({ transport })
    await expect(
      resolveEpochRange({
        client,
        rollupAddress: ROLLUP,
        fromEpoch: 0n,
        toEpoch: 1n,
      }),
    ).rejects.toThrow(/Casper finality/)
  })
})
