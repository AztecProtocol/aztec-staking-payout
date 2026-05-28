import { describe, expect, it } from "vitest"
import { getAddress, type Address } from "viem"
import { buildDistribution, buildWeightedDistribution } from "./attribution.js"

const addr = (hex: string) => getAddress(`0x${hex.padEnd(40, "0")}`) as Address

describe("buildDistribution (equal split)", () => {
  it("divides balanceDelta equally across delegators and applies the rate", () => {
    // 3 delegators, balance 3000, rate 10% → 1000 each pre-rate → 900 each post-rate
    const delegators = [addr("d1"), addr("d2"), addr("d3")]
    const out = buildDistribution(delegators, 3000n, 1000, 0n)
    expect(out).toHaveLength(3)
    for (const e of out) {
      expect(e.preRateShare).toBe(1000n)
      expect(e.amount).toBe(900n)
    }
  })

  it("dust accrues to operator retention (integer division per-delegator rounds down)", () => {
    // balance 100, 3 delegators → 33 each (1 wei dust per delegator → goes to operator)
    const delegators = [addr("d1"), addr("d2"), addr("d3")]
    const out = buildDistribution(delegators, 100n, 0, 0n)
    expect(out.map((e) => e.amount)).toEqual([33n, 33n, 33n])
    const totalForwarded = out.reduce((acc, e) => acc + e.amount, 0n)
    expect(100n - totalForwarded).toBe(1n)
  })

  it("drops entries below the dust threshold", () => {
    const delegators = [addr("d1"), addr("d2")]
    // balance 10, 2 delegators → 5 each, rate 0%, dust 6 → both dropped
    const out = buildDistribution(delegators, 10n, 0, 6n)
    expect(out).toHaveLength(0)
  })

  it("handles 0% rate (full passthrough)", () => {
    const out = buildDistribution([addr("d1"), addr("d2")], 200n, 0, 0n)
    expect(out.map((e) => e.amount)).toEqual([100n, 100n])
  })

  it("handles 100% rate (everything to operator)", () => {
    const out = buildDistribution([addr("d1"), addr("d2")], 200n, 10000, 0n)
    for (const e of out) expect(e.amount).toBe(0n)
  })

  it("rejects negative balanceDelta", () => {
    expect(() => buildDistribution([addr("d1")], -1n, 0, 0n)).toThrow(/balanceDelta is negative/)
  })

  it("rejects out-of-range commissionBps", () => {
    expect(() => buildDistribution([addr("d1")], 100n, -1, 0n)).toThrow()
    expect(() => buildDistribution([addr("d1")], 100n, 10001, 0n)).toThrow()
  })

  it("returns empty when delegators[] is empty", () => {
    const out = buildDistribution([], 1000n, 1000, 0n)
    expect(out).toEqual([])
  })

  it("dedupes repeated delegators into one equal share per unique recipient", () => {
    // d1 appears 3×, d2 once → 2 unique recipients → 500 each (not 250).
    const out = buildDistribution([addr("d1"), addr("d1"), addr("d1"), addr("d2")], 1000n, 0, 0n)
    expect(out).toHaveLength(2)
    expect(out.find((e) => e.delegator === addr("d1"))).toMatchObject({ amount: 500n, attesters: 3 })
    expect(out.find((e) => e.delegator === addr("d2"))).toMatchObject({ amount: 500n, attesters: 1 })
  })

  it("rate rounds DOWN on the per-delegator amount", () => {
    // 1 delegator, balance 99, rate 50bps → 99 * 9950 / 10000 = 98.505 → 98
    const out = buildDistribution([addr("d1")], 99n, 50, 0n)
    expect(out[0]?.amount).toBe(98n)
  })
})

describe("buildWeightedDistribution (proposal-weighted)", () => {
  it("splits proportionally to proposal weights, then applies the rate", () => {
    // weights 1:3, balance 4000, rate 10%
    //   d1: 4000 * 1/4 = 1000 pre → 900 post
    //   d2: 4000 * 3/4 = 3000 pre → 2700 post
    const out = buildWeightedDistribution(
      [
        { delegator: addr("d1"), weight: 1 },
        { delegator: addr("d2"), weight: 3 },
      ],
      4000n,
      1000,
      0n,
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ delegator: addr("d1"), preRateShare: 1000n, amount: 900n, weight: 1 })
    expect(out[1]).toMatchObject({ delegator: addr("d2"), preRateShare: 3000n, amount: 2700n, weight: 3 })
  })

  it("aggregates multiple attesters that map to the same delegator into one transfer", () => {
    // Three attesters back d1 (weights 1+2+3=6), one backs d2 (weight 4).
    const out = buildWeightedDistribution(
      [
        { delegator: addr("d1"), weight: 1 },
        { delegator: addr("d1"), weight: 2 },
        { delegator: addr("d1"), weight: 3 },
        { delegator: addr("d2"), weight: 4 },
      ],
      1000n,
      0,
      0n,
    )
    expect(out).toHaveLength(2) // one transfer per unique recipient
    const d1 = out.find((e) => e.delegator === addr("d1"))
    const d2 = out.find((e) => e.delegator === addr("d2"))
    expect(d1).toMatchObject({ weight: 6, attesters: 3 })
    expect(d2).toMatchObject({ weight: 4, attesters: 1 })
    // 1000 * 6/10 = 600, 1000 * 4/10 = 400
    expect(d1?.amount).toBe(600n)
    expect(d2?.amount).toBe(400n)
  })

  it("drops zero-weight delegators (attester did no work this period)", () => {
    const out = buildWeightedDistribution(
      [
        { delegator: addr("d1"), weight: 0 },
        { delegator: addr("d2"), weight: 5 },
      ],
      1000n,
      0,
      0n,
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.delegator).toBe(addr("d2"))
    expect(out[0]?.amount).toBe(1000n)
  })

  it("returns empty when total weight is zero", () => {
    const out = buildWeightedDistribution(
      [
        { delegator: addr("d1"), weight: 0 },
        { delegator: addr("d2"), weight: 0 },
      ],
      1000n,
      0,
      0n,
    )
    expect(out).toEqual([])
  })

  it("returns empty when there are no delegators", () => {
    expect(buildWeightedDistribution([], 1000n, 0, 0n)).toEqual([])
  })

  it("dust from weighted rounding accrues to operator retention", () => {
    // weights 1:1:1, balance 100 → floor(100/3)=33 each, dust 1 to operator
    const out = buildWeightedDistribution(
      [
        { delegator: addr("d1"), weight: 1 },
        { delegator: addr("d2"), weight: 1 },
        { delegator: addr("d3"), weight: 1 },
      ],
      100n,
      0,
      0n,
    )
    expect(out.map((e) => e.amount)).toEqual([33n, 33n, 33n])
    expect(100n - out.reduce((a, e) => a + e.amount, 0n)).toBe(1n)
  })

  it("drops entries below the dust threshold", () => {
    const out = buildWeightedDistribution(
      [
        { delegator: addr("d1"), weight: 1 },
        { delegator: addr("d2"), weight: 100 },
      ],
      1010n,
      0,
      50n,
    )
    // d1: 1010 * 1/101 = 10 → below 50 dust → dropped; d2: 1000 kept
    expect(out.map((e) => e.delegator)).toEqual([addr("d2")])
    expect(out[0]?.amount).toBe(1000n)
  })

  it("rejects negative balanceDelta and out-of-range commission", () => {
    expect(() => buildWeightedDistribution([{ delegator: addr("d1"), weight: 1 }], -1n, 0, 0n)).toThrow(
      /balanceDelta is negative/,
    )
    expect(() => buildWeightedDistribution([{ delegator: addr("d1"), weight: 1 }], 100n, 10001, 0n)).toThrow()
  })
})
