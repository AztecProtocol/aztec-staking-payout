import { describe, expect, it } from "vitest"
import { decodeFunctionData, getAddress, type Address } from "viem"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildPlannedTxs, serializePlannedTxs, writeSafeImport } from "./calldata.js"
import type { DistributionEntry } from "./types.js"

const TOKEN = getAddress("0x000000000000000000000000000000000000aaaa") as Address

const addr = (hex: string) => getAddress(`0x${hex.padEnd(40, "0")}`) as Address

const sampleEntries: DistributionEntry[] = [
  { delegator: addr("d1"), preRateShare: 1000n, amount: 950n },
  { delegator: addr("d2"), preRateShare: 500n, amount: 475n },
]

describe("buildPlannedTxs", () => {
  it("emits an empty list when there are no entries", () => {
    const txs = buildPlannedTxs({ token: TOKEN, entries: [] })
    expect(txs).toEqual([])
  })

  it("emits one direct ERC20.transfer per entry", () => {
    const txs = buildPlannedTxs({ token: TOKEN, entries: sampleEntries })
    expect(txs).toHaveLength(2)
    expect(txs[0]?.to).toBe(TOKEN)
    expect(txs[0]?.value).toBe(0n)
    expect(txs[0]?.function).toBe("transfer")
    expect(txs[0]?.label).toContain("1/2")
  })

  it("encoded calldata decodes back to the same per-recipient transfer list", () => {
    const txs = buildPlannedTxs({ token: TOKEN, entries: sampleEntries })
    const transferAbi = [
      {
        name: "transfer",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
      },
    ] as const
    const inner0 = decodeFunctionData({ abi: transferAbi, data: txs[0]!.data })
    expect(inner0.args[0]).toBe(addr("d1"))
    expect(inner0.args[1]).toBe(950n)
    const inner1 = decodeFunctionData({ abi: transferAbi, data: txs[1]!.data })
    expect(inner1.args[0]).toBe(addr("d2"))
    expect(inner1.args[1]).toBe(475n)
  })

  it("args carry the per-delegator breakdown for audit", () => {
    const txs = buildPlannedTxs({ token: TOKEN, entries: sampleEntries })
    const args = txs[0]?.args as {
      delegator: Address
      amount: string
      preRateShare: string
    }
    expect(args).toEqual({ delegator: addr("d1"), amount: "950", preRateShare: "1000" })
  })
})

describe("serializePlannedTxs", () => {
  it("turns bigints into decimal strings", () => {
    const txs = buildPlannedTxs({ token: TOKEN, entries: sampleEntries })
    const s = serializePlannedTxs(txs)
    expect(s[0]?.value).toBe("0")
    expect(typeof s[0]?.data).toBe("string")
  })
})

describe("writeSafeImport", () => {
  it("writes a Safe Transaction Builder JSON in the expected shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "calldata-test-"))
    try {
      const txs = buildPlannedTxs({ token: TOKEN, entries: sampleEntries })
      const result = writeSafeImport({
        path: join(dir, "out.safe.json"),
        chainId: 1,
        distributionWallet: addr("ffff"),
        fromEpoch: 10n,
        toEpoch: 20n,
        fromBlock: 1000n,
        toBlock: 2000n,
        transactions: serializePlannedTxs(txs),
      })
      expect(result.safePath).toBe(`${dir}/out.safe.json`)

      const safe = JSON.parse(readFileSync(result.safePath, "utf-8"))
      // Shape the Safe UI expects.
      expect(safe.version).toBe("1.0")
      expect(safe.chainId).toBe("1")
      expect(typeof safe.createdAt).toBe("number")
      expect(safe.meta.createdFromSafeAddress).toBe(addr("ffff"))
      expect(safe.meta.txBuilderVersion).toBe("1.16.5")
      // Settlement is named by the epoch range.
      expect(safe.meta.name).toContain("epochs 10-20")
      // The transactions list matches what we passed in, in the Safe-flavored
      // shape (to/value/data + null contractMethod/contractInputsValues).
      expect(safe.transactions).toHaveLength(2)
      expect(safe.transactions[0].to).toBe(TOKEN)
      expect(safe.transactions[0].data).toBe(txs[0]?.data)
      expect(safe.transactions[0].value).toBe("0")
      expect(safe.transactions[0].contractMethod).toBe(null)
      expect(safe.transactions[0].contractInputsValues).toBe(null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("appends .safe.json when the input path doesn't already end with it", () => {
    const dir = mkdtempSync(join(tmpdir(), "calldata-test-"))
    try {
      const txs = buildPlannedTxs({ token: TOKEN, entries: sampleEntries })
      // Passing a plain `.json` path → suffix gets normalised to `.safe.json`.
      const result = writeSafeImport({
        path: join(dir, "out.json"),
        chainId: 1,
        distributionWallet: addr("ffff"),
        fromEpoch: 10n,
        toEpoch: 20n,
        fromBlock: 1000n,
        toBlock: 2000n,
        transactions: serializePlannedTxs(txs),
      })
      expect(result.safePath).toBe(`${dir}/out.safe.json`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
