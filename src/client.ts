import { createPublicClient, http, type PublicClient, type Transport } from "viem"
import type { RunnerConfig } from "./config.js"
import { RateLimiter } from "./concurrency.js"

/** Mutable counters of RPC traffic. `count` is every request the transport
 *  actually sent (including retried ones). `retries` is the subset that were
 *  retry attempts — so primary calls = count − retries. */
export interface RpcMeter {
  count: number
  retries: number
}

/** Count each request the transport actually issues. */
function withCounter(inner: Transport, meter: RpcMeter): Transport {
  return (opts) => {
    const t = inner(opts)
    const request = (async (args: unknown) => {
      meter.count++
      return (t.request as (a: unknown) => Promise<unknown>)(args)
    }) as typeof t.request
    return { ...t, request }
  }
}

/**
 * Wrap a transport so every RPC call passes through a token-bucket rate
 * limiter first. Caps the call rate under the provider's limit (e.g.
 * QuickNode's 125/s) so the thousands of `eth_getTransactionByHash` calls in
 * proposer recovery don't trip the limit and get rejected.
 *
 * Note: we deliberately do NOT enable JSON-RPC batching. Benchmarked against
 * QuickNode it was ~10× slower and caused HTTP failures (large multi-tx batch
 * responses), so per-call requests + this rate limiter is the reliable path.
 */
function withRateLimit(inner: Transport, rps: number): Transport {
  if (rps <= 0) return inner
  const limiter = new RateLimiter(rps)
  return (opts) => {
    const t = inner(opts)
    const request = (async (args: unknown) => {
      await limiter.acquire()
      return (t.request as (a: unknown) => Promise<unknown>)(args)
    }) as typeof t.request
    return { ...t, request }
  }
}

/**
 * The shared read client + an `RpcMeter` tallying requests sent. Rate-limited
 * to `rpcMaxRequestsPerSecond` (0 disables); `retryCount: 0` so our own
 * `withRetry` is the single retry layer; `timeout` raised for slow wide-range
 * `eth_getLogs`.
 */
export function makePublicClient(config: RunnerConfig): { client: PublicClient; meter: RpcMeter } {
  const meter: RpcMeter = { count: 0, retries: 0 }
  const base = http(config.rpcUrl, { retryCount: 0, timeout: config.rpcTimeoutMs })
  const transport = withRateLimit(withCounter(base, meter), config.rpcMaxRequestsPerSecond)
  return { client: createPublicClient({ transport }), meter }
}
