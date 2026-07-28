import { describe, expect, it } from "vitest"
import { decodeFunctionData, getAddress, type Address } from "viem"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildPlannedTxs, serializePlannedTxs, writeSafeImport } from "./calldata.js"
import type { DistributionEntry } from "./types.js"

const DISPERSE = getAddress("0xD152f549545093347A162Dce210e7293f1452150") as Address
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

const DISPERSE_TOKEN_SIMPLE_ABI = [
  {
    name: "disperseTokenSimple",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "recipients", type: "address[]" },
      { name: "values", type: "uint256[]" },
    ],
    outputs: [],
  },
] as const

describe("buildPlannedTxs — empty input", () => {
  it("emits an empty list when there are no entries (safe mode)", () => {
    const txs = buildPlannedTxs({
      disperseAddress: DISPERSE,
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
      disperseAddress: DISPERSE,
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
      disperseAddress: DISPERSE,
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
      disperseAddress: DISPERSE,
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
      disperseAddress: DISPERSE,
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

describe("buildPlannedTxs — disperse mode", () => {
  it("emits approve + disperseTokenSimple when allowance is insufficient", () => {
    const txs = buildPlannedTxs({
      disperseAddress: DISPERSE,
      token: TOKEN,
      entries: sampleEntries,
      outputMode: "disperse",
      distributionWallet: WALLET,
      currentAllowance: 0n,
    })
    expect(txs).toHaveLength(2)
    expect(txs[0]!.function).toBe("approve")
    expect(txs[0]!.to).toBe(TOKEN)
    expect(txs[1]!.function).toBe("disperseTokenSimple")
    expect(txs[1]!.to).toBe(DISPERSE)
  })

  it("approve targets Disperse with the exact totalForwarded amount", () => {
    const txs = buildPlannedTxs({
      disperseAddress: DISPERSE,
      token: TOKEN,
      entries: sampleEntries,
      outputMode: "disperse",
      distributionWallet: WALLET,
      currentAllowance: 0n,
    })
    const approve = decodeFunctionData({ abi: APPROVE_ABI, data: txs[0]!.data })
    expect(approve.args[0]).toBe(DISPERSE)
    // totalForwarded = 950 + 475 = 1425
    expect(approve.args[1]).toBe(1425n)
  })

  it("skips approve when current allowance is already sufficient", () => {
    const txs = buildPlannedTxs({
      disperseAddress: DISPERSE,
      token: TOKEN,
      entries: sampleEntries,
      outputMode: "disperse",
      distributionWallet: WALLET,
      // allowance > total (1425) → no approve needed
      currentAllowance: 10_000n,
    })
    expect(txs).toHaveLength(1)
    expect(txs[0]!.function).toBe("disperseTokenSimple")
  })

  it("disperseTokenSimple encodes the token, recipient list, and amount list — no `from` argument", () => {
    // The `from` for each internal transferFrom is `msg.sender` inside
    // Disperse, chosen by the transaction sender at broadcast time. There
    // is no `from` arg in the calldata — that's what makes this shape safe
    // against a Multicall3-style drain (an attacker calling Disperse from
    // their own wallet would spend their own allowance, not the operator's).
    const txs = buildPlannedTxs({
      disperseAddress: DISPERSE,
      token: TOKEN,
      entries: sampleEntries,
      outputMode: "disperse",
      distributionWallet: WALLET,
      currentAllowance: 0n,
    })
    const decoded = decodeFunctionData({ abi: DISPERSE_TOKEN_SIMPLE_ABI, data: txs[1]!.data })
    expect(decoded.args[0]).toBe(TOKEN)
    expect(decoded.args[1]).toEqual([addr("d1"), addr("d2")])
    expect(decoded.args[2]).toEqual([950n, 475n])
  })

  it("disperseTokenSimple args carry the per-delegator breakdown for audit (with from)", () => {
    const txs = buildPlannedTxs({
      disperseAddress: DISPERSE,
      token: TOKEN,
      entries: sampleEntries,
      outputMode: "disperse",
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
      disperseAddress: DISPERSE,
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
        disperseAddress: DISPERSE,
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
        disperseAddress: DISPERSE,
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
