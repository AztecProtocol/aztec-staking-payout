import {
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  keccak256,
  parseAbiItem,
  recoverAddress,
  recoverMessageAddress,
  toFunctionSelector,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import { mapWithConcurrency, withRetry } from "./concurrency.js"

/**
 * `CheckpointProposed` — emitted by the rollup's `propose()` for every L2
 * checkpoint that lands on L1 (ProposeLib.sol). `checkpointNumber` is indexed;
 * the log also carries the `transactionHash` of the `propose()` call, which is
 * all we need to recover the proposer.
 *
 *   event CheckpointProposed(
 *     uint256 indexed checkpointNumber,
 *     bytes32 indexed archive,
 *     bytes32[] versionedBlobHashes,
 *     bytes32 payloadDigest,
 *     bytes32 attestationsHash
 *   );
 */
export const CHECKPOINT_PROPOSED_EVENT = parseAbiItem(
  "event CheckpointProposed(uint256 indexed checkpointNumber, bytes32 indexed archive, bytes32[] versionedBlobHashes, bytes32 payloadDigest, bytes32 attestationsHash)",
)

/**
 * The `propose()` function ABI — used to decode the transaction calldata. We
 * only consume `_attestations`, `_signers` and `_attestationsAndSignersSignature`,
 * but ABI decoding is positional so the full shape is required.
 *
 * Two variants exist on mainnet. The v5 rollup (AZUP-2 upgrade) appended
 * `accumulatedFees` to `ProposedHeader` (ProposedHeaderLib.sol), changing the
 * function selector; every other parameter — attestations, signers, the
 * proposer's signature, blob input — is positionally identical, and
 * `header.coinbase` sits at the same component index. We build both ABIs from
 * a shared template and pick by selector at decode time, so settlements on
 * either rollup (and historical re-verification of v4 audits) keep working.
 */
const buildProposeAbi = (headerExtraComponents: readonly { name: string; type: string }[]) =>
  [
    {
      name: "propose",
      type: "function",
      stateMutability: "nonpayable",
      inputs: [
        {
          name: "_args",
          type: "tuple",
          components: [
            { name: "archive", type: "bytes32" },
            {
              name: "oracleInput",
              type: "tuple",
              components: [{ name: "feeAssetPriceModifier", type: "int256" }],
            },
            {
              name: "header",
              type: "tuple",
              components: [
                { name: "lastArchiveRoot", type: "bytes32" },
                { name: "blockHeadersHash", type: "bytes32" },
                { name: "blobsHash", type: "bytes32" },
                { name: "inHash", type: "bytes32" },
                { name: "outHash", type: "bytes32" },
                { name: "slotNumber", type: "uint256" },
                { name: "timestamp", type: "uint256" },
                { name: "coinbase", type: "address" },
                { name: "feeRecipient", type: "bytes32" },
                {
                  name: "gasFees",
                  type: "tuple",
                  components: [
                    { name: "feePerDaGas", type: "uint128" },
                    { name: "feePerL2Gas", type: "uint128" },
                  ],
                },
                { name: "totalManaUsed", type: "uint256" },
                ...headerExtraComponents,
              ],
            },
          ],
        },
        {
          name: "_attestations",
          type: "tuple",
          components: [
            { name: "signatureIndices", type: "bytes" },
            { name: "signaturesOrAddresses", type: "bytes" },
          ],
        },
        { name: "_signers", type: "address[]" },
        {
          name: "_attestationsAndSignersSignature",
          type: "tuple",
          components: [
            { name: "v", type: "uint8" },
            { name: "r", type: "bytes32" },
            { name: "s", type: "bytes32" },
          ],
        },
        { name: "_blobInput", type: "bytes" },
      ],
      outputs: [],
    },
  ] as const

/** v4 rollup: header ends at `totalManaUsed`. */
const PROPOSE_ABI_V4 = buildProposeAbi([])
/** v5 rollup (AZUP-2): header gained `accumulatedFees`. */
const PROPOSE_ABI_V5 = buildProposeAbi([{ name: "accumulatedFees", type: "uint256" }])

/**
 * Sequencers commonly submit `propose()` wrapped inside a Multicall3 batch
 * (`aggregate3` / `aggregate`) rather than calling the rollup directly. We
 * unwrap those to find the inner `propose()` call.
 */
const AGGREGATE3_ABI = [
  {
    name: "aggregate3",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const

const AGGREGATE_ABI = [
  {
    name: "aggregate",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const

/** Known `propose()` selectors → the ABI that decodes them and the rollup
 *  version, which determines the proposer-signature digest scheme (v4 signs
 *  an EIP-191 message over a domain-enum-prefixed hash; v5 signs EIP-712
 *  typed data bound to the rollup contract — see
 *  `recoverProposerAndCoinbaseFromCalldata`). */
type ProposeVariant = {
  abi: typeof PROPOSE_ABI_V4 | typeof PROPOSE_ABI_V5
  version: "v4" | "v5"
}
const PROPOSE_ABI_BY_SELECTOR = new Map<string, ProposeVariant>([
  [toFunctionSelector(PROPOSE_ABI_V4[0]).toLowerCase(), { abi: PROPOSE_ABI_V4, version: "v4" }],
  [toFunctionSelector(PROPOSE_ABI_V5[0]).toLowerCase(), { abi: PROPOSE_ABI_V5, version: "v5" }],
])
const AGGREGATE3_SELECTOR = toFunctionSelector(AGGREGATE3_ABI[0]).toLowerCase()
const AGGREGATE_SELECTOR = toFunctionSelector(AGGREGATE_ABI[0]).toLowerCase()

/**
 * Extract the `propose()` calldata from a transaction's input — whether the
 * sequencer called `propose()` directly or wrapped it in a Multicall3
 * `aggregate3`/`aggregate` batch. Matches any known propose variant (v4 or
 * v5 selector). Prefers an inner call targeting the rollup, but falls back
 * to any inner call bearing a `propose()` selector.
 */
function extractProposeCalldata(input: Hex, rollupAddress: Address): Hex {
  const sel = input.slice(0, 10).toLowerCase()
  if (PROPOSE_ABI_BY_SELECTOR.has(sel)) return input

  const aggAbi =
    sel === AGGREGATE3_SELECTOR ? AGGREGATE3_ABI : sel === AGGREGATE_SELECTOR ? AGGREGATE_ABI : null
  const calls = aggAbi
    ? (decodeFunctionData({ abi: aggAbi, data: input }).args[0] as readonly {
        target: Address
        callData: Hex
      }[])
    : []
  const isPropose = (d: Hex) => PROPOSE_ABI_BY_SELECTOR.has(d.slice(0, 10).toLowerCase())
  const inner =
    calls.find((c) => isPropose(c.callData) && c.target.toLowerCase() === rollupAddress.toLowerCase()) ??
    calls.find((c) => isPropose(c.callData))
  if (inner) return inner.callData

  // Name the unrecognised inner selectors, not just the outer wrapper — the
  // wrapper is usually Multicall3 and says nothing about the real mismatch
  // when a new rollup version changes the propose() signature.
  const innerSelectors = calls.map((c) => c.callData.slice(0, 10).toLowerCase())
  throw new Error(
    `no known propose() call found in tx (outer selector ${sel}` +
      (innerSelectors.length > 0 ? `; inner selectors ${innerSelectors.join(", ")}` : ``) +
      `). Known propose selectors: ${[...PROPOSE_ABI_BY_SELECTOR.keys()].join(", ")} — ` +
      `a new rollup version may have changed the propose() signature.`,
  )
}

/** ABI parameter shapes for the attestations-and-signers digest preimage. */
const ATTESTATIONS_TUPLE = {
  type: "tuple",
  components: [
    { name: "signatureIndices", type: "bytes" },
    { name: "signaturesOrAddresses", type: "bytes" },
  ],
} as const

/**
 * `SignatureDomainSeparator.attestationsAndSigners` — enum index 2
 * (v4 AttestationLib.sol: checkpointProposal=0, checkpointAttestation=1,
 * attestationsAndSigners=2). Mixed into the digest the proposer signs on v4.
 */
const DOMAIN_ATTESTATIONS_AND_SIGNERS = 2

/** v5 signs EIP-712 typed data: domain ("Aztec Rollup", "1", chainId,
 *  rollupAddress) over `AttestationsAndSigners(bytes32 payloadHash)` where
 *  payloadHash = keccak256(abi.encode(_attestations, _signers)) — see
 *  AttestationLib.getAttestationsAndSignersDigest →
 *  CoordinationSignatureLib.attestationsAndSignersDigest. */
const V5_EIP712_DOMAIN_NAME = "Aztec Rollup"
const V5_EIP712_DOMAIN_VERSION = "1"
const V5_EIP712_TYPES = {
  AttestationsAndSigners: [{ name: "payloadHash", type: "bytes32" }],
} as const

type DecodedAttestations = { signatureIndices: Hex; signaturesOrAddresses: Hex }
type DecodedSignature = { v: number; r: Hex; s: Hex }

/**
 * Decode `proposer` (from the signature) and `coinbase` (from
 * `_args.header.coinbase`) of a checkpoint from its `propose()` calldata.
 *
 * The proposer signs over `_attestations` and `_signers`; recovering that
 * signer yields the proposer attester address directly, with no committee
 * sampling, seed, or historical state. The digest scheme differs by rollup
 * version (selected via the propose() selector):
 *
 *   - v4: EIP-191 personal message over
 *     `keccak256(abi.encode(uint8(2), _attestations, _signers))`
 *     (ValidatorSelectionLib.verifyProposer, AttestationLib domain enum).
 *   - v5: EIP-712 typed data — domain ("Aztec Rollup", "1", chainId, rollup)
 *     over `AttestationsAndSigners(bytes32 payloadHash)` with
 *     `payloadHash = keccak256(abi.encode(_attestations, _signers))`;
 *     recovered from the RAW digest (no EIP-191 prefix) —
 *     CoordinationSignatureLib.attestationsAndSignersDigest.
 *
 * The coinbase is the address the rollup credits with `sequencerRewards[…]`
 * for this checkpoint — i.e. the wallet that *actually* gets paid. We surface
 * it so the caller can filter to "checkpoints that paid this operator's
 * distribution wallet", which is the on-chain ground truth for the period's
 * earned reward (and is invariant to any sequencer misconfiguration where a
 * proposal lands but the operator's wallet doesn't get credit).
 */
async function recoverProposerAndCoinbaseFromCalldata(
  input: Hex,
  rollupAddress: Address,
  chainId: number,
): Promise<{ proposer: Address; coinbase: Address }> {
  const proposeData = extractProposeCalldata(input, rollupAddress)
  // Selector is guaranteed known here — extractProposeCalldata only returns
  // calldata whose selector is in the map.
  const variant = PROPOSE_ABI_BY_SELECTOR.get(proposeData.slice(0, 10).toLowerCase())!
  const { args } = decodeFunctionData({ abi: variant.abi, data: proposeData })
  // _args.header.coinbase — element 0 of the args tuple, then `.header.coinbase`.
  const argsTuple = args[0] as { header: { coinbase: Address } }
  const coinbase = argsTuple.header.coinbase
  const attestations = args[1] as DecodedAttestations
  const signers = args[2] as readonly Address[]
  const signature = args[3] as DecodedSignature

  let proposer: Address
  if (variant.version === "v4") {
    const digest = keccak256(
      encodeAbiParameters(
        [{ type: "uint8" }, ATTESTATIONS_TUPLE, { type: "address[]" }],
        [DOMAIN_ATTESTATIONS_AND_SIGNERS, attestations, signers as Address[]],
      ),
    )
    proposer = await recoverMessageAddress({
      message: { raw: digest },
      signature: { r: signature.r, s: signature.s, v: BigInt(signature.v) },
    })
  } else {
    const payloadHash = keccak256(
      encodeAbiParameters(
        [ATTESTATIONS_TUPLE, { type: "address[]" }],
        [attestations, signers as Address[]],
      ),
    )
    const digest = hashTypedData({
      domain: {
        name: V5_EIP712_DOMAIN_NAME,
        version: V5_EIP712_DOMAIN_VERSION,
        chainId,
        verifyingContract: rollupAddress,
      },
      types: V5_EIP712_TYPES,
      primaryType: "AttestationsAndSigners",
      message: { payloadHash },
    })
    proposer = await recoverAddress({
      hash: digest,
      signature: { r: signature.r, s: signature.s, v: BigInt(signature.v) },
    })
  }
  return { proposer, coinbase }
}

export type ProposalProgress =
  | { phase: "scanning-checkpoints"; fromBlock: bigint; toBlock: bigint; scannedTo: bigint; found: number }
  | { phase: "recovering-proposers"; resolved: number; total: number }

export interface ProposalCountsInput {
  client: PublicClient
  rollupAddress: Address
  /** Kept for interface symmetry; the calldata path doesn't need Multicall3. */
  multicallAddress: Address
  /** L1 block range to scan for `CheckpointProposed` events. The epoch
   *  resolver picks this generously enough to bracket every proposal in
   *  `[minCheckpointNumber, maxCheckpointNumber]`; the checkpoint-number
   *  filter below is the precise gate. */
  fromBlock: bigint
  toBlock: bigint
  logChunkSize: bigint
  /** Drop checkpoints with `checkpointNumber < minCheckpointNumber` — used by
   *  the epoch gate (first checkpoint of `fromEpoch`). Omit to keep all. */
  minCheckpointNumber?: bigint
  /** Drop checkpoints with `checkpointNumber > maxCheckpointNumber` — used by
   *  the epoch gate (last checkpoint of `toEpoch`, ≤ the proven tip). Omit to
   *  keep all. */
  maxCheckpointNumber?: bigint
  /** Optional retry counter — incremented per scheduled retry. */
  retryMeter?: { retries: number }
  onProgress?: (p: ProposalProgress) => void
}

/**
 * One resolved checkpoint and the attester who proposed it. The caller can
 * filter this list to its own attesters and surface the full attribution
 * trail in the audit record (so a delegator or independent auditor can
 * recompute the split by looking up each checkpoint on chain).
 */
export interface AttributedCheckpoint {
  checkpointNumber: bigint
  txHash: Hex
  blockNumber: bigint
  /** Attester recovered from the proposer's signature on the `propose()` tx. */
  proposer: Address
  /** `header.coinbase` of this checkpoint — the wallet the rollup credits via
   *  `sequencerRewards[coinbase]` when the epoch's proof lands. The on-chain
   *  ground truth for "who got paid for this checkpoint", regardless of which
   *  attester proposed it. */
  coinbase: Address
}

export interface ProposalCounts {
  /** proposer attester address (lowercased) → checkpoints proposed in window.
   *  Includes all proposers; the caller filters to its own attesters. */
  countsByProposer: Map<string, number>
  /** Per-checkpoint attribution trail — one entry per *resolved* checkpoint,
   *  in event order. Caller filters to its own attesters for the audit. */
  attributed: AttributedCheckpoint[]
  totalCheckpoints: number
  resolvedCheckpoints: number
  /** Checkpoints whose proposer we couldn't recover (tx fetch/decode failed).
   *  Surfaced, never hidden. */
  unresolvedCheckpoints: number
  /** Checkpoints we filtered out because their `checkpointNumber` fell
   *  outside `[minCheckpointNumber, maxCheckpointNumber]` — proposals from
   *  adjacent epochs that happened to land in the scanned block range but
   *  don't belong to this settlement's epoch window. Always 0 when no filter
   *  bounds are passed. */
  outOfRangeCheckpoints: number
  /** Number of `CheckpointProposed` events dropped because a later event for
   *  the same `checkpointNumber` superseded them. Non-zero indicates the
   *  rollup pruned and re-used checkpoint numbers within this scan range
   *  (typical when proofs missed their deadline and the chain rewound). The
   *  reward calculation uses only the latest event per number — that's the
   *  one whose proposer is in the current proven chain and earned the
   *  reward. The older events earned nothing and shouldn't be counted. */
  prunedAndReusedCheckpoints: number
  /** First recovery error, if any — so mass-unresolved isn't a silent count. */
  firstUnresolvedError?: string
}

/** Max `eth_getTransactionByHash` calls in flight. The transport's rate
 *  limiter is the real throttle; this just bounds queued work. */
const TX_CONCURRENCY = 50

/**
 * Count, per proposer attester, how many checkpoints they proposed in the
 * settlement window:
 *
 *   1. Scan `CheckpointProposed` logs over [fromBlock, toBlock], chunked,
 *      collecting each checkpoint's `propose()` transaction hash.
 *   2. For each unique transaction, fetch its calldata and recover the
 *      proposer from the `_attestationsAndSignersSignature` (the proposer's
 *      own signature) — pure transaction data + local ECDSA, no committee
 *      sampling and no historical state, so it works against pruned nodes too.
 *   3. Tally per proposer.
 */
export async function countProposalsByProposer(
  input: ProposalCountsInput,
): Promise<ProposalCounts> {
  const {
    client,
    rollupAddress,
    fromBlock,
    toBlock,
    logChunkSize,
    minCheckpointNumber,
    maxCheckpointNumber,
    retryMeter,
    onProgress,
  } = input

  // ---- 1. Scan checkpoint events; capture checkpoint number + tx hash +
  //         L1 block per checkpoint so the audit can list each one. The block
  //         range is scanned generously to absorb proof-submission timing
  //         skew; the epoch gate is precise via the checkpoint-number filter. ----
  type CheckpointEvent = { checkpointNumber: bigint; txHash: Hex; blockNumber: bigint }
  const events: CheckpointEvent[] = []
  let outOfRange = 0
  let cursor = fromBlock
  while (cursor <= toBlock) {
    const chunkEnd = cursor + logChunkSize - 1n < toBlock ? cursor + logChunkSize - 1n : toBlock
    const logs = await withRetry(
      () =>
        client.getLogs({
          address: rollupAddress,
          event: CHECKPOINT_PROPOSED_EVENT,
          fromBlock: cursor,
          toBlock: chunkEnd,
        }),
      undefined,
      undefined,
      retryMeter,
    )
    for (const log of logs) {
      if (!log.transactionHash) continue
      const decoded = decodeEventLog({ abi: [CHECKPOINT_PROPOSED_EVENT], data: log.data, topics: log.topics })
      const checkpointNumber = (decoded.args as { checkpointNumber: bigint }).checkpointNumber
      if (minCheckpointNumber !== undefined && checkpointNumber < minCheckpointNumber) {
        outOfRange++
        continue
      }
      if (maxCheckpointNumber !== undefined && checkpointNumber > maxCheckpointNumber) {
        outOfRange++
        continue
      }
      events.push({
        checkpointNumber,
        txHash: log.transactionHash as Hex,
        blockNumber: log.blockNumber ?? 0n,
      })
    }
    onProgress?.({ phase: "scanning-checkpoints", fromBlock, toBlock, scannedTo: chunkEnd, found: events.length })
    cursor = chunkEnd + 1n
  }

  // ---- 1b. Dedup events by `checkpointNumber`, keeping the one at the
  //          highest L1 block. The rollup re-uses checkpoint numbers when
  //          epochs get pruned and new proposers continue from the rewound
  //          pending tip (see STFLib.prune — pending rolls back to proven,
  //          new propose() calls overwrite the same `tempCheckpointLogs[N %
  //          size]` slot). The earlier events for those numbers earned the
  //          original proposer NOTHING (the epoch they were part of was
  //          never proven). The CURRENT chain's view of checkpoint N — the
  //          one whose proposer actually got credited via
  //          `sequencerRewards[coinbase]` — is the latest `CheckpointProposed`
  //          event at that number. ----
  const latestByCheckpoint = new Map<bigint, CheckpointEvent>()
  for (const ev of events) {
    const existing = latestByCheckpoint.get(ev.checkpointNumber)
    if (!existing || ev.blockNumber > existing.blockNumber) {
      latestByCheckpoint.set(ev.checkpointNumber, ev)
    }
  }
  const prunedAndReused = events.length - latestByCheckpoint.size
  const dedupedEvents = [...latestByCheckpoint.values()]

  const counts: ProposalCounts = {
    countsByProposer: new Map(),
    attributed: [],
    totalCheckpoints: dedupedEvents.length,
    resolvedCheckpoints: 0,
    unresolvedCheckpoints: 0,
    outOfRangeCheckpoints: outOfRange,
    prunedAndReusedCheckpoints: prunedAndReused,
  }
  if (dedupedEvents.length === 0) return counts

  // ---- 2. Recover the proposer + coinbase for each unique tx. Fetches are
  //         retried so a transient RPC/rate-limit failure never silently
  //         drops a checkpoint (which would skew the split and differ
  //         run-to-run). The coinbase is the header field the rollup keys
  //         `sequencerRewards[…]` on, so the caller can gate "this counted
  //         toward our payout" on it. ----
  const uniqueTxs = [...new Set(dedupedEvents.map((e) => e.txHash))]
  // One eth_chainId up front — the v5 digest is EIP-712 and binds the chain id
  // (and the rollup address, which we already have) into the signed payload.
  const chainId = await withRetry(() => client.getChainId(), undefined, undefined, retryMeter)
  const decodedByTx = new Map<Hex, { proposer: Address; coinbase: Address }>()
  const recordUnresolved = (msg: string) => {
    if (counts.firstUnresolvedError === undefined) counts.firstUnresolvedError = msg
  }
  let processed = 0
  await mapWithConcurrency(uniqueTxs, TX_CONCURRENCY, async (txHash) => {
    let calldata: Hex
    try {
      const tx = await withRetry(
        () => client.getTransaction({ hash: txHash }),
        undefined,
        undefined,
        retryMeter,
      )
      calldata = tx.input
    } catch (e) {
      recordUnresolved(`tx ${txHash}: fetch failed after retries: ${(e as Error).message}`)
      processed++
      return
    }
    try {
      const { proposer, coinbase } = await recoverProposerAndCoinbaseFromCalldata(
        calldata,
        rollupAddress,
        chainId,
      )
      decodedByTx.set(txHash, { proposer: getAddress(proposer), coinbase: getAddress(coinbase) })
    } catch (e) {
      recordUnresolved(`tx ${txHash}: could not decode propose()/recover proposer: ${(e as Error).message}`)
    }
    processed++
    if (processed % TX_CONCURRENCY === 0 || processed === uniqueTxs.length) {
      onProgress?.({ phase: "recovering-proposers", resolved: processed, total: uniqueTxs.length })
    }
  })

  // ---- 3. Tally per proposer and build the per-checkpoint attribution
  //         trail (one entry per resolved checkpoint, in event order). ----
  for (const ev of dedupedEvents) {
    const decoded = decodedByTx.get(ev.txHash)
    if (decoded === undefined) {
      counts.unresolvedCheckpoints++
      continue
    }
    const key = decoded.proposer.toLowerCase()
    counts.countsByProposer.set(key, (counts.countsByProposer.get(key) ?? 0) + 1)
    counts.resolvedCheckpoints++
    counts.attributed.push({
      checkpointNumber: ev.checkpointNumber,
      txHash: ev.txHash,
      blockNumber: ev.blockNumber,
      proposer: decoded.proposer,
      coinbase: decoded.coinbase,
    })
  }

  return counts
}
