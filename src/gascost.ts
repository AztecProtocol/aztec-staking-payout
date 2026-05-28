import { type Hex, type PublicClient } from "viem"
import { mapWithConcurrency, withRetry } from "./concurrency.js"

/**
 * Aggregate L1 gas spend across a set of transactions.
 *
 * Used in settlement to surface how much ETH the operator spent on
 * `propose()` calls during the period — useful input for commission
 * tuning ("are my fees recovering my gas costs?"). Scoped to the operator's
 * own proposals (the caller filters before passing in `txHashes`), so the
 * extra `eth_getTransactionReceipt` calls scale with the operator's
 * checkpoint count (typically ~hundreds per week), not the total in the
 * window.
 */
export interface GasSpendInput {
  client: PublicClient
  /** Transaction hashes to fetch receipts for. Deduplicated internally;
   *  callers can pass the same hash twice (e.g. if one `propose()` tx
   *  emitted multiple `CheckpointProposed` events) without double-counting. */
  txHashes: Hex[]
  /** Optional retry counter — passed through to `withRetry`. */
  retryMeter?: { retries: number }
}

export interface GasSpendResult {
  /** Distinct transactions whose receipts were summed. */
  txCount: number
  /** Sum of `gasUsed` across all fetched receipts. */
  totalGasUsed: bigint
  /** Sum of `gasUsed × effectiveGasPrice` across all fetched receipts (wei). */
  totalEthSpentWei: bigint
  /** `totalEthSpentWei / totalGasUsed` — the actual rate the operator paid
   *  per unit of gas, weighted by how much gas each tx used. Zero when no
   *  txs were fetched. */
  weightedAvgGasPriceWei: bigint
}

/** Max concurrent `eth_getTransactionReceipt` calls in flight. Same bound as
 *  the proposer-recovery pass — the transport's rate limiter is the real
 *  throttle; this just keeps the queue bounded. */
const RECEIPT_CONCURRENCY = 50

/**
 * Fetch each tx's receipt, sum `gasUsed × effectiveGasPrice`, and return
 * the aggregate. **Hard-fails** if any receipt can't be fetched after
 * retries — the operator's gas spend should be reported accurately or not
 * at all (an undercount would understate operating costs, which is the
 * wrong direction for a tool that informs commission decisions).
 */
export async function computeGasSpent(input: GasSpendInput): Promise<GasSpendResult> {
  const { client, retryMeter } = input
  const uniqueTxs = [...new Set(input.txHashes)]
  if (uniqueTxs.length === 0) {
    return { txCount: 0, totalGasUsed: 0n, totalEthSpentWei: 0n, weightedAvgGasPriceWei: 0n }
  }

  const perTx = await mapWithConcurrency(uniqueTxs, RECEIPT_CONCURRENCY, async (txHash) => {
    const receipt = await withRetry(
      () => client.getTransactionReceipt({ hash: txHash }),
      undefined,
      undefined,
      retryMeter,
    )
    // viem normalises EIP-1559 and legacy txs to expose `effectiveGasPrice`
    // (wei per gas unit, what the sender actually paid). `gasUsed` is the
    // post-execution usage.
    return {
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice ?? 0n,
    }
  })

  let totalGasUsed = 0n
  let totalEthSpentWei = 0n
  for (const r of perTx) {
    totalGasUsed += r.gasUsed
    totalEthSpentWei += r.gasUsed * r.effectiveGasPrice
  }
  const weightedAvgGasPriceWei = totalGasUsed > 0n ? totalEthSpentWei / totalGasUsed : 0n

  return {
    txCount: uniqueTxs.length,
    totalGasUsed,
    totalEthSpentWei,
    weightedAvgGasPriceWei,
  }
}
