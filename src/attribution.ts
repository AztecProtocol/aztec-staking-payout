import type { Address } from "viem"
import type { DistributionEntry } from "./types.js"

/**
 * A delegator and the weight (proposals proposed by their attester) that earns
 * their slice of the period's reward delta.
 */
export interface WeightedDelegator {
  delegator: Address
  weight: number
}

function assertInputs(balanceDelta: bigint, commissionBps: number): void {
  if (commissionBps < 0 || commissionBps > 10000) {
    throw new Error(`Invalid commissionBps: ${commissionBps}`)
  }
  if (balanceDelta < 0n) {
    throw new Error(
      `balanceDelta is negative (${balanceDelta}). The distribution wallet's balance ` +
        `decreased over the period — likely an unrelated withdrawal happened between ` +
        `fromBlock and toBlock. Investigate before retrying.`,
    )
  }
}

/**
 * Proposal-weighted split: divide `balanceDelta` across delegators in
 * proportion to how many checkpoints each delegator's attester actually
 * proposed in the window, then apply commission to each share.
 *
 * This is the "by actual work" attribution: a delegator whose attester
 * proposed nothing this period (weight 0) receives nothing; one that proposed
 * twice as many checkpoints as another receives twice the share. Because the
 * operator pools all coinbase rewards into one distribution wallet, the
 * balance delta equals the sum of rewards from the operator's own attesters'
 * proposals — so weighting by those proposals attributes the pool back to the
 * delegators who earned it.
 *
 * Rounding: integer division per delegator rounds DOWN; any dust accrues to
 * the operator's retention. Entries with zero weight, or whose post-commission
 * amount is below `dustThreshold`, are dropped.
 */
export function buildWeightedDistribution(
  weighted: readonly WeightedDelegator[],
  balanceDelta: bigint,
  commissionBps: number,
  dustThreshold: bigint,
): DistributionEntry[] {
  assertInputs(balanceDelta, commissionBps)

  // Aggregate per unique delegator: a single recipient may back several
  // attesters, and each should receive ONE summed transfer, not one per
  // attester. We sum the proposal weights and count the contributing
  // attesters for the audit trail.
  const byDelegator = new Map<string, { delegator: Address; weight: number; attesters: number }>()
  for (const w of weighted) {
    const key = w.delegator.toLowerCase()
    const cur = byDelegator.get(key)
    if (cur) {
      cur.weight += w.weight
      cur.attesters += 1
    } else {
      byDelegator.set(key, { delegator: w.delegator, weight: w.weight, attesters: 1 })
    }
  }

  const totalWeight = [...byDelegator.values()].reduce((acc, d) => acc + d.weight, 0)
  if (totalWeight <= 0) return []

  const totalWeightBig = BigInt(totalWeight)
  const out: DistributionEntry[] = []
  for (const d of byDelegator.values()) {
    if (d.weight <= 0) continue
    const preRateShare = (balanceDelta * BigInt(d.weight)) / totalWeightBig
    const amount = (preRateShare * BigInt(10000 - commissionBps)) / 10000n
    if (amount < dustThreshold) continue
    out.push({ delegator: d.delegator, preRateShare, amount, weight: d.weight, attesters: d.attesters })
  }
  return out
}

/**
 * Equal-split: divide `balanceDelta` evenly across `delegators`, then apply
 * commission to each share. A pool model — every delegator gets the same slice
 * regardless of whether their attester did any work. Kept as an opt-in
 * fallback (`attributionMode: equal-split`) and for the delegator-override
 * path, where no attester→proposer mapping exists. Prefer
 * `buildWeightedDistribution` for work-based attribution.
 *
 * Rounding: integer division per delegator rounds DOWN; dust accrues to the
 * operator's retention.
 */
export function buildDistribution(
  delegators: readonly Address[],
  balanceDelta: bigint,
  commissionBps: number,
  dustThreshold: bigint,
): DistributionEntry[] {
  assertInputs(balanceDelta, commissionBps)

  // Dedupe to unique recipients — "equal" means equal per recipient, and a
  // recipient backing several attesters must still get one transfer.
  const byDelegator = new Map<string, { delegator: Address; attesters: number }>()
  for (const d of delegators) {
    const key = d.toLowerCase()
    const cur = byDelegator.get(key)
    if (cur) cur.attesters += 1
    else byDelegator.set(key, { delegator: d, attesters: 1 })
  }
  const unique = [...byDelegator.values()]
  if (unique.length === 0) return []

  const perDelegator = balanceDelta / BigInt(unique.length)
  const out: DistributionEntry[] = []
  for (const u of unique) {
    const amount = (perDelegator * BigInt(10000 - commissionBps)) / 10000n
    if (amount < dustThreshold) continue
    out.push({ delegator: u.delegator, preRateShare: perDelegator, amount, attesters: u.attesters })
  }
  return out
}
