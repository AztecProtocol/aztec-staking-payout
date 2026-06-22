# Per-Attester Attribution

## The rule

Revenue attributable to a delegator is the **stake-weighted share** of the revenue earned by the attester(s) they delegate to — **not** a pool across all attesters under the operator's provider.

Concretely, if delegator `X` stakes 100 on attester `A` and attester `A` earns 1000 in a period, `X`'s pro-rata share from that attester is `1000 × (100 / S_A)` where `S_A` is total stake on `A`.

If `X` stakes on multiple attesters under the same provider, sum across attesters. If `X` and another delegator `Y` stake on different attesters under the same provider, **they do not pool**. A lucky attester week benefits its own delegators only.

## Why this matters

The temptation under a single operator's provider is to compute `totalRevenue / totalStake` and call it a day. That's wrong. It silently redistributes from delegators on lucky attesters to delegators on unlucky ones, even though the attester each delegator chose is the entity that actually proposed the blocks.

Two delegators on the same provider with identical stake but on different attesters can earn meaningfully different amounts in a given period. The audit indexer surfaces this; the runner aggregates per-(delegator, attester) lines from the indexer rather than re-pooling.

## Source of truth: the indexer

The runner does **not** recompute pro-rata from raw block events. It calls the indexer's per-period revenue endpoint, which returns per-(attester, delegator) shares already, and aggregates per delegator.

This is intentional. Reimplementing attribution in the runner creates a second source of truth that will drift. The indexer is the single authority on what each delegator earned, and the runner is a consumer.

## Worked example

Operator runs attesters A and B under the same provider id. Period revenue:

- Attester A earned 1000 tokens
- Attester B earned 600 tokens

Delegations:

- Delegator 1: 200 stake on A, 0 on B
- Delegator 2: 100 stake on A, 300 on B
- Delegator 3: 0 on A, 100 on B

Total stake on A: 300. Total stake on B: 400.

Per-delegator shares (pro-rata by stake on each attester, summed across attesters):

| Delegator | Share from A | Share from B | Total share |
|---|---|---|---|
| 1 | 1000 × 200/300 = 666.67 | 0 | **666.67** |
| 2 | 1000 × 100/300 = 333.33 | 600 × 300/400 = 450 | **783.33** |
| 3 | 0 | 600 × 100/400 = 150 | **150** |

The runner submits these `Total share` values onward — as the per-recipient `amount`s in the Multicall3 batch of `ERC20.transfer` calls. See [math.md](./math.md) for how the operator's commission rate is applied on top.

## Edge cases

- **Stake changes mid-period.** A stake-time-weighted average should be used over the period, not a snapshot. If a delegator unstakes mid-period they should receive a partial share. (Note: the current runner approximates this via proposal counts during the window — see [runner-reference.md](./runner-reference.md).)
- **Attester with zero stake.** Cannot happen — the rollup will not assign block proposals to an attester with no delegators. If it ever did, the revenue from that attester is operator-only and should not appear in delegator attribution.
- **Multiple providers, shared attesters.** Out of scope. The protocol's current model is one provider per attester. If that changes, attribution becomes a join across `(attester, provider, delegator)` and the indexer endpoint signature changes.

## What this does NOT cover

- **The effective rate.** Once you have a delegator's `share`, what fraction is forwarded vs retained is the rate question, covered in [math.md](./math.md).
- **MEV / priority-fee inclusion.** Whether MEV is part of the revenue pool is a policy disclosure, not an attribution question. The indexer reports what landed at the coinbase; whether the operator's policy treats coinbase MEV as "delegator-eligible" or "operator-only" is declared off-chain.
- **Cross-provider movement.** A delegator who migrates between providers mid-period earns from each based on time-weighted stake. The indexer's per-period query already handles this if implemented correctly.
