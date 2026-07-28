import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { getAddress, type Address } from "viem"

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 20-byte hex address")
  .transform((v) => getAddress(v) as Address)

const urlSchema = z.string().url("must be a valid URL")
const uintStringSchema = z.string().regex(/^\d+$/, "must be a non-negative integer string")

/**
 * Flat schema by design: the example config is meant to be read top-to-bottom,
 * with recommended-default fields appearing first and operator-specific fields
 * (the ones you MUST set) appearing last. JSON's lack of comments + the way
 * key order tends to be preserved by editors mean flattening is the simplest
 * way to make ordering meaningful for the human reading the file.
 *
 * The example file is organised into three implicit sections:
 *
 *   1. **Tunable defaults** — `multicallAddress`, `logChunkSize`,
 *      `dustThreshold`, `runsDir`, `stakingRegistryDeployedAtBlock`.
 *      Sensible defaults, change only when you need to.
 *   2. **Network-specific** — `tokenAddress`, `stakingRegistryAddress`,
 *      `rollupAddress`. Look these up for your chain / deployment.
 *   3. **Operator-specific** — `providerId`, `distributionWalletAddress`,
 *      `rpcUrl`, `policyFile` / `policyUrl`. Set these per operator.
 */
const configSchema = z
  .object({
    // ───────── Tunables (have defaults; change only when needed) ─────────

    /** Multicall3 address. Same on every major EVM chain at the canonical
     *  deployment; only override if your chain has it somewhere else. */
    multicallAddress: addressSchema.default(
      getAddress("0xcA11bde05977b3631167028862bE2a173976CA11") as Address,
    ),

    /** disperse.app's batch-transfer contract. Used by `--output-mode
     *  disperse` (live EOA broadcast) to atomically fan out N ERC20 transfers
     *  in one tx after a single `approve`. The contract calls
     *  `token.transferFrom(msg.sender, recipient, amount)` internally, so
     *  only the wallet that CALLED disperse can have its allowance consumed
     *  — an attacker calling the same contract would spend their own
     *  allowance, not yours. This is why disperse is safe where the earlier
     *  `Multicall3.aggregate3([transferFrom(operator, …), …])` pattern was
     *  not (Multicall3 lets the caller specify an arbitrary `from`).
     *  Canonical mainnet deployment; override for other chains. */
    disperseAddress: addressSchema.default(
      getAddress("0xD152f549545093347A162Dce210e7293f1452150") as Address,
    ),

    /** Max blocks per `eth_getLogs` call during discovery. Most public RPCs
     *  cap at 10k blocks; lower this if you see range errors. */
    logChunkSize: uintStringSchema.default("10000").transform((v) => BigInt(v)),

    /** Block range per `eth_getLogs` call for the **stake-event scan**, which
     *  is filtered by `providerId` (indexed topic) and is therefore sparse —
     *  safe to use a wider range than `logChunkSize` on permissive RPCs. The
     *  default matches QuickNode's 10k cap; raise it (e.g. 100k or higher)
     *  on Alchemy/Infura/full-archive nodes to cut a ~140-call scan to <20. */
    stakeLogChunkSize: uintStringSchema.default("10000").transform((v) => BigInt(v)),

    /** Cap on RPC calls per second, to stay under the provider's rate limit
     *  (e.g. QuickNode free = 125/s). Proposer recovery makes one
     *  `eth_getTransactionByHash` per checkpoint; without a cap these trip the
     *  limit and get dropped, skewing results. Set to your plan's limit (a bit
     *  under, for margin). 0 = unlimited. If your provider rate-limits by HTTP
     *  request rather than by RPC sub-call, you can raise this well above the
     *  nominal limit (batching makes many sub-calls share one request). */
    rpcMaxRequestsPerSecond: z.number().int().min(0).max(1000000).default(100),

    /** Per-request HTTP timeout (ms). Unfiltered `eth_getLogs` over a wide
     *  block range can be slow on some RPCs; raise this (or lower
     *  `logChunkSize`) if you see request timeouts. */
    rpcTimeoutMs: z.number().int().min(1000).max(600000).default(30000),

    /** Skip transfers below this many token base units (after rate). */
    dustThreshold: uintStringSchema.default("0").transform((v) => BigInt(v)),

    /** How to divide the period's reward delta among delegators:
     *   - "proposals" (default): proportional to how many checkpoints each
     *     delegator's attester actually proposed in the window — attribution
     *     by real work. Requires the rollup's proposer views (an archival RPC).
     *   - "equal-split": divide evenly across all active delegators (a pool;
     *     ignores who did the work). Used automatically when delegatorsOverride
     *     is set, since that path has no attester→proposer mapping. */
    attributionMode: z.enum(["proposals", "equal-split"]).default("proposals"),

    /** Where to write audit records. */
    runsDir: z.string().default("./runs"),

    /** Block at which the StakingRegistry was deployed. Bounds the event
     *  scan so the runner doesn't crawl from genesis. Optional — if
     *  omitted, the runner binary-searches `eth_getCode` to find the
     *  deploy block automatically (~25 RPC calls). Set it to skip that. */
    stakingRegistryDeployedAtBlock: uintStringSchema.transform((v) => BigInt(v)).optional(),

    /** Block at which the Rollup was deployed. Used as the lower bound for
     *  the epoch resolver's binary searches over L1 history, so they don't
     *  needlessly probe blocks from genesis (each pre-deploy probe is a
     *  wasted RPC). Optional — if omitted, the resolver searches from 0,
     *  which works but is a few RPCs slower per binary search. The rollup
     *  and StakingRegistry are typically deployed in the same ignition run,
     *  so `stakingRegistryDeployedAtBlock` is a reasonable proxy if you only
     *  have one number handy. */
    rollupDeployedAtBlock: uintStringSchema.transform((v) => BigInt(v)).optional(),

    /** Escape hatch: bypass on-chain discovery and use this delegator list
     *  instead. Useful for tests, edge cases, or operators whose split
     *  setup the runner can't resolve. */
    delegatorsOverride: z.array(addressSchema).optional(),

    // ─────────── Network-specific (look these up per chain) ───────────

    /** Reward ERC20. */
    tokenAddress: addressSchema,

    /** ignition-contracts `StakingRegistry` — source of `StakedWithProvider`
     *  events; also exposes `PULL_SPLIT_FACTORY()` so the runner can decode
     *  the per-stake split recipient. */
    stakingRegistryAddress: addressSchema,

    /** Rollup instance the operator stakes against. Used for `getGSE()`
     *  derivation and the `IGSE.isRegistered` active-status filter. */
    rollupAddress: addressSchema,

    // ─────────── Operator-specific (set per operator) ───────────

    /** Operator's numeric provider id. */
    providerId: z.string().regex(/^\d+$/, "providerId must be a numeric string"),

    /** Wallet that receives the operator's coinbase rewards and (after this
     *  tool's batch executes) pays delegators. Any wallet the operator
     *  controls works — Safe / multisig / smart-account / EOA — the choice
     *  only affects how `--emit-calldata`'s output gets signed. */
    distributionWalletAddress: addressSchema,

    /** Commission this period, in basis points (10000 = 100%). The
     *  operator updates this value when they want to change the rate. */
    commissionBps: z.number().int().min(0).max(10000),

    /** Archival RPC (historical `balanceOf` + event scans). */
    rpcUrl: urlSchema,
  })

export type RunnerConfig = z.infer<typeof configSchema>

export function loadConfig(path: string): RunnerConfig {
  const absPath = resolve(process.cwd(), path)
  let raw: unknown
  try {
    const contents = readFileSync(absPath, "utf-8")
    // YAML is a strict superset of JSON, so this parses .json files too —
    // letting us migrate without breaking anyone still on the old format.
    raw = parseYaml(contents)
  } catch (err) {
    throw new Error(`Failed to read config at ${absPath}: ${(err as Error).message}`)
  }

  const result = configSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n")
    throw new Error(`Config validation failed:\n${issues}`)
  }
  return result.data
}

export function loadPrivateKey(): `0x${string}` {
  const pk = process.env.PRIVATE_KEY
  if (!pk) throw new Error("PRIVATE_KEY env var is required (or use --dry-run / --emit-calldata)")
  if (!/^0x[a-fA-F0-9]{64}$/.test(pk)) {
    throw new Error("PRIVATE_KEY must be a 0x-prefixed 32-byte hex string")
  }
  return pk as `0x${string}`
}
