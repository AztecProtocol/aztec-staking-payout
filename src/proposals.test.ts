import { describe, expect, it } from "vitest"
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  hashMessage,
  keccak256,
  parseSignature,
  type Address,
  type Hex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { CHECKPOINT_PROPOSED_EVENT, countProposalsByProposer } from "./proposals.js"

const ROLLUP = getAddress("0x0000000000000000000000000000000000000002") as Address
const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11") as Address
const ZERO32 = `0x${"0".repeat(64)}` as Hex
const DOMAIN_ATTESTATIONS_AND_SIGNERS = 2

const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex
const KEY_A = key(0xa11ce)
const KEY_B = key(0xb0b)
const KEY_C = key(0xca401)

const ATTEST_TUPLE = {
  type: "tuple",
  components: [
    { name: "signatureIndices", type: "bytes" },
    { name: "signaturesOrAddresses", type: "bytes" },
  ],
} as const

// Mirror of proposals.ts PROPOSE_ABI (kept local so the test pins the shape).
const PROPOSE_ABI = [
  {
    name: "propose",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "_args",
        type: "tuple",
        components: [
          { name: "archive", type: "bytes32" },
          { name: "oracleInput", type: "tuple", components: [{ name: "feeAssetPriceModifier", type: "int256" }] },
          {
            name: "header",
            type: "tuple",
            components: [
              { name: "lastArchiveRoot", type: "bytes32" },
              { name: "blockHeadersHash", type: "bytes32" },
              { name: "blobsHash", type: "bytes32" },
              { name: "inHash", type: "bytes32" },
              { name: "outHash", type: "bytes32" },
              { name: "slotNumber", type: "uint256" },
              { name: "timestamp", type: "uint256" },
              { name: "coinbase", type: "address" },
              { name: "feeRecipient", type: "bytes32" },
              {
                name: "gasFees",
                type: "tuple",
                components: [
                  { name: "feePerDaGas", type: "uint128" },
                  { name: "feePerL2Gas", type: "uint128" },
                ],
              },
              { name: "totalManaUsed", type: "uint256" },
            ],
          },
        ],
      },
      {
        name: "_attestations",
        type: "tuple",
        components: [
          { name: "signatureIndices", type: "bytes" },
          { name: "signaturesOrAddresses", type: "bytes" },
        ],
      },
      { name: "_signers", type: "address[]" },
      {
        name: "_attestationsAndSignersSignature",
        type: "tuple",
        components: [
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
      { name: "_blobInput", type: "bytes" },
    ],
    outputs: [],
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
    outputs: [],
  },
] as const

/** Wrap a propose() calldata in a Multicall3 aggregate3 batch (with an
 *  unrelated decoy call first), as sequencers do on-chain. */
function wrapInAggregate3(proposeCalldata: Hex): Hex {
  return encodeFunctionData({
    abi: AGGREGATE3_ABI,
    functionName: "aggregate3",
    args: [
      [
        { target: "0x0000000000000000000000000000000000000009" as Address, allowFailure: true, callData: "0xdeadbeef" as Hex },
        { target: ROLLUP, allowFailure: false, callData: proposeCalldata },
      ],
    ],
  })
}

const ZERO_ARGS = {
  archive: ZERO32,
  oracleInput: { feeAssetPriceModifier: 0n },
  header: {
    lastArchiveRoot: ZERO32,
    blockHeadersHash: ZERO32,
    blobsHash: ZERO32,
    inHash: ZERO32,
    outHash: ZERO32,
    slotNumber: 0n,
    timestamp: 0n,
    coinbase: "0x0000000000000000000000000000000000000000" as Address,
    feeRecipient: ZERO32,
    gasFees: { feePerDaGas: 0n, feePerL2Gas: 0n },
    totalManaUsed: 0n,
  },
} as const

// Mirror of proposals.ts PROPOSE_ABI_V5 — the v5 rollup (AZUP-2) appended
// `accumulatedFees` to the header, changing the propose() selector.
const PROPOSE_ABI_V5 = [
  {
    name: "propose",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "_args",
        type: "tuple",
        components: [
          { name: "archive", type: "bytes32" },
          { name: "oracleInput", type: "tuple", components: [{ name: "feeAssetPriceModifier", type: "int256" }] },
          {
            name: "header",
            type: "tuple",
            components: [
              { name: "lastArchiveRoot", type: "bytes32" },
              { name: "blockHeadersHash", type: "bytes32" },
              { name: "blobsHash", type: "bytes32" },
              { name: "inHash", type: "bytes32" },
              { name: "outHash", type: "bytes32" },
              { name: "slotNumber", type: "uint256" },
              { name: "timestamp", type: "uint256" },
              { name: "coinbase", type: "address" },
              { name: "feeRecipient", type: "bytes32" },
              {
                name: "gasFees",
                type: "tuple",
                components: [
                  { name: "feePerDaGas", type: "uint128" },
                  { name: "feePerL2Gas", type: "uint128" },
                ],
              },
              { name: "totalManaUsed", type: "uint256" },
              { name: "accumulatedFees", type: "uint256" },
            ],
          },
        ],
      },
      {
        name: "_attestations",
        type: "tuple",
        components: [
          { name: "signatureIndices", type: "bytes" },
          { name: "signaturesOrAddresses", type: "bytes" },
        ],
      },
      { name: "_signers", type: "address[]" },
      {
        name: "_attestationsAndSignersSignature",
        type: "tuple",
        components: [
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
      { name: "_blobInput", type: "bytes" },
    ],
    outputs: [],
  },
] as const

interface Built {
  checkpointNumber: bigint
  blockNumber: bigint
  txHash: Hex
  proposer: Address
  coinbase: Address
  calldata: Hex
}

/** Build a checkpoint whose propose() calldata is genuinely signed by `privKey`,
 *  so the proposer recovery exercises real ECDSA. `version` selects the
 *  propose format and matching signature scheme:
 *   - v4: EIP-191 message over the domain-enum-prefixed hash.
 *   - v5: header carries `accumulatedFees`; proposer signs EIP-712 typed data
 *     bound to the rollup + chain (raw-digest recovery, no EIP-191 prefix) —
 *     mirroring CoordinationSignatureLib.attestationsAndSignersDigest. */
async function buildCheckpoint(
  privKey: Hex,
  checkpointNumber: bigint,
  blockNumber: bigint,
  wrap = false,
  coinbase: Address = "0x0000000000000000000000000000000000000000" as Address,
  version: "v4" | "v5" = "v4",
): Promise<Built> {
  const account = privateKeyToAccount(privKey)
  const attestations = { signatureIndices: "0x00" as Hex, signaturesOrAddresses: "0x" as Hex }
  const signers: Address[] = []
  const sigHex =
    version === "v4"
      ? await account.signMessage({
          message: {
            raw: keccak256(
              encodeAbiParameters(
                [{ type: "uint8" }, ATTEST_TUPLE, { type: "address[]" }],
                [DOMAIN_ATTESTATIONS_AND_SIGNERS, attestations, signers],
              ),
            ),
          },
        })
      : await account.signTypedData({
          domain: { name: "Aztec Rollup", version: "1", chainId: 1, verifyingContract: ROLLUP },
          types: { AttestationsAndSigners: [{ name: "payloadHash", type: "bytes32" }] },
          primaryType: "AttestationsAndSigners",
          message: {
            payloadHash: keccak256(
              encodeAbiParameters([ATTEST_TUPLE, { type: "address[]" }], [attestations, signers]),
            ),
          },
        })
  const { r, s, v, yParity } = parseSignature(sigHex)
  const sig = { v: Number(v ?? BigInt(yParity + 27)), r, s }
  // Override the coinbase field of ZERO_ARGS so the tx encodes the requested
  // coinbase — recoverProposerAndCoinbaseFromCalldata decodes it back out.
  const proposeCalldata =
    version === "v4"
      ? encodeFunctionData({
          abi: PROPOSE_ABI,
          functionName: "propose",
          args: [
            { ...ZERO_ARGS, header: { ...ZERO_ARGS.header, coinbase } },
            attestations,
            signers,
            sig,
            "0x",
          ],
        })
      : encodeFunctionData({
          abi: PROPOSE_ABI_V5,
          functionName: "propose",
          args: [
            { ...ZERO_ARGS, header: { ...ZERO_ARGS.header, coinbase, accumulatedFees: 0n } },
            attestations,
            signers,
            sig,
            "0x",
          ],
        })
  const calldata = wrap ? wrapInAggregate3(proposeCalldata) : proposeCalldata
  // Two propose() calls at the same checkpointNumber (e.g. one pruned, one
  // re-proposed) are distinct transactions in reality. Bake blockNumber into
  // the txHash so the mock matches that — otherwise the dedup test would see
  // identical txHashes for both events and the tx-fetch path would collapse.
  const idHex = ((checkpointNumber << 32n) | blockNumber).toString(16).padStart(64, "0")
  return {
    checkpointNumber,
    blockNumber,
    txHash: `0x${idHex}` as Hex,
    proposer: account.address,
    coinbase,
    calldata,
  }
}

function makeMockTransport(built: Built[], failTxHashes: Set<Hex> = new Set()) {
  const cpTopic0 = encodeEventTopics({ abi: [CHECKPOINT_PROPOSED_EVENT] })[0]
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      switch (method) {
        case "eth_chainId":
          return "0x1"
        case "eth_blockNumber":
          return "0x10000"
        case "eth_getLogs": {
          const filter = (params as Array<{ address?: string; fromBlock: Hex; toBlock: Hex; topics: unknown[] }>)[0]!
          const from = BigInt(filter.fromBlock)
          const to = BigInt(filter.toBlock)
          if (filter.address?.toLowerCase() !== ROLLUP.toLowerCase() || filter.topics[0] !== cpTopic0) return []
          return built
            .filter((b) => b.blockNumber >= from && b.blockNumber <= to)
            .map((b) => ({
              address: ROLLUP.toLowerCase(),
              topics: encodeEventTopics({
                abi: [CHECKPOINT_PROPOSED_EVENT],
                args: { checkpointNumber: b.checkpointNumber, archive: ZERO32 },
              }),
              data: encodeAbiParameters(
                [
                  { name: "versionedBlobHashes", type: "bytes32[]" },
                  { name: "payloadDigest", type: "bytes32" },
                  { name: "attestationsHash", type: "bytes32" },
                ],
                [[], ZERO32, ZERO32],
              ),
              blockNumber: `0x${b.blockNumber.toString(16)}`,
              blockHash: `0x${"a".repeat(64)}`,
              transactionHash: b.txHash,
              transactionIndex: "0x0",
              logIndex: "0x0",
              removed: false,
            }))
        }
        case "eth_getTransactionByHash": {
          const hash = (params as [Hex])[0]
          if (failTxHashes.has(hash)) throw new Error(`mock: tx fetch failed ${hash}`)
          const b = built.find((x) => x.txHash === hash)
          if (!b) throw new Error(`mock: unknown tx ${hash}`)
          return {
            hash,
            nonce: "0x0",
            blockHash: `0x${"a".repeat(64)}`,
            blockNumber: `0x${b.blockNumber.toString(16)}`,
            transactionIndex: "0x0",
            from: "0x0000000000000000000000000000000000000001",
            to: ROLLUP.toLowerCase(),
            value: "0x0",
            gas: "0x0",
            gasPrice: "0x0",
            input: b.calldata,
            type: "0x0",
            v: "0x1b",
            r: `0x${"1".padStart(64, "0")}`,
            s: `0x${"1".padStart(64, "0")}`,
          }
        }
        default:
          throw new Error(`mock: unsupported method ${method}`)
      }
    },
  }, { retryCount: 0 })
}

const makeClient = (built: Built[]) => createPublicClient({ transport: makeMockTransport(built) })

const run = (built: Built[]) =>
  countProposalsByProposer({
    client: makeClient(built),
    rollupAddress: ROLLUP,
    multicallAddress: MULTICALL3,
    fromBlock: 0n,
    toBlock: 1000n,
    logChunkSize: 10000n,
  })

describe("countProposalsByProposer", () => {
  it("recovers the proposer from each propose() tx and tallies per proposer", async () => {
    const built = [
      await buildCheckpoint(KEY_A, 1n, 50n),
      await buildCheckpoint(KEY_A, 2n, 51n),
      await buildCheckpoint(KEY_B, 3n, 52n),
      await buildCheckpoint(KEY_C, 4n, 53n),
    ]
    const A = privateKeyToAccount(KEY_A).address.toLowerCase()
    const B = privateKeyToAccount(KEY_B).address.toLowerCase()
    const C = privateKeyToAccount(KEY_C).address.toLowerCase()

    const out = await run(built)
    expect(out.totalCheckpoints).toBe(4)
    expect(out.resolvedCheckpoints).toBe(4)
    expect(out.unresolvedCheckpoints).toBe(0)
    expect(out.countsByProposer.get(A)).toBe(2)
    expect(out.countsByProposer.get(B)).toBe(1)
    expect(out.countsByProposer.get(C)).toBe(1)
    // Per-checkpoint attribution trail: one entry per resolved checkpoint, in
    // event order, with the recovered proposer and the L1 metadata that lets
    // an outside auditor re-fetch the propose() tx.
    expect(out.attributed).toHaveLength(4)
    expect(out.attributed[0]).toEqual({
      checkpointNumber: 1n,
      txHash: built[0]!.txHash,
      blockNumber: 50n,
      proposer: getAddress(built[0]!.proposer),
      coinbase: getAddress(built[0]!.coinbase),
    })
    expect(out.attributed.map((c) => c.checkpointNumber)).toEqual([1n, 2n, 3n, 4n])
    expect(out.attributed.map((c) => c.proposer.toLowerCase())).toEqual(
      built.map((b) => b.proposer.toLowerCase()),
    )
  })

  it("dedupes CheckpointProposed events at the same checkpointNumber, keeping the latest L1 block", async () => {
    // Models a pruned-and-reused checkpoint: an event for checkpoint 1 by
    // KEY_A at L1 block 50 (the original, pruned epoch), then a later event
    // for the SAME checkpoint 1 by KEY_B at L1 block 200 (the re-proposed,
    // proven epoch). Only the later event should make it into the attribution
    // trail; counting both would credit a proposer for a pruned epoch they
    // earned nothing from. The dedup count is surfaced as
    // `prunedAndReusedCheckpoints` so operators see when this happened.
    const built = [
      await buildCheckpoint(KEY_A, 1n, 50n), // original (would-be pruned)
      await buildCheckpoint(KEY_B, 1n, 200n), // re-proposal at same checkpoint number
    ]
    const A = privateKeyToAccount(KEY_A).address.toLowerCase()
    const B = privateKeyToAccount(KEY_B).address.toLowerCase()
    const out = await run(built)

    // Only one event survives dedup; counts reflect the latest (KEY_B) only.
    expect(out.totalCheckpoints).toBe(1)
    expect(out.prunedAndReusedCheckpoints).toBe(1)
    expect(out.resolvedCheckpoints).toBe(1)
    expect(out.countsByProposer.get(A)).toBeUndefined()
    expect(out.countsByProposer.get(B)).toBe(1)
    expect(out.attributed).toHaveLength(1)
    expect(out.attributed[0]?.blockNumber).toBe(200n)
    expect(out.attributed[0]?.proposer.toLowerCase()).toBe(B)
  })

  it("decodes header.coinbase from propose() so callers can filter on who got paid", async () => {
    // Two checkpoints by the same attester, but routed to different
    // coinbases. The decoded `coinbase` field lets settle.ts filter to
    // only those that actually paid the operator's distribution wallet.
    const WALLET_A = getAddress("0x1111111111111111111111111111111111111111") as Address
    const WALLET_B = getAddress("0x2222222222222222222222222222222222222222") as Address
    const built = [
      await buildCheckpoint(KEY_A, 1n, 50n, false, WALLET_A),
      await buildCheckpoint(KEY_A, 2n, 51n, false, WALLET_B),
    ]
    const out = await run(built)
    expect(out.resolvedCheckpoints).toBe(2)
    expect(out.attributed.map((c) => c.coinbase)).toEqual([WALLET_A, WALLET_B])
  })

  it("recovers the proposer when propose() is wrapped in a Multicall3 aggregate3 batch", async () => {
    const built = [
      await buildCheckpoint(KEY_A, 1n, 50n, true),
      await buildCheckpoint(KEY_B, 2n, 51n, true),
    ]
    const A = privateKeyToAccount(KEY_A).address.toLowerCase()
    const B = privateKeyToAccount(KEY_B).address.toLowerCase()
    const out = await run(built)
    expect(out.resolvedCheckpoints).toBe(2)
    expect(out.unresolvedCheckpoints).toBe(0)
    expect(out.countsByProposer.get(A)).toBe(1)
    expect(out.countsByProposer.get(B)).toBe(1)
  })

  it("honors the block-range gate", async () => {
    const built = [
      await buildCheckpoint(KEY_A, 1n, 50n),
      await buildCheckpoint(KEY_B, 2n, 52n),
    ]
    const B = privateKeyToAccount(KEY_B).address.toLowerCase()
    const out = await countProposalsByProposer({
      client: makeClient(built),
      rollupAddress: ROLLUP,
      multicallAddress: MULTICALL3,
      fromBlock: 51n,
      toBlock: 1000n,
      logChunkSize: 10000n,
    })
    expect(out.totalCheckpoints).toBe(1)
    expect(out.countsByProposer.get(B)).toBe(1)
    expect(out.countsByProposer.size).toBe(1)
  })

  it("returns empty counts when there are no checkpoints", async () => {
    const out = await run([])
    expect(out.totalCheckpoints).toBe(0)
    expect(out.countsByProposer.size).toBe(0)
  })

  it("counts unresolved + records the first error when a tx can't be fetched", async () => {
    const good = await buildCheckpoint(KEY_A, 1n, 50n)
    const orphan = await buildCheckpoint(KEY_B, 2n, 51n)
    const client = createPublicClient({ transport: makeMockTransport([good, orphan], new Set([orphan.txHash])) })
    const out = await countProposalsByProposer({
      client,
      rollupAddress: ROLLUP,
      multicallAddress: MULTICALL3,
      fromBlock: 0n,
      toBlock: 1000n,
      logChunkSize: 10000n,
    })
    expect(out.totalCheckpoints).toBe(2)
    expect(out.resolvedCheckpoints).toBe(1)
    expect(out.unresolvedCheckpoints).toBe(1)
    expect(out.firstUnresolvedError).toMatch(/tx fetch failed/)
  })

  it("filters by [minCheckpointNumber, maxCheckpointNumber] and reports outOfRange count", async () => {
    // Six checkpoints in the scanned L1 range; we ask for just [2, 4] —
    // simulating the epoch gate (only checkpoints in the requested epoch
    // range count, the rest are scanned-and-dropped by the bounds).
    const built = [
      await buildCheckpoint(KEY_A, 1n, 50n),
      await buildCheckpoint(KEY_A, 2n, 51n),
      await buildCheckpoint(KEY_B, 3n, 52n),
      await buildCheckpoint(KEY_C, 4n, 53n),
      await buildCheckpoint(KEY_A, 5n, 54n),
      await buildCheckpoint(KEY_B, 6n, 55n),
    ]
    const A = privateKeyToAccount(KEY_A).address.toLowerCase()
    const B = privateKeyToAccount(KEY_B).address.toLowerCase()
    const C = privateKeyToAccount(KEY_C).address.toLowerCase()

    const out = await countProposalsByProposer({
      client: makeClient(built),
      rollupAddress: ROLLUP,
      multicallAddress: MULTICALL3,
      fromBlock: 0n,
      toBlock: 1000n,
      logChunkSize: 10000n,
      minCheckpointNumber: 2n,
      maxCheckpointNumber: 4n,
    })

    // 6 in window → 3 kept (checkpoints 2,3,4) + 3 dropped (1,5,6).
    expect(out.totalCheckpoints).toBe(3)
    expect(out.outOfRangeCheckpoints).toBe(3)
    expect(out.resolvedCheckpoints).toBe(3)
    expect(out.countsByProposer.get(A)).toBe(1) // only checkpoint 2
    expect(out.countsByProposer.get(B)).toBe(1) // only checkpoint 3
    expect(out.countsByProposer.get(C)).toBe(1) // checkpoint 4
    expect(out.attributed.map((c) => c.checkpointNumber)).toEqual([2n, 3n, 4n])
  })

  it("reports outOfRangeCheckpoints = 0 when no checkpoint-range bounds are passed", async () => {
    const built = [await buildCheckpoint(KEY_A, 1n, 50n)]
    const out = await run(built)
    expect(out.outOfRangeCheckpoints).toBe(0)
  })

  it("recovers the proposer from v5-format propose() txs (EIP-712 digest, accumulatedFees header)", async () => {
    const zero = "0x0000000000000000000000000000000000000000" as Address
    const built = [
      await buildCheckpoint(KEY_A, 1n, 50n, false, zero, "v5"),
      await buildCheckpoint(KEY_A, 2n, 51n, false, zero, "v5"),
      await buildCheckpoint(KEY_B, 3n, 52n, true, zero, "v5"), // wrapped in aggregate3
    ]
    const A = privateKeyToAccount(KEY_A).address.toLowerCase()
    const B = privateKeyToAccount(KEY_B).address.toLowerCase()
    const out = await run(built)
    expect(out.resolvedCheckpoints).toBe(3)
    expect(out.unresolvedCheckpoints).toBe(0)
    expect(out.countsByProposer.get(A)).toBe(2)
    expect(out.countsByProposer.get(B)).toBe(1)
  })

  it("decodes header.coinbase from v5 propose() calldata", async () => {
    const WALLET = getAddress("0x3333333333333333333333333333333333333333") as Address
    const built = [await buildCheckpoint(KEY_A, 1n, 50n, false, WALLET, "v5")]
    const out = await run(built)
    expect(out.resolvedCheckpoints).toBe(1)
    expect(out.attributed[0]?.coinbase).toBe(WALLET)
  })

  it("handles a window mixing v4 and v5 propose formats (upgrade boundary)", async () => {
    const zero = "0x0000000000000000000000000000000000000000" as Address
    const built = [
      await buildCheckpoint(KEY_A, 1n, 50n), // v4
      await buildCheckpoint(KEY_B, 2n, 51n, false, zero, "v5"),
    ]
    const A = privateKeyToAccount(KEY_A).address.toLowerCase()
    const B = privateKeyToAccount(KEY_B).address.toLowerCase()
    const out = await run(built)
    expect(out.resolvedCheckpoints).toBe(2)
    expect(out.countsByProposer.get(A)).toBe(1)
    expect(out.countsByProposer.get(B)).toBe(1)
  })

  it("emits scanning + recovering progress phases", async () => {
    const built = [await buildCheckpoint(KEY_A, 1n, 50n)]
    const phases = new Set<string>()
    await countProposalsByProposer({
      client: makeClient(built),
      rollupAddress: ROLLUP,
      multicallAddress: MULTICALL3,
      fromBlock: 0n,
      toBlock: 1000n,
      logChunkSize: 100n,
      onProgress: (p) => phases.add(p.phase),
    })
    expect(phases.has("scanning-checkpoints")).toBe(true)
    expect(phases.has("recovering-proposers")).toBe(true)
  })
})
