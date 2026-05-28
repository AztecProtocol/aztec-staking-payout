# Trust Model

This tool produces calldata. It doesn't hold funds, doesn't deploy contracts, doesn't enforce any rate cap, and doesn't run automatically. Every settlement is an operator-initiated, operator-signed transaction. The trust contract between operator and delegators is **off-chain**: the operator commits (in whatever venue — README, docs, social) to a commission rate and a payout cadence, and delegators pick operators they trust to honour that commitment.

The audit artifact (`runs/epoch-*.json` per settlement) is what makes that commitment verifiable after the fact. Operators are strongly encouraged to publish their `runs/` directory to a public repo so delegators and third parties can spot-check that the math matches the operator's declared rate. See [the README's "Publish your runs/" section](../README.md#publish-your-runs-for-public-audit-strongly-recommended) for the recommended setup.

## What an honest operator commits to

In words a delegator can read and underwrite:

> "I will take `commissionBps / 10000` of each period's protocol-derived sequencer reward. I will run the settlement script every {cadence}. The full math — discovered delegators, per-attester checkpoint counts, the rollup's reward config snapshot, the encoded calldata I signed — lands in a JSON audit file you can re-verify against on-chain data."

That sentence is the whole trust contract. The tool gives delegators the means to *check* it, not the means to *enforce* it.

## What an attacker (or dishonest operator) can do

### 1. Take more than their declared commission

Edit `commissionBps` in config to a higher value than what was publicly committed, run the settlement, distribute less. Observable: the audit JSON records `commissionBps`; anyone re-running the tool with the published config (or comparing the recorded commission against the operator's public commitment) sees the discrepancy.

**Defence:** observability + reputation. The operator's standing takes a public hit; delegators can unstake. No on-chain recovery for the period that already happened.

### 2. Skip a settlement period entirely

Revenue accumulates in the operator's distribution wallet; delegators receive nothing. Observable: no new audit files appear in the operator's published runs/ directory.

**Defence:** same as above. Reputation + exit.

Note: there is no "claim" mechanism. If the operator stops running the tool, delegators can't self-serve their funds — the rewards sit in the operator's wallet under operator control. This is the central trust-asymmetry of a push-based design.

### 3. Run the settlement, then transfer the rest to themselves

Operator distributes the per-delegator amounts via the Multicall3 batch this tool produces, then sweeps the remainder to a personal address. This is honest behaviour — the remainder is the operator's retained commission. The risk is the operator transferring **more** than the remainder, e.g., sweeping everything *before* distributing.

**Defence:** the audit JSON records `totals.totalForwarded` and `totals.operatorRetention`; the on-chain transfer activity from the distribution wallet can be reconciled against those numbers. Any mismatch is a red flag.

**Residual risk:** transient fund loss is possible if the operator runs the tool against manipulated inputs (wrong rate, wrong delegator list). The audit JSON makes this visible after the fact but doesn't prevent it.

### 4. Capture MEV at a separate operator address

The distribution wallet only sees what its coinbase pulls in. MEV captured at a different address is invisible to this tool's reward calculation (which is the protocol-derived `checkpointReward × sequencerBps / 10000`, not anything measured from MEV flow).

**Defence:** operators should disclose MEV handling alongside their commission commitment. If an operator publicly commits "all MEV in pool", an outside auditor would need to compare declared coinbase MEV against on-chain Flashbots-style settlement and flag drift.

**Residual risk:** MEV is the largest "silent extraction" surface in any push-distribution design.

### 5. Run the script, then change the script

The settlement code is operator-controlled. An operator could:

- Run honest settlements for 6 months.
- Quietly fork this tool with code that under-pays by 1%.
- Continue indefinitely.

**Defence:** the audit JSON records inputs, intermediate values, the rollup reward-config snapshot, and the per-delegator amounts. Anyone running this *upstream* tool against the published config + the same epoch range should get byte-identical numbers for a fixed window. Drift is detectable.

### 6. Hot-key compromise of the distribution wallet

Attacker controls the wallet. Can transfer the entire balance immediately. There is no rate-change delay or ceiling to slow them down — the distribution wallet is whatever wallet the operator chose, with whatever signing flow that wallet has.

**Defence:** use a multisig (Safe is a common choice) with multiple operator-controlled keys. Even a 2-of-3 raises the bar for key compromise meaningfully. The `--emit-calldata` flow exists for exactly this — the tool produces a Safe Transaction Builder import; the actual sign + send happens through whatever signing UI the operator's wallet uses.

## What this tool genuinely gives delegators

1. **A deterministic, on-chain-verifiable reward formula.** The amount each delegator receives is `proposalsBy(theirAttester) × (checkpointReward × sequencerBps / 10000) × (1 − commissionBps/10000)`. Every input is publicly observable; the math is reproducible from on-chain data alone.
2. **A per-settlement audit artifact.** The `runs/epoch-*.json` file records every input, every intermediate value, the encoded calldata, and (for live runs) the broadcast tx hash. An auditor can re-derive the same numbers from the published config + the same epoch range.
3. **Lower fixed cost than a contract-based design.** No audit, no deployment, no migration story — operators can spin this up against any rollup deployment without protocol-level coordination.

What it does **not** give:

- **A claim mechanism.** If the operator stops distributing, delegators can't help themselves. Funds sit in the operator's wallet.
- **A hard on-chain commission ceiling.** The commission rate is a config field, not bytecode-enforced. Changes between runs are visible in the audit JSON but not prevented.
- **Drain-resistance.** The distribution wallet can be emptied to the operator's personal address at any time, including mid-settlement.

## Conditions for this tool to be a good trade for the delegator

1. **The operator is known and reputation-bearing.** Foundation, established staking provider, or any entity whose public reputation has more value to them than the upside of cheating. Most retail third-party operators do not meet this bar.
2. **The operator publishes their `runs/` directory.** Without a public audit trail, the trust model collapses to "trust me bro". The tool's design assumes operators publish; delegators staking with operators who don't are running on much weaker ground.
3. **The delegator has accepted the trade explicitly.** This isn't a substitute for an on-chain commission cap. Delegators should understand they're staking against an off-chain commitment, not an on-chain one.

If these don't hold, an on-chain treasury / commission-contract design is more appropriate than this tool.
