/**
 * Tool-result pruning result types. Port of
 * `packages/compaction/compaction-tool-result-pruner/src/types.ts`.
 * @module @astra/compaction-tool-result-pruner/types
 */

import type { ResolvedConfig } from './config.ts'

export type { ResolvedConfig }
export type ToolResultPruneConfig = Partial<ResolvedConfig>

/** One landed prune replacement. */
export interface PrunedEntry {
  /** Surface seq of the shadowed tool result. */
  originalSeq: number
  /** Seq of the replacement `tool/result` event. */
  replacementSeq: number
  callId: string
  charsBefore: number
  charsAfter: number
}

/** Outcome of one pruning pass over a session surface. */
export interface PruneResult {
  pruned: PrunedEntry[]
  /** Aggregate Unicode-code-point savings. */
  charsRemoved: number
}
