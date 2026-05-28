import { describe, expect, it } from "vitest"
import { createPublicClient, custom, type Hex } from "viem"
import { computeGasSpent } from "./gascost.js"

/** Build a mock transport that returns a synthesised receipt for each
 *  expected txHash. Lets us drive `computeGasSpent` without a live node. */
function makeMockTransport(
  receipts: Record<Hex, { gasUsed: bigint; effectiveGasPrice: bigint }>,
  failTxHashes: Set<Hex> = new Set(),
) {
  return custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === "eth_chainId") return "0x1"
        if (method === "eth_getTransactionReceipt") {
          const [hash] = params as [Hex]
          if (failTxHashes.has(hash)) throw new Error(`mock: receipt fetch failed for ${hash}`)
          const r = receipts[hash]
          if (!r) throw new Error(`mock: no receipt for ${hash}`)
          // Minimal receipt — only the fields `computeGasSpent` reads matter,
          // but viem decodes the response into its TransactionReceipt shape so
          // we have to populate enough fields for that decode to succeed.
          return {
            transactionHash: hash,
            transactionIndex: "0x0",
            blockHash: `0x${"a".repeat(64)}`,
            blockNumber: "0x1",
            from: "0x0000000000000000000000000000000000000001",
            to: "0x0000000000000000000000000000000000000002",
            cumulativeGasUsed: `0x${r.gasUsed.toString(16)}`,
            gasUsed: `0x${r.gasUsed.toString(16)}`,
            effectiveGasPrice: `0x${r.effectiveGasPrice.toString(16)}`,
            contractAddress: null,
            logs: [],
            logsBloom: `0x${"0".repeat(512)}`,
            status: "0x1",
            type: "0x2",
          }
        }
        throw new Error(`mock: unsupported method ${method}`)
      },
    },
    { retryCount: 0 },
  )
}

const tx = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex

describe("computeGasSpent", () => {
  it("returns zeros when no transactions are passed", async () => {
    const client = createPublicClient({ transport: makeMockTransport({}) })
    const out = await computeGasSpent({ client, txHashes: [] })
    expect(out).toEqual({
      txCount: 0,
      totalGasUsed: 0n,
      totalEthSpentWei: 0n,
      weightedAvgGasPriceWei: 0n,
    })
  })

  it("sums gasUsed × effectiveGasPrice across receipts", async () => {
    // Two txs at different gas prices. The gas-weighted avg should differ
    // from a simple arithmetic mean because the txs use different amounts of
    // gas.
    //   tx1: 100,000 gas at 10 gwei → 0.001 ETH (= 100_000 × 10e9 wei)
    //   tx2: 300,000 gas at 20 gwei → 0.006 ETH (= 300_000 × 20e9 wei)
    //   total: 400,000 gas, 0.007 ETH
    //   weighted avg = 0.007 ETH / 400,000 gas = 17.5 gwei/gas
    //   (simple mean would be 15 gwei — different)
    const receipts = {
      [tx(1)]: { gasUsed: 100_000n, effectiveGasPrice: 10_000_000_000n },
      [tx(2)]: { gasUsed: 300_000n, effectiveGasPrice: 20_000_000_000n },
    }
    const client = createPublicClient({ transport: makeMockTransport(receipts) })
    const out = await computeGasSpent({ client, txHashes: [tx(1), tx(2)] })

    expect(out.txCount).toBe(2)
    expect(out.totalGasUsed).toBe(400_000n)
    expect(out.totalEthSpentWei).toBe(7_000_000_000_000_000n) // 0.007 ETH
    expect(out.weightedAvgGasPriceWei).toBe(17_500_000_000n) // 17.5 gwei
  })

  it("dedupes duplicate tx hashes so a tx isn't counted twice", async () => {
    // Real-world reason this matters: one propose() tx can emit multiple
    // CheckpointProposed events (e.g. an aggregator batched several
    // checkpoints into one tx). The caller passes one txHash per event;
    // computeGasSpent must dedupe to avoid double-counting the gas spend.
    const receipts = {
      [tx(1)]: { gasUsed: 100_000n, effectiveGasPrice: 10_000_000_000n },
    }
    const client = createPublicClient({ transport: makeMockTransport(receipts) })
    const out = await computeGasSpent({ client, txHashes: [tx(1), tx(1), tx(1)] })
    expect(out.txCount).toBe(1)
    expect(out.totalGasUsed).toBe(100_000n)
    expect(out.totalEthSpentWei).toBe(1_000_000_000_000_000n) // 0.001 ETH
  })

  it("hard-fails if a receipt can't be fetched (no silent undercount)", async () => {
    const receipts = {
      [tx(1)]: { gasUsed: 100_000n, effectiveGasPrice: 10_000_000_000n },
      [tx(2)]: { gasUsed: 200_000n, effectiveGasPrice: 10_000_000_000n },
    }
    const client = createPublicClient({
      transport: makeMockTransport(receipts, new Set([tx(2)])),
    })
    await expect(computeGasSpent({ client, txHashes: [tx(1), tx(2)] })).rejects.toThrow(
      /receipt fetch failed/,
    )
  })
})
