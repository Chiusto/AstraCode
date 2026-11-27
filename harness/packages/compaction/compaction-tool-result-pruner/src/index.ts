/**
 * Replay-safe, model-free tool-result pruning.
 * Port of `packages/compaction/compaction-tool-result-pruner/src/index.ts` without cordis.
 * @module @astra/compaction-tool-result-pruner
 */

import type { Session, SessionEvent } from '../../../core/session/src/index.ts'
import type { TokenMeter } from '../../../llm/token-meter/src/index.ts'
import { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig } from './config.ts'
import type { PrunedEntry, PruneResult, ResolvedConfig } from './types.ts'

export { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig } from './config.ts'
export type { PrunedEntry, PruneResult, ResolvedConfig, ToolResultPruneConfig } from './types.ts'

/** Deterministic head/middle/tail pruning for current tool-result surface nodes. */
export class ToolResultPruner {
  readonly config: ResolvedConfig

  constructor(config: Partial<typeof DEFAULTS> = {}) {
    this.config = resolveConfig(config)
  }

  /** Measure tool-result text in Unicode code points. */
  measureContent(text: string): number {
    return codePointLength(text)
  }

  /**
   * Replace an over-budget text middle, slicing by Unicode code point so a
   * retained boundary cannot split a surrogate pair.
   * @returns pruned text, or `null` when the text is within budget.
   */
  pruneContent(text: string): string | null {
    const totalChars = this.measureContent(text)
    if (totalChars <= this.config.thresholdChars) return null
    const points = Array.from(text)
    const head = points.slice(0, this.config.headChars).join('')
    const tail = points.slice(totalChars - this.config.tailChars).join('')
    const pruned = `${head}${PRUNE_MARKER}${tail}`
    const charsAfter = this.measureContent(pruned)
    if (charsAfter > this.config.thresholdChars || charsAfter >= totalChars) {
      throw new Error('tool-result prune: replacement must be smaller and within threshold')
    }
    return pruned
  }

  /**
   * Prune every over-budget tool result from one stable current-surface
   * snapshot. Each replacement is immediately preceded by a `compaction/prune`
   * shadow-price event pricing the shadowed node.
   */
  pruneSession(session: Session, meter: TokenMeter): PruneResult {
    const candidates = session.surface.nodes
      .map((seq) => session.eventAt(seq))
      .filter((event): event is SessionEvent<'tool/result'> => event?.type === 'tool/result')

    const pruned: PrunedEntry[] = []
    let charsRemoved = 0
    for (const event of candidates) {
      const original = event.data.message.content
      if (typeof original !== 'string') continue
      const content = this.pruneContent(original)
      if (content === null) continue
      const charsBefore = this.measureContent(original)
      const charsAfter = this.measureContent(content)
      session.append('compaction/prune', {
        shadowedRange: { start: event.seq, end: event.seq },
        shadowedSeqs: [event.seq],
        shadowedTokenCount: meter.estimateMessage(event.data.message),
      })
      const replacement = session.append('tool/result', {
        ...event.data,
        message: { ...event.data.message, content },
      }, {
        surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq },
        sourceEventSeqs: [event.seq],
      })
      pruned.push({
        originalSeq: event.seq,
        replacementSeq: replacement.seq,
        callId: event.data.message.tool_call_id ?? '',
        charsBefore,
        charsAfter,
      })
      charsRemoved += charsBefore - charsAfter
    }
    return { pruned, charsRemoved }
  }
}
