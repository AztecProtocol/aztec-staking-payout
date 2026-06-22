#!/usr/bin/env node
import { loadConfig, loadPrivateKey } from "./config.js"
import { makePublicClient } from "./client.js"
import { settle } from "./settle.js"
import { discoverActiveDelegators, findDeployBlock, probeProviderIds } from "./discovery.js"
import { createInlineProgress } from "./progress.js"
import type { OutputMode } from "./types.js"

interface ParsedArgs {
  command: "settle" | "status" | "help"
  configPath: string
  dryRun: boolean
  /** True when `--emit-calldata` was given (with or without a path). */
  emitSafeImport: boolean
  /** Path argument passed after `--emit-calldata`, if any. `null` means "use
   *  the default" (sibling of the audit JSON). */
  safeImportPath: string | null
  /** Settlement window — epoch range (the resolver derives the L1 block range). */
  fromEpoch: bigint | null
  /** `null` here means "use the rollup's latest proven epoch". */
  toEpoch: bigint | null
  /** Manual override of the reward amount (testing / what-if). Forces dry-run. */
  simulateReward: bigint | null
  /** Output shape for the planned txs. `null` = auto (safe for --emit-calldata,
   *  multicall for live broadcast). */
  outputMode: OutputMode | null
  /** Count every operator checkpoint regardless of `header.coinbase`. Default
   *  is to count only checkpoints whose coinbase equals the configured
   *  distribution wallet — the integrity gate against mid-window coinbase
   *  switches. Opt in for testnet runs / what-if simulation. */
  ignoreCoinbase: boolean
}

const ERC20_BALANCE_OF_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const

function printUsage(): void {
  process.stderr.write(`
aztec-staking-payout — weekly delegator payout tool for Aztec sequencer operators

Usage:
  aztec-staking-payout <command> [options]

Commands:
  settle             Compute the period's per-delegator transfers and either
                     broadcast them (live) or emit Safe Transaction Builder
                     calldata for a multisig / smart-account / cold-wallet
                     signer. See --output-mode for transaction shaping.
  status             Print the distribution wallet's current token balance,
                     the configured commission, and the discovered active
                     delegators.
  help               Print this message.

Options:
  --config <path>             Path to runner config (YAML or JSON). Defaults
                              to RUNNER_CONFIG env var or
                              ./config.example.yaml.
  --from-epoch <n>            (settle only) First L2 epoch in the settlement
                              window (inclusive). Required. Operator advances
                              this to (previous run's --to-epoch + 1) each
                              cycle — no gaps, no overlap. The L1 block range
                              is derived automatically and gated on both
                              "epoch proven on rollup" and "L1-finalized".
  --to-epoch <n|latest-proven>
                              (settle only) Last L2 epoch in the window
                              (inclusive). Defaults to 'latest-proven' — the
                              rollup's most recent fully-proven epoch at L1
                              finality. Pin a number for reproducible runs.
  --dry-run                   (settle) Compute the plan but don't send.
                              Writes an audit record with status="dry-run".
                              No PRIVATE_KEY required.
  --emit-calldata [<path>]    (settle) Don't broadcast — instead write the
                              encoded transactions to the audit JSON plus a
                              sibling .safe.json (Safe Transaction Builder
                              import format, also accepted by many other
                              multisigs). <path> is optional: omit to write
                              next to the audit JSON
                              (runs/epoch-<from>-<to>-<runId>.safe.json).
                              No PRIVATE_KEY required. Full per-recipient
                              breakdown + encoded calldata live in the audit
                              JSON — no separate summary file is written.
  --output-mode <mode>        (settle) Shape of the planned transactions:
                                safe       N top-level ERC20.transfer calls
                                           (one per delegator). The Safe wraps
                                           them in MultiSend; works for Safes,
                                           smart-account wallets, and cold-
                                           wallet EOAs signing one by one.
                                multicall  Optional ERC20.approve(Multicall3,
                                           total) + Multicall3.aggregate3 of
                                           N transferFrom calls. Fewer txs,
                                           but requires a plain EOA — Safes
                                           CANNOT use this (the inner transfer
                                           reverts with insufficient balance
                                           on Multicall3).
                              Defaults: 'safe' with --emit-calldata,
                              'multicall' for live broadcast. Pin explicitly
                              for a cold-wallet EOA that wants the batched
                              shape via --emit-calldata.
  --ignore-coinbase           (settle) Count every checkpoint proposed by the
                              operator's attesters in the window regardless of
                              the per-checkpoint header.coinbase. By default
                              the tool only counts checkpoints whose coinbase
                              matches the configured distributionWalletAddress
                              — the integrity gate against mid-window coinbase
                              switches (a counted checkpoint whose reward
                              routed elsewhere isn't payable from the
                              distribution wallet). Use this for testnet runs,
                              what-if simulation, or when you've manually
                              pre-funded the distribution wallet to cover a
                              prior-coinbase period.
  --simulate-reward <amount>  (settle) Manual override of the reward amount.
                              By default the tool computes the reward via the
                              protocol formula (oursProposed × checkpointReward
                              × sequencerBps / 10000); use this flag to pin a
                              hypothetical amount in token base units. Forces
                              dry-run as a safety. Required for
                              attributionMode=equal-split (which has no
                              proposal count to multiply by). No PRIVATE_KEY
                              required.

Environment:
  PRIVATE_KEY        Required only when live mode + the distribution wallet
                     is an EOA controlled by this key. Safes use
                     --emit-calldata instead.
  RUNNER_CONFIG      Default config path if --config not given.

Exit codes:
  0  success
  1  user/config error
  2  pre-flight failure (balance shortfall, discovery error, etc.)
  3  on-chain failure (tx reverted)
`)
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2)
  const out: ParsedArgs = {
    command: "help",
    configPath: process.env.RUNNER_CONFIG ?? "./config.example.yaml",
    dryRun: false,
    emitSafeImport: false,
    safeImportPath: null,
    fromEpoch: null,
    toEpoch: null,
    simulateReward: null,
    outputMode: null,
    ignoreCoinbase: false,
  }

  if (args.length === 0) return out

  let i = 0
  const cmd = args[i++]
  if (cmd === "settle" || cmd === "status" || cmd === "help") {
    out.command = cmd
  } else if (cmd === "--help" || cmd === "-h") {
    out.command = "help"
  } else {
    process.stderr.write(`Unknown command: ${cmd}\n`)
    out.command = "help"
    return out
  }

  while (i < args.length) {
    const arg = args[i++]
    if (arg === "--config") out.configPath = required(args[i++], "--config")
    else if (arg === "--dry-run") out.dryRun = true
    else if (arg === "--emit-calldata") {
      out.emitSafeImport = true
      // Path arg is optional: only consume the next token if it isn't itself
      // a flag (a value beginning with `--`). Otherwise the path stays null
      // and settle.ts uses the audit-sibling default.
      const next = args[i]
      if (next !== undefined && !next.startsWith("--")) {
        out.safeImportPath = next
        i++
      }
    }
    else if (arg === "--simulate-reward")
      out.simulateReward = parseAmount(required(args[i++], "--simulate-reward"))
    else if (arg === "--output-mode") {
      const v = required(args[i++], "--output-mode")
      if (v !== "safe" && v !== "multicall") {
        process.stderr.write(`--output-mode must be 'safe' or 'multicall', got: ${v}\n`)
        process.exit(1)
      }
      out.outputMode = v
    }
    else if (arg === "--ignore-coinbase") out.ignoreCoinbase = true
    else if (arg === "--from-epoch")
      out.fromEpoch = parseEpoch(required(args[i++], "--from-epoch"))
    else if (arg === "--to-epoch") {
      const v = required(args[i++], "--to-epoch")
      // `latest-proven` stays `null` and is resolved by the epoch resolver
      // against the rollup at run time.
      out.toEpoch = v === "latest-proven" ? null : parseEpoch(v)
    } else if (arg === "--help" || arg === "-h") out.command = "help"
    else {
      process.stderr.write(`Unknown argument: ${arg}\n`)
      out.command = "help"
      break
    }
  }
  return out
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    process.stderr.write(`${name} requires a value\n`)
    process.exit(1)
  }
  return value
}

function parseEpoch(raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    process.stderr.write(`Epoch number must be a non-negative integer (or "latest-proven"), got: ${raw}\n`)
    process.exit(1)
  }
  return BigInt(raw)
}

function parseAmount(raw: string): bigint {
  if (!/^\d+$/.test(raw) || raw === "0") {
    process.stderr.write(`--simulate-reward must be a positive integer (token base units), got: ${raw}\n`)
    process.exit(1)
  }
  return BigInt(raw)
}

async function runSettle(parsed: ParsedArgs): Promise<number> {
  let config
  try {
    config = loadConfig(parsed.configPath)
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }

  if (parsed.fromEpoch === null) {
    process.stderr.write(
      `settle requires --from-epoch <n>. Use the previous run's --to-epoch + 1 ` +
        `(epoch ranges are inclusive on both ends).\n`,
    )
    return 1
  }
  // toEpoch === null is the explicit "latest-proven" sentinel — the resolver
  // turns it into a concrete number against the rollup.

  // Simulation never sends and never emits calldata — it's a what-if view.
  const willSend =
    !parsed.dryRun && !parsed.emitSafeImport && parsed.simulateReward === null
  let privateKey: `0x${string}` | null = null
  if (willSend) {
    try {
      privateKey = loadPrivateKey()
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`)
      return 1
    }
  }

  try {
    await settle({
      config,
      privateKey,
      fromEpoch: parsed.fromEpoch,
      toEpoch: parsed.toEpoch,
      dryRun: parsed.dryRun,
      emitSafeImport: parsed.emitSafeImport,
      safeImportPath: parsed.safeImportPath,
      simulateReward: parsed.simulateReward,
      outputMode: parsed.outputMode,
      ignoreCoinbase: parsed.ignoreCoinbase,
    })
    return 0
  } catch (err) {
    const msg = (err as Error).message
    if (msg.includes("reverted")) {
      process.stderr.write(`On-chain failure: ${msg}\n`)
      return 3
    }
    process.stderr.write(`Pre-flight failure: ${msg}\n`)
    return 2
  }
}

async function runStatus(parsed: ParsedArgs): Promise<number> {
  let config
  try {
    config = loadConfig(parsed.configPath)
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }

  try {
    const { client, meter } = makePublicClient(config)
    const [balance, chainId, head] = await Promise.all([
      client.readContract({
        address: config.tokenAddress,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [config.distributionWalletAddress],
      }),
      client.getChainId(),
      client.getBlockNumber(),
    ])

    process.stdout.write(`Distribution wallet:  ${config.distributionWalletAddress}\n`)
    process.stdout.write(`Token:                ${config.tokenAddress}\n`)
    process.stdout.write(`Current balance:      ${balance.toString()}\n`)
    process.stdout.write(`Commission:           ${(config.commissionBps / 100).toFixed(2)}%\n`)
    process.stdout.write(`Chain ID:             ${chainId}\n`)
    process.stdout.write(`Current block:        ${head}\n`)
    process.stdout.write(`Staking registry:     ${config.stakingRegistryAddress}\n`)
    process.stdout.write(`Rollup:               ${config.rollupAddress}\n`)
    process.stdout.write(`\n`)

    // Discover active delegators (or print override if configured)
    try {
      if (config.delegatorsOverride && config.delegatorsOverride.length > 0) {
        process.stdout.write(
          `Active delegators (${config.delegatorsOverride.length}, from config override):\n`,
        )
        for (const d of config.delegatorsOverride) {
          process.stdout.write(`  · ${d}\n`)
        }
      } else {
        // Delegator discovery ALWAYS scans from the registry's deploy block
        // to head — it's about *who has staked*, independent of any
        // settlement window. `--from-epoch`/`--to-epoch` are settlement-only
        // (settle) and don't apply here.
        if (parsed.fromEpoch !== null || parsed.toEpoch !== null) {
          process.stdout.write(
            `Note: --from-epoch / --to-epoch are ignored by 'status' — delegator discovery always scans the full registry history.\n`,
          )
        }
        // 0 (or omitted) means "auto-detect" — block 0 is never a real
        // deploy block, and scanning from genesis is what we avoid.
        let scanFrom: bigint
        if (config.stakingRegistryDeployedAtBlock !== undefined && config.stakingRegistryDeployedAtBlock > 0n) {
          scanFrom = config.stakingRegistryDeployedAtBlock
        } else {
          process.stdout.write(`Auto-detecting StakingRegistry deploy block…\n`)
          scanFrom = await findDeployBlock(client, config.stakingRegistryAddress, head)
          process.stdout.write(`StakingRegistry deployed at block ${scanFrom}\n`)
        }
        const scanTo = head
        process.stdout.write(`Discovering active delegators (blocks ${scanFrom}–${scanTo})…\n`)
        const progress = createInlineProgress()
        let result
        try {
          result = await discoverActiveDelegators({
            client,
            stakingRegistryAddress: config.stakingRegistryAddress,
            rollupAddress: config.rollupAddress,
            multicallAddress: config.multicallAddress,
            providerId: BigInt(config.providerId),
            fromBlock: scanFrom,
            toBlock: scanTo,
            logChunkSize: config.logChunkSize,
            stakeLogChunkSize: config.stakeLogChunkSize,
            retryMeter: meter,
            onProgress: progress.onProgress,
          })
        } finally {
          progress.done()
        }
        const { delegators, stats } = result
        process.stdout.write(
          `Funnel:               ${stats.stakeEventsFound} stake event(s) → ${stats.uniqueAttesters} attester(s) → ${stats.registeredOnRollup} active on rollup\n`,
        )
        process.stdout.write(`Active delegators (${delegators.length}):\n`)
        for (const d of delegators) {
          process.stdout.write(`  · attester ${d.attester} → ${d.delegator} (${d.delegatorSource})\n`)
        }
        if (delegators.length === 0) {
          if (stats.stakeEventsFound === 0) {
            // Probe without the providerId filter to tell apart "wrong
            // providerId" from "wrong address / event / range".
            process.stdout.write(`  no events for providerId ${config.providerId} — probing all providers…\n`)
            const probe = await probeProviderIds({
              client,
              stakingRegistryAddress: config.stakingRegistryAddress,
              fromBlock: scanFrom,
              toBlock: scanTo,
              logChunkSize: config.logChunkSize,
            })
            if (probe.totalEvents === 0) {
              process.stdout.write(
                `  No StakedWithProvider events from ${config.stakingRegistryAddress} in blocks ${scanFrom}–${scanTo}.\n` +
                  `    → Likely wrong stakingRegistryAddress, wrong chain, or stakes predate the range.\n` +
                  `    → Try widening the scan: clear stakingRegistryDeployedAtBlock in config to auto-detect the deploy block.\n`,
              )
            } else {
              process.stdout.write(
                `  Found ${probe.totalEvents} stake event(s), but for other providerId(s): ${probe.providerIds.join(", ")}.\n` +
                  `    → Your configured providerId (${config.providerId}) has no stakes here; use one of the above.\n`,
              )
            }
          } else {
            process.stdout.write(
              `  (stakes found but none active on rollup ${config.rollupAddress} — check rollupAddress)\n`,
            )
          }
        }
      }
    } catch (err) {
      process.stdout.write(`Discovery failed: ${(err as Error).message}\n`)
    }
    const primary = meter.count - meter.retries
    process.stdout.write(`\nRPC requests sent: ${meter.count}  (${primary} primary + ${meter.retries} retries)\n`)
    return 0
  } catch (err) {
    process.stderr.write(`Status read failed: ${(err as Error).message}\n`)
    return 2
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv)
  switch (parsed.command) {
    case "settle":
      return runSettle(parsed)
    case "status":
      return runStatus(parsed)
    case "help":
      printUsage()
      return 0
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `Unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    )
    process.exit(99)
  })
