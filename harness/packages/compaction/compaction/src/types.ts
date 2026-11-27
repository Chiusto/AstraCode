/**
 * Compaction vocabulary: the result type and the trigger names. The
 * `compaction/*` session events live in `core/session/src/types.ts`; they
 * record the lock and summary inputs without entering the surface — a separate
 * replacement `user/message` carries the summary.
 * Port of `packages/compaction/compaction/src/types.ts`.
 * @module @astra/compaction/types
 */

import type { SessionSeq } from '../../../core/session/src/index.ts'

/** Stable identity shared by one compaction's complete durable lifecycle. */
export type CompactionId = string

/** Result of a successful compaction operation. */
export interface CompactionResult {
  compactionId: CompactionId
  /** The seq of the appended `compaction/start` event. */
  startSeq: SessionSeq
  /** The seq of the appended `compaction/summary` event. */
  summarySeq: SessionSeq
  /** The seq of the appended `compaction/end` event. */
  endSeq: SessionSeq
  /** The summary text produced by the backend. */
  summary: string
  /**
   * The surface-boundary pair that was shadowed: a surface-POSITION span, not a
   * numeric seq interval — after a prior replace lands a fresh high-seq summary
   * node at an older range's position, `start` can be GREATER than `end`.
   */
  shadowedRange: { start: SessionSeq; end: SessionSeq }
  /** The seqs of all shadowed surface nodes, in surface order. */
  shadowedSeqs: SessionSeq[]
  /** Estimated token count of the shadowed content. */
  shadowedTokenCount: number
}

/** What asked for compaction: replayed step-boundary pressure, or a provider-confirmed context overflow. */
export type CompactionTrigger = 'pressure' | 'context-overflow'
