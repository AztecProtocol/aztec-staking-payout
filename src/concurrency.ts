const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Retry a flaky async call with exponential backoff. Used so a transient RPC
 * hiccup (timeout, rate-limit) doesn't permanently drop a checkpoint — which
 * would make results non-deterministic run-to-run. Throws the last error if
 * all attempts fail (the caller then treats it as a hard failure, not a
 * silently-skipped record).
 */
export async function withRetry<R>(
  fn: () => Promise<R>,
  attempts = 4,
  baseDelayMs = 200,
  /** Optional retry counter — incremented once per scheduled retry. */
  meter?: { retries: number },
): Promise<R> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (i < attempts - 1) {
        if (meter) meter.retries++
        await sleep(baseDelayMs * 2 ** i)
      }
    }
  }
  throw lastErr
}

/**
 * Map over `items` running at most `limit` async tasks at once. A proper
 * worker pool — no head-of-line blocking, so a slow request never stalls the
 * others (unlike chunked `Promise.all`). Results preserve input order.
 *
 * Paired with a JSON-RPC-batching transport, keeping many requests in flight
 * lets the transport pack them into few HTTP round-trips.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i]!, i)
    }
  }
  const n = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: n }, worker))
  return results
}

/**
 * Token-bucket rate limiter. `acquire()` resolves once a token is available,
 * refilling at `rps` tokens/second (burst capacity = `rps`). Used to keep the
 * total RPC call rate under the provider's cap (e.g. QuickNode's 125/s) so
 * requests aren't rejected and silently dropped. `rps <= 0` disables it.
 */
export class RateLimiter {
  private tokens: number
  private last: number
  constructor(
    private readonly rps: number,
    private readonly capacity = Math.max(1, rps),
  ) {
    this.tokens = this.capacity
    this.last = Date.now()
  }

  /** Acquire one token, waiting (refilling at `rps`/s) until available. */
  async acquire(): Promise<void> {
    if (this.rps <= 0) return
    for (;;) {
      const now = Date.now()
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rps)
      this.last = now
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      await sleep(((1 - this.tokens) / this.rps) * 1000)
    }
  }
}
