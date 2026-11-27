/**
 * Pending tool-result recovery for a log whose tail turn was interrupted.
 * Tail repair keeps closed steps and supplies only missing tool results and
 * lifecycle boundaries, with cause-specific retry guidance.
 * Port of `packages/core/session/src/repair.ts`.
 * @module @astra/session/repair
 */

import type { SessionEvent, SessionSeq } from './types.ts'

/** Recovery code for an assistant tool request that never reached a recorded call start. */
export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'

/** Recovery code for a recorded tool call whose completed outcome was not durably recorded. */
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/** Why an open tail turn is closed with synthetic events. */
export type OpenTurnCloseCause = { readonly kind: 'interrupted' } | { readonly kind: 'forked' }

/** Model-visible wording of the synthetic error tool results, keyed by cause. */
const CLOSER_TEXT = {
  interrupted: {
    started: 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
    notStarted: 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
  },
  forked: {
    started: 'The history inherited by this branch records this tool call starting but does not include its result. The parent session may have completed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
    notStarted: 'The history inherited by this branch has no record of this tool call starting. The parent session may have executed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
  },
} as const

interface PendingCall {
  turn: number
  step: number
  callSeq?: SessionSeq
}

/**
 * Deterministic synthetic events that close an open tail turn. Unmatched calls
 * receive error results first, followed by an open `step/end` and a
 * cause-specific `turn/end`. A balanced log returns no events.
 */
export function openTurnClosers(events: readonly SessionEvent[], cause: OpenTurnCloseCause): SessionEvent[] {
  let openTurn: number | null = null
  let openStep: number | null = null
  const recovery = new ToolCallRecovery(cause)
  for (const event of events) {
    recovery.observe(event)
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        openStep = null
        break
      case 'turn/end':
        openTurn = null
        openStep = null
        break
      case 'step/start':
        openStep = event.data.step
        break
      case 'step/end':
        openStep = null
        break
      default:
        break
    }
  }

  const last = events.at(-1)
  if (openTurn === null || last === undefined) return []

  const closers: SessionEvent[] = recovery.results()
  let seq = last.seq + closers.length + 1
  const time = last.time
  if (openStep !== null) {
    closers.push({ type: 'step/end', seq: seq++, time, data: { turn: openTurn, step: openStep } })
  }
  closers.push({ type: 'turn/end', seq: seq++, time, data: { turn: openTurn, reason: { kind: cause.kind } } })
  return closers
}

/** Track unanswered assistant tool requests from a Session's committed events. */
export class ToolCallRecovery {
  private readonly pendingCalls = new Map<string, PendingCall>()
  private last: Pick<SessionEvent, 'seq' | 'time'> | undefined

  private readonly cause: OpenTurnCloseCause

  constructor(cause: OpenTurnCloseCause = { kind: 'interrupted' }) {
    this.cause = cause
  }

  /** Consume the next committed event; step and turn boundaries discard pending requests. */
  observe(event: SessionEvent): void {
    this.last = { seq: event.seq, time: event.time }
    switch (event.type) {
      case 'turn/start':
      case 'turn/end':
      case 'step/end':
        this.pendingCalls.clear()
        break
      case 'assistant/message':
        for (const call of event.data.message.tool_calls ?? []) {
          this.pendingCalls.set(call.id, { turn: event.data.turn, step: event.data.step })
        }
        break
      case 'tool/call': {
        const entry = this.pendingCalls.get(event.data.callId)
        if (entry !== undefined) entry.callSeq = event.seq
        break
      }
      case 'tool/result': {
        const callId = event.data.message.tool_call_id ?? ''
        const entry = this.pendingCalls.get(callId)
        if (event.surfaceOp === 'append' && entry !== undefined
          && entry.turn === event.data.turn && entry.step === event.data.step) {
          this.pendingCalls.delete(callId)
        }
        break
      }
      default:
        break
    }
  }

  /** Build conservative error results in assistant order without changing tracked state. */
  results(): SessionEvent<'tool/result'>[] {
    if (this.last === undefined) return []
    let seq = this.last.seq + 1
    const time = this.last.time
    const results: SessionEvent<'tool/result'>[] = []
    const text = CLOSER_TEXT[this.cause.kind]
    for (const [callId, { turn, step, callSeq }] of this.pendingCalls) {
      const started = callSeq !== undefined
      results.push({
        type: 'tool/result',
        seq: seq++,
        time,
        data: {
          turn,
          step,
          message: { role: 'tool', tool_call_id: callId, content: started ? text.started : text.notStarted },
          error: started
            ? { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
            : { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
        },
        surfaceOp: 'append',
        ...started ? { sourceEventSeqs: [callSeq] } : {},
      })
    }
    return results
  }
}

/** Crash-recovery entry point: closers that balance a persisted interrupted tail. */
export function interruptedTurnClosers(events: readonly SessionEvent[]): SessionEvent[] {
  return openTurnClosers(events, { kind: 'interrupted' })
}
