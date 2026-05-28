# Forwarding Math

## Notation

| Symbol | Meaning |
|---|---|
| `R` | Total revenue accrued to the operator's treasury over an accounting period |
| `S_i` | Stake of delegator `i` on attester `A` during the period |
| `S_A` | Total stake on attester `A` (`Σ S_i`) |
| `R_A` | Revenue attributable to attester `A` |
| `share_i` | Delegator `i`'s pro-rata share of attester `A`'s revenue = `R_A × S_i / S_A` |
| `origRate` | The take rate baked into the delegator's original split contract (basis points, /10000) |
| `effRate` | The effective take rate the operator declares for the period (basis points, /10000) |
| `maxRate` | Hard ceiling for `effRate` on the operator's treasury contract |

All rates are in basis points: 500 = 5%, 1000 = 10%.

## Constraint

```
origRate ≤ effRate ≤ maxRate ≤ 10000
```

The operator cannot effectively *reduce* a delegator's rate below the original (forwarding more than 100% of a delegator's pro-rata share is nonsensical and the formula would yield > 1, which is disallowed). They can only effectively *increase* it, up to the ceiling.

## Forwarding amount (direct-pay design)

In the direct-pay treasury design (recommended), the treasury sends tokens directly to the delegator's beneficiary address, bypassing the original split entirely:

```
amount_i = share_i × (10000 − effRate) / 10000
```

Operator keeps `share_i × effRate / 10000` in the treasury. Across all delegators, the operator's accumulated retention is exactly `R × effRate / 10000`.

## Forwarding amount (split-routed design, for reference)

If the treasury instead routes through the original split contract:

```
forwardAmount_i = share_i × (10000 − effRate) / (10000 − origRate)
```

The split then distributes that amount at its hardcoded ratio: delegator gets `(10000 − origRate)/10000 × forwardAmount_i = share_i × (10000 − effRate) / 10000` — same result as direct-pay. The split-routed version is more complex and consumes more gas (an extra `distribute` call plus a warehouse `withdraw`) for no functional benefit, so we drop it.

## Worked examples

All examples use `decimals = 18` and a single token. Revenue figures are notional.

### Example 1 — Operator covers baseline costs

- Original split rate: 5% (`origRate = 500`)
- Operator's declared effective rate this period: 5% (`effRate = 500`)
- Delegator's pro-rata share: 100 tokens
- Forward: `100 × (10000 − 500) / 10000 = 95 tokens`
- Operator keeps: 5 tokens
- ✓ Identical to today's behaviour. Treasury routing has no economic effect when `effRate == origRate`.

### Example 2 — Operator absorbs a gas spike

- Original split rate: 5% (`origRate = 500`)
- Operator's declared effective rate this period: 12% (`effRate = 1200`)
- Maximum rate the operator can ever declare: 15% (`maxRate = 1500`)
- Delegator's pro-rata share: 100 tokens
- Forward: `100 × (10000 − 1200) / 10000 = 88 tokens`
- Operator keeps: 12 tokens
- ✓ Delegator earns 88 tokens (down from 95 at baseline). Operator's extra 7 tokens covers the period's elevated gas spend.

### Example 3 — Operator at the ceiling

- Original split rate: 5%
- `maxRate`: 15%
- Operator wants 18% to break even (sustained extreme spike)
- Contract rejects: `effRate > maxRate` → transaction reverts.
- Operator must eat the difference or queue a `maxRate` increase, which would require deploying a new treasury (or activating a separately-implemented higher-tier ceiling, which we don't include in v1).

### Example 4 — Multi-attester operator, mixed delegator stakes

Operator runs attesters A and B. Period revenue:
- Attester A earned 1000 tokens
- Attester B earned 600 tokens

Delegations:
- Delegator 1: 200 stake on A, 0 on B. `origRate = 500`
- Delegator 2: 100 stake on A, 300 on B. `origRate = 500`
- Delegator 3: 0 on A, 100 on B. `origRate = 700`

Operator's declared `effRate` for the period: 10%.

Per-delegator shares (pro-rata by stake on each attester):

| Delegator | Share from A | Share from B | Total share |
|---|---|---|---|
| 1 | 1000 × 200/300 = 666.67 | 0 | 666.67 |
| 2 | 1000 × 100/300 = 333.33 | 600 × 300/400 = 450 | 783.33 |
| 3 | 0 | 600 × 100/400 = 150 | 150 |

Forward amounts (all at `effRate = 10%`, regardless of each delegator's `origRate`):

| Delegator | Forward (= share × 0.90) |
|---|---|
| 1 | 600.00 |
| 2 | 705.00 |
| 3 | 135.00 |

Sum of forwards: 1440. Operator retains 160 (10% of 1600). ✓

Note: delegator 3's `origRate = 700` doesn't matter under direct-pay. They get their pro-rata share at the operator's `effRate`, same as everyone else. If the operator wants to honour different `origRate`s for different cohorts (e.g., legacy delegators get 5%, new ones get 10%), they can either:

- Run a separate treasury per cohort, or
- Apply a per-delegator effective rate in their off-chain attribution before submitting to `recordPeriodRevenue`. The contract enforces ≤ `effectiveRateBps` as a ceiling per call, but the operator can choose to forward more (i.e., a *lower* effective rate) for specific delegators.

### Example 5 — MEV inclusion

- Period block rewards (coinbase to treasury): 500 tokens
- Period MEV captured at treasury (assuming it lands here): 80 tokens
- Period priority fees captured at treasury: 20 tokens

Treasury balance: 600 tokens. The operator's policy must declare whether MEV and priority fees are included in the revenue pool.

**Policy A — "all-inclusive"**: `R = 600`. Delegators share in MEV upside. Operator's `effRate` applies to the full 600.

**Policy B — "block rewards only"**: `R = 500` for attribution purposes; MEV (80) and priority fees (20) are operator-only. Operator manually segregates by either:

- Routing MEV / priority fees to a different operator address (not the treasury), or
- Recording only `share_i` derived from block rewards. Operator withdraws the unallocated 100 tokens via `withdrawOperatorShare`.

This is a policy disclosure issue, not a math issue, but it has a real economic effect on delegators (Policy B silently extracts the MEV cut delegators implicitly received under the legacy split design). The audit dashboard must surface which policy an operator declared.

## Per-delegator override (advanced)

The on-chain contract enforces `effectiveRateBps` as the *ceiling*. The operator's `recordPeriodRevenue` can specify `share_i` values that, paired with the formula, produce effective rates *below* the ceiling for specific delegators. This lets an operator give long-term delegators a discount without changing the ceiling.

The off-chain runner computes:

```
share_i_adjusted = share_i_raw × (10000 - effRate_target_i) / (10000 - effRate_ceiling)
```

…and submits `share_i_adjusted` to the contract. The contract then computes the forward as if `effRate = effRate_ceiling`, which actually produces the desired per-delegator rate.

This is a useful escape valve but adds complexity. Recommend leaving it for v2.

## Sanity check: what if `origRate > effRate`?

The original split rate exceeds the operator's declared effective rate (the operator is being *more generous* than the split contract would have been).

Direct-pay design: no problem. The operator pays `share_i × (1 − effRate)` directly. The delegator gets more than they would have under the original split. The original split's rate is irrelevant since it's bypassed.

Split-routed design (which we're not using): formula breaks. `(10000 − effRate) / (10000 − origRate) > 1`, meaning the operator would have to forward more than the delegator's share to the split. The split would then distribute, paying the operator-side recipient more than `share_i` — net result: delegator can't get a lower effective rate than `origRate` because the split's math fights you.

This is one of the reasons direct-pay is the right design.
