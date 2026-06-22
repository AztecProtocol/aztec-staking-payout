import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { encodeFunctionData, type Address } from "viem"
import type { DistributionEntry, OutputMode, PlannedTx } from "./types.js"

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

const ERC20_TRANSFER_FROM_ABI = [
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

const ERC20_APPROVE_ABI = [
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

interface BuildPlannedTxsInput {
  multicall3: Address
  token: Address
  entries: DistributionEntry[]
  outputMode: OutputMode
  /** The wallet holding the tokens. In `multicall` mode this is the `from`
   *  argument to `transferFrom`. Ignored in `safe` mode. */
  distributionWallet: Address
  /** Current ERC20 allowance the distribution wallet has granted Multicall3.
   *  In `multicall` mode the approve tx is omitted when `>= total`. Ignored
   *  in `safe` mode. */
  currentAllowance: bigint
}

/**
 * Build the ordered list of planned txs for a settlement.
 *
 * Shape depends on `outputMode`:
 *
 *   - "safe":      N planned txs, each `ERC20.transfer(delegator, amount)`
 *                  targeting the token directly. The Safe wraps them in
 *                  MultiSend at submission, so `msg.sender == Safe` on every
 *                  inner transfer and tokens flow from the Safe.
 *
 *   - "multicall": 1 or 2 planned txs targeting first the token (optional
 *                  `approve(Multicall3, total)`) and then Multicall3
 *                  (`aggregate3([transferFrom(wallet, delegator, amount),
 *                  ...])`). The approve is skipped when `currentAllowance >=
 *                  total`. The aggregate3 step is atomic: any inner failure
 *                  reverts the whole batch.
 *
 * Amounts are already rate-adjusted at build time (see `buildDistribution` /
 * `buildWeightedDistribution` in attribution.ts).
 *
 * Returns an empty array if there are no entries — caller decides whether to
 * send a no-op tx (don't) or log and exit (do).
 */
export function buildPlannedTxs(input: BuildPlannedTxsInput): PlannedTx[] {
  const { entries, outputMode } = input
  if (entries.length === 0) return []
  return outputMode === "safe"
    ? buildSafePlannedTxs(input)
    : buildMulticallPlannedTxs(input)
}

function buildSafePlannedTxs(input: BuildPlannedTxsInput): PlannedTx[] {
  const { token, entries } = input
  return entries.map((e, i) => ({
    label: `ERC20.transfer #${i + 1}/${entries.length} → ${e.delegator} (${e.amount})`,
    to: token,
    value: 0n,
    data: encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [e.delegator, e.amount],
    }),
    function: "transfer",
    args: {
      token,
      delegator: e.delegator,
      amount: e.amount.toString(),
      preRateShare: e.preRateShare.toString(),
    },
  }))
}

function buildMulticallPlannedTxs(input: BuildPlannedTxsInput): PlannedTx[] {
  const { multicall3, token, entries, distributionWallet, currentAllowance } = input
  const total = entries.reduce((acc, e) => acc + e.amount, 0n)
  const planned: PlannedTx[] = []

  if (currentAllowance < total) {
    planned.push({
      label: `ERC20.approve(Multicall3, ${total})`,
      to: token,
      value: 0n,
      data: encodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [multicall3, total],
      }),
      function: "approve",
      args: {
        token,
        spender: multicall3,
        amount: total.toString(),
      },
    })
  }

  const innerCalls = entries.map((e) => ({
    target: token,
    allowFailure: false,
    callData: encodeFunctionData({
      abi: ERC20_TRANSFER_FROM_ABI,
      functionName: "transferFrom",
      args: [distributionWallet, e.delegator, e.amount],
    }),
  }))

  planned.push({
    label: `Multicall3.aggregate3(${entries.length} transferFrom calls)`,
    to: multicall3,
    value: 0n,
    data: encodeFunctionData({
      abi: MULTICALL3_ABI,
      functionName: "aggregate3",
      args: [innerCalls],
    }),
    function: "aggregate3",
    args: {
      from: distributionWallet,
      token,
      transfers: entries.map((e) => ({
        delegator: e.delegator,
        amount: e.amount.toString(),
        preRateShare: e.preRateShare.toString(),
      })),
    },
  })

  return planned
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
