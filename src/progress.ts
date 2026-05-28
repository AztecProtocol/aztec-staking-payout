import type { DiscoveryProgress } from "./discovery.js"
import type { EpochResolverProgress } from "./epochs.js"
import type { ProposalProgress } from "./proposals.js"

export type ProgressEvent = DiscoveryProgress | EpochResolverProgress | ProposalProgress

export interface InlineProgress {
  onProgress: (p: ProgressEvent) => void
  /** Clear the progress line. Call once the phase finishes. */
  done: () => void
}

/**
 * Render discovery progress as a single inline-updating line.
 *
 * On a TTY: rewrites the same line in place using carriage-return + clear,
 * so a long scan shows live progress without scrolling the terminal.
 *
 * On a non-TTY (piped to a file, CI logs): stays silent — no spam. The
 * caller is expected to have printed a one-line "Discovering…" header
 * already, and will print the result count when done.
 */
export function createInlineProgress(
  write: (s: string) => void = (s) => void process.stderr.write(s),
  isTTY: boolean = process.stderr.isTTY ?? false,
): InlineProgress {
  let active = false

  const render = (line: string): void => {
    if (!isTTY) return
    // \r → column 0; \x1b[2K → clear entire line.
    write(`\r\x1b[2K${line}`)
    active = true
  }

  const onProgress = (p: ProgressEvent): void => {
    switch (p.phase) {
      case "scanning-stakes": {
        render(`  ⋯ scanning stake events  block ${p.scannedTo} out of ${p.toBlock}  ·  ${p.eventsFound} found`)
        break
      }
      case "resolving-splits": {
        render(`  ⋯ resolving split recipients  ${p.resolved}/${p.total} tx  ·  ${p.matched} matched`)
        break
      }
      case "checking-attesters": {
        render(`  ⋯ checking attester status  ${p.checked}/${p.total}`)
        break
      }
      case "scanning-checkpoints": {
        render(`  ⋯ scanning checkpoints  block ${p.scannedTo} out of ${p.toBlock}  ·  ${p.found} found`)
        break
      }
      case "recovering-proposers": {
        render(`  ⋯ recovering proposers  ${p.resolved}/${p.total} tx`)
        break
      }
      case "fetching-finalized-block": {
        render(`  ⋯ fetching L1 finalized block`)
        break
      }
      case "auto-detecting-rollup-deploy-block": {
        render(`  ⋯ auto-detecting rollup deploy block (binary search on eth_getCode)`)
        break
      }
      case "reading-proven-tip": {
        render(`  ⋯ reading proven tip at L1 block ${p.finalizedBlock}`)
        break
      }
      case "computing-latest-proven-epoch": {
        render(
          `  ⋯ computing latest proven epoch (checkpoint ${p.provenCheckpointTip})  ` +
            `proposal-block search step ${p.step}  range [${p.lo}, ${p.hi}]`,
        )
        break
      }
      case "finding-from-checkpoint":
      case "finding-to-checkpoint": {
        const which = p.phase === "finding-from-checkpoint" ? "fromCheckpoint" : "toCheckpoint"
        switch (p.step) {
          case "reading-epoch-timestamp":
            render(`  ⋯ resolving ${which}  reading L2 timestamp for epoch ${p.epochBoundary}`)
            break
          case "searching-l1-block":
            render(
              `  ⋯ resolving ${which}  L1 block at L2 timestamp ${p.boundaryTimestamp}  ` +
                `step ${p.binStep}  range [${p.lo}, ${p.hi}]`,
            )
            break
          case "reading-pending-at-boundary":
            render(`  ⋯ resolving ${which}  reading pending tip at L1 block ${p.boundaryBlock}`)
            break
        }
        break
      }
      case "finding-from-block":
      case "finding-to-block": {
        const which = p.phase === "finding-from-block" ? "fromBlock" : "toBlock"
        render(`  ⋯ resolving ${which}  step ${p.step}  L1 range [${p.lo}, ${p.hi}]`)
        break
      }
    }
  }

  const done = (): void => {
    if (active && isTTY) {
      write(`\r\x1b[2K`)
      active = false
    }
  }

  return { onProgress, done }
}
