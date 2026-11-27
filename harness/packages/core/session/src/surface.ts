/**
 * The model-visible projection of a session log: the ordered seqs the next
 * request replays. Port of `packages/core/session/src/surface.ts`.
 * @module @astra/session/surface
 */

import type { SessionEvent, SessionSeq } from './types.ts'
import { SURFACE_EVENT_TYPES } from './types.ts'

export class SessionSurface {
  private current: SessionSeq[] = []
  private generation = 0

  /** Surface seqs in replay order, oldest first. */
  get nodes(): readonly SessionSeq[] {
    return this.current
  }

  /** Increments on every replace, so callers can detect a rewrite across an await. */
  get replaceGeneration(): number {
    return this.generation
  }

  /** Apply one event's surface effect. */
  fold(event: SessionEvent): void {
    if (event.surfaceOp === undefined) {
      if (SURFACE_EVENT_TYPES.has(event.type)) this.current.push(event.seq)
      return
    }
    if (event.surfaceOp === 'append') {
      this.current.push(event.seq)
      return
    }
    const { startSeq, endSeq } = event.surfaceOp
    const start = this.current.indexOf(startSeq)
    const end = this.current.indexOf(endSeq)
    if (start === -1 || end === -1 || end < start) {
      throw new Error(`surface replace: seqs ${startSeq}-${endSeq} are not an ordered surface span`)
    }
    this.current.splice(start, end - start + 1, event.seq)
    this.generation += 1
  }
}
