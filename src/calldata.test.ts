import { describe, expect, it } from "vitest"
import { decodeFunctionData, getAddress, type Address } from "viem"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildPlannedTxs, serializePlannedTxs, writeSafeImport } from "./calldata.js"
import type { DistributionEntry } from "./types.js"

const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11") as Address
const TOKEN = getAddress("0x000000000000000000000000000000000000aaaa") as Address
const WALLET = getAddress("0x000000000000000000000000000000000000bbbb") as Address

const addr = (hex: string) => getAddress(`0x${hex.padEnd(40, "0")}`) as Address

const sampleEntries: DistributionEntry[] = [
  { delegator: addr("d1"), preRateShare: 1000n, amount: 950n },
  { delegator: addr("d2"), preRateShare: 500n, amount: 475n },
]

const TRANSFER_ABI = [
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

const TRANSFER_FROM_ABI = [
  {
    name: "transferFrom",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const

const APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
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

describe("buildPlannedTxs — empty input", () => {
  it("emits an empty list when there are no entries (safe mode)", () => {
    const txs = buildPlannedTxs({
      multicall3: MULTICALL3,
      token: TOKEN,
      entries: [],
      outputMode: "safe",
      distributionWallet: WALLET,
      currentAllowance: 0n,
    })
    expect(txs).toEqual([])
  })

  it("emits an empty list when there are no entries (multicall mode)", () => {
    const txs = buildPlannedTxs({
      multicall3: MULTICALL3,
      token: TOKEN,
      entries: [],
      outputMode: "multicall",
      distributionWallet: WALLET,
      currentAllowance: 0n,
    })
    expect(txs).toEqual([])
  })
})

describe("buildPlannedTxs — safe mode", () => {
  it("emits one top-level ERC20.transfer per delegator (msg.sender stays the Safe)", () => {
    const txs = buildPlannedTxs({
      multicall3: MULTICALL3,
      token: TOKEN,
      entries: sampleEntries,
      outputMode: "safe",
      distributionWallet: WALLET,
      currentAllowance: 0n,
    })
    expect(txs).toHaveLength(2)
    for (const t of txs) {
      expect(t.to).toBe(TOKEN)
      expect(t.value).toBe(0n)
      expect(t.function).toBe("transfer")
    }
  })

  it("encoded calldata for each entry decodes to the matching transfer(to, amount)", () => {
    const txs = buildPlannedTxs({
      multicall3: MULTICALL3,
      token: TOKEN,
      entries: sampleEntries,
      outputMode: "safe",
      distributionWallet: WALLET,
      currentAllowance: 0n,
    })
    const d0 = decodeFunctionData({ abi: TRANSFER_ABI, data: txs[0]!.data })
    expect(d0.args[0]).toBe(addr("d1"))
    expect(d0.args[1]).toBe(950n)
    const d1 = decodeFunctionData({ abi: TRANSFER_ABI, data: txs[1]!.data })
    expect(d1.args[0]).toBe(addr("d2"))
    expect(d1.args[1]).toBe(475n)
  })

  it("per-tx args carry the delegator + amount breakdown for audit", () => {
    const txs = buildPlannedTxs({
      multicall3: MULTICALL3,
      token: TOKEN,
      entries: sampleEntries,
      outputMode: "safe",
      distributionWallet: WALLET,
      currentAllowance: 0n,
    })
    expect(txs[0]!.args).toMatchObject({
      token: TOKEN,
      delegator: addr("d1"),
      amount: "950",
      preRateShare: "1000",
    })
  })
})

describe("buildPlannedTxs — multicall mode", () => {
  it("emits approve + aggregate3 of transferFrom when allowance is insufficient", () => {
    const txs = buildPlannedTxs({
      multicall3: MULTICALL3,
      token: TOKEN,
      entries: sampleEntries,
      outputMode: "multicall",
      distributionWallet: WALLET,
      currentAllowance: 0n,
    })
    expect(txs).toHaveLength(2)
    expect(txs[0]!.function).toBe("approve")
    expect(txs[0]!.to).toBe(TOKEN)
    expect(txs[1]!.function).toBe("aggregate3")
    expect(txs[1]!.to).toBe(MULTICALL3)
  })

  it("approve targets Multicall3 with the exact totalForwarded amount", () => {
    const txs = buildPlannedTxs({
      multicall3: MULTICALL3,
      token: TOKEN,
      entries: sampleEntries,
      outputMode: "multicall",
      distributionWallet: WALLET,
      currentAllowance: 0n,
    })
    const approve = decodeFunctionData({ abi: APPROVE_ABI, data: txs[0]!.data })
    expect(approve.args[0]).toBe(MULTICALL3)
    // totalForwarded = 950 + 475 = 1425
    expect(approve.args[1]).toBe(1425n)
  })

  it("skips approve when current allowance is already sufficient", () => {
    const txs = buildPlannedTxs({
      multicall3: MULTICALL3,
      token: TOKEN,
      entries: sampleEntries,
      outputMode: "multicall",
      distributionWallet: WALLET,
      // allowance > total (1425) → no approve needed
      currentAllowance: 10_000n,
    })
    expect(txs).toHaveLength(1)
    expect(txs[0]!.function).toBe("aggregate3")
  })

  it("inner calls are transferFrom(distributionWallet, delegator, amount) — never plain transfer", () => {
    const txs = buildPlannedTxs({
      multicall3: MULTICALL3,
      token: TOKEN,
      entries: sampleEntries,
      outputMode: "multicall",
      distributionWallet: WALLET,
      currentAllowance: 0n,
    })
    const agg = decodeFunctionData({ abi: AGGREGATE3_ABI, data: txs[1]!.data })
    const calls = agg.args[0] as readonly {
      target: Address
      allowFailure: boolean
      callData: `0x${string}`
    }[]
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(c.target.toLowerCase()).toBe(TOKEN.toLowerCase())
      expect(c.allowFailure).toBe(false)
    }
    // Decode each inner call. transferFrom(from, to, amount) — `from` MUST be
    // the distribution wallet (this is the whole point of the multicall mode
    // fix: Multicall3 is msg.sender on the inner call, and only transferFrom
    // pulls from the operator's wallet under the prior approve).
    const inner0 = decodeFunctionData({ abi: TRANSFER_FROM_ABI, data: calls[0]!.callData })
    expect(inner0.args[0]).toBe(WALLET)
    expect(inner0.args[1]).toBe(addr("d1"))
    expect(inner0.args[2]).toBe(950n)
    const inner1 = decodeFunctionData({ abi: TRANSFER_FROM_ABI, data: calls[1]!.callData })
    expect(inner1.args[0]).toBe(WALLET)
    expect(inner1.args[1]).toBe(addr("d2"))
    expect(inner1.args[2]).toBe(475n)
  })

  it("aggregate3 args carry the per-delegator breakdown for audit (with from)", () => {
    const txs = buildPlannedTxs({
      multicall3: MULTICALL3,
      token: TOKEN,
      entries: sampleEntries,
      outputMode: "multicall",
      distributionWallet: WALLET,
      currentAllowance: 0n,
    })
    const args = txs[1]!.args as {
      from: Address
      token: Address
      transfers: Array<{ delegator: Address; amount: string; preRateShare: string }>
    }
    expect(args.from).toBe(WALLET)
    expect(args.token).toBe(TOKEN)
    expect(args.transfers).toEqual([
      { delegator: addr("d1"), amount: "950", preRateShare: "1000" },
      { delegator: addr("d2"), amount: "475", preRateShare: "500" },
    ])
  })
})

describe("serializePlannedTxs", () => {
  it("turns bigints into decimal strings", () => {
    const txs = buildPlannedTxs({
      multicall3: MULTICALL3,
      token: TOKEN,
      entries: sampleEntries,
      outputMode: "safe",
      distributionWallet: WALLET,
      currentAllowance: 0n,
    })
    const s = serializePlannedTxs(txs)
    expect(s[0]?.value).toBe("0")
    expect(typeof s[0]?.data).toBe("string")
  })
})

describe("writeSafeImport", () => {
  it("writes a Safe Transaction Builder JSON with one entry per planned tx (safe mode)", () => {
    const dir = mkdtempSync(join(tmpdir(), "calldata-test-"))
    try {
      const txs = buildPlannedTxs({
        multicall3: MULTICALL3,
        token: TOKEN,
        entries: sampleEntries,
        outputMode: "safe",
        distributionWallet: WALLET,
        currentAllowance: 0n,
      })
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
      expect(safe.version).toBe("1.0")
      expect(safe.chainId).toBe("1")
      expect(typeof safe.createdAt).toBe("number")
      expect(safe.meta.createdFromSafeAddress).toBe(addr("ffff"))
      expect(safe.meta.txBuilderVersion).toBe("1.16.5")
      expect(safe.meta.name).toContain("epochs 10-20")
      // Safe mode: one entry per delegator transfer.
      expect(safe.transactions).toHaveLength(2)
      for (let i = 0; i < safe.transactions.length; i++) {
        expect(safe.transactions[i].to).toBe(TOKEN)
        expect(safe.transactions[i].data).toBe(txs[i]?.data)
        expect(safe.transactions[i].value).toBe("0")
        expect(safe.transactions[i].contractMethod).toBe(null)
        expect(safe.transactions[i].contractInputsValues).toBe(null)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("appends .safe.json when the input path doesn't already end with it", () => {
    const dir = mkdtempSync(join(tmpdir(), "calldata-test-"))
    try {
      const txs = buildPlannedTxs({
        multicall3: MULTICALL3,
        token: TOKEN,
        entries: sampleEntries,
        outputMode: "safe",
        distributionWallet: WALLET,
        currentAllowance: 0n,
      })
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
