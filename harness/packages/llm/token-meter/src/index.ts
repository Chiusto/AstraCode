/**
 * Token meter: the heuristic price of the request a session would send next.
 * Port of `packages/llm/token-meter/src/index.ts` without the cordis service.
 * @module @astra/token-meter
 */

import type { Message } from '../../llm/src/index.ts'
import type { RequestHeader, Session, SessionSeq } from '../../../core/session/src/index.ts'
import { surfaceMessageOf } from '../../../core/session/src/index.ts'
import { estimateMessage, estimateSystemMessage, estimateToolsTokens } from './estimate.ts'

export { estimateMessage, estimateSystemMessage, estimateToolsTokens, ROLE_OVERHEAD } from './estimate.ts'

/** One priced surface node. */
export interface TokenMeasurementNode {
  seq: SessionSeq
  tokens: number
  /** Same estimate under the fixed heuristic; kept for callers that compare the two. */
  heuristicTokens: number
}

/** Price of the whole request envelope, itemized per surface node. */
export interface TokenMeasurement {
  /** System prompt + tool schemas + every surface node. */
  totalTokens: number
  /** Priced nodes in surface order; `nodes[i].seq` equals `session.surface.nodes[i]`. */
  nodes: TokenMeasurementNode[]
}

/** Measure session pressure under the fixed heuristic. */
export class TokenMeter {
  estimateMessage(message: Message): number {
    return estimateMessage(message)
  }

  /**
   * @param session - supplies the surface and the events behind it.
   * @param header - envelope to price; defaults to the latest recorded request.
   */
  measure(session: Session, header?: RequestHeader): TokenMeasurement {
    const effective = header ?? session.requestHeader()
    const nodes = session.surface.nodes.map((seq) => {
      const event = session.eventAt(seq)
      const message = event === undefined ? undefined : surfaceMessageOf(event)
      if (event === undefined || message === undefined) {
        throw new Error(`token-meter: surface seq ${seq} has no model-visible message (corrupt surface)`)
      }
      const tokens = estimateMessage(message)
      return { seq, tokens, heuristicTokens: tokens }
    })
    const head = effective === undefined ? 0 : estimateSystemMessage(effective.systemPrompt) + estimateToolsTokens(effective.tools)
    return { totalTokens: nodes.reduce((sum, node) => sum + node.tokens, head), nodes }
  }
}
