import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { encodeFunctionData, type Address } from "viem"
import type { DistributionEntry, PlannedTx } from "./types.js"

/** Multicall3 ABI — only the function we need. */
const MULTICALL3_ABI = [
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

const ERC20_TRANSFER_ABI = [
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

interface BuildPlannedTxsInput {
  multicall3: Address
  token: Address
  entries: DistributionEntry[]
}

/**
 * Build the ordered list of planned txs for a settlement.
 *
 *   1. A single Multicall3.aggregate3 with N inner ERC20.transfer calls.
 *
 * The transfer amount is already rate-adjusted at build time (see
 * `buildDistribution` in attribution.ts) — there is no contract to apply
 * the rate server-side.
 *
 * `allowFailure` is set to FALSE on every inner call — we want the whole
 * batch to revert atomically if any single transfer fails. A partial
 * settlement is a recovery nightmare (which delegators got paid? which
 * didn't? in what order?). Multicall3's atomicity is what guarantees the
 * batch is "all or nothing".
 *
 * Returns an empty array if there are no entries — caller decides whether
 * to send a no-op tx (don't) or log and exit (do).
 */
export function buildPlannedTxs(input: BuildPlannedTxsInput): PlannedTx[] {
  const { multicall3, token, entries } = input
  if (entries.length === 0) return []

  const innerCalls = entries.map((e) => ({
    target: token,
    allowFailure: false,
    callData: encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [e.delegator, e.amount],
    }),
  }))

  return [
    {
      label: `multicall3.aggregate3(${entries.length} transfers)`,
      to: multicall3,
      value: 0n,
      data: encodeFunctionData({
        abi: MULTICALL3_ABI,
        functionName: "aggregate3",
        args: [innerCalls],
      }),
      function: "aggregate3",
      args: {
        // Per-delegator breakdown for the audit record + cold-wallet bundle.
        // A signer reviewing this should see the per-recipient amounts, not
        // just an opaque calldata blob.
        token,
        transfers: entries.map((e) => ({
          delegator: e.delegator,
          amount: e.amount.toString(),
          preRateShare: e.preRateShare.toString(),
        })),
      },
    },
  ]
}

/** Planned transaction in the JSON-friendly shape used in the audit record. */
export interface SerializedPlannedTx {
  label: string
  to: Address
  value: string
  data: `0x${string}`
  function: string
  args: Record<string, unknown>
}

export function serializePlannedTxs(txs: PlannedTx[]): SerializedPlannedTx[] {
  return txs.map((t) => ({
    label: t.label,
    to: t.to,
    value: t.value.toString(),
    data: t.data,
    function: t.function,
    args: t.args,
  }))
}

interface WriteSafeImportInput {
  /** Where to write the `.safe.json`. If the path doesn't already end in
   *  `.safe.json`, that suffix is appended after stripping any `.json`. */
  path: string
  chainId: number
  distributionWallet: Address
  fromEpoch: bigint
  toEpoch: bigint
  fromBlock: bigint
  toBlock: bigint
  transactions: SerializedPlannedTx[]
}

/**
 * Write the Safe Transaction Builder import JSON to disk. This is the *only*
 * sibling artifact the runner writes — the audit JSON itself carries the
 * encoded calldata, so anything else (canonical bundle, human-readable
 * summary) would be a duplicate of data already in the audit + console.
 *
 * Returned path may differ from the input `path`: it always ends in
 * `.safe.json` (the suffix the Safe UI looks for when matching dragged files).
 */
export function writeSafeImport(input: WriteSafeImportInput): { safePath: string } {
  const abs = resolve(process.cwd(), input.path)
  mkdirSync(dirname(abs), { recursive: true })
  const safePath = abs.endsWith(".safe.json") ? abs : abs.replace(/(\.json)?$/, ".safe.json")
  const batch = formatAsSafeBatch({
    chainId: input.chainId,
    createdAt: new Date().toISOString(),
    distributionWallet: input.distributionWallet,
    fromEpoch: input.fromEpoch,
    toEpoch: input.toEpoch,
    fromBlock: input.fromBlock,
    toBlock: input.toBlock,
    transactions: input.transactions,
  })
  writeFileSync(safePath, JSON.stringify(batch, null, 2))
  return { safePath }
}

/**
 * Safe Transaction Builder JSON shape. Reference:
 *   https://help.safe.global/en/articles/40841-transaction-builder
 *
 * The Safe UI expects this specific shape — that's the only reason this file
 * exists as a separate artifact from the audit JSON.
 */
function formatAsSafeBatch(input: {
  chainId: number
  createdAt: string
  distributionWallet: Address
  fromEpoch: bigint
  toEpoch: bigint
  fromBlock: bigint
  toBlock: bigint
  transactions: SerializedPlannedTx[]
}) {
  return {
    version: "1.0",
    chainId: String(input.chainId),
    createdAt: Math.floor(new Date(input.createdAt).getTime() / 1000),
    meta: {
      name: `Operator margin distribution — epochs ${input.fromEpoch}-${input.toEpoch}`,
      description: `Distribution from ${input.distributionWallet}, epochs ${input.fromEpoch}–${input.toEpoch} (L1 blocks ${input.fromBlock}–${input.toBlock}). Generated by aztec-staking-payout.`,
      txBuilderVersion: "1.16.5",
      createdFromSafeAddress: input.distributionWallet,
      createdFromOwnerAddress: "",
    },
    transactions: input.transactions.map((t) => ({
      to: t.to,
      value: t.value,
      data: t.data,
      contractMethod: null,
      contractInputsValues: null,
    })),
  }
}
