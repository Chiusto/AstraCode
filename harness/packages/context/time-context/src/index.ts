/**
 * Durable wall-clock context: a user-role reading appended before a step so
 * the model knows the current time without the cached system prefix changing.
 * Port of `packages/context/time-context/src/index.ts` without cordis; the
 * projection becomes a fold over the session log and the browser time-zone
 * context is omitted.
 * @module @astra/time-context
 */

import type { Agent } from '../../../core/agent/src/index.ts'
import type { Session } from '../../../core/session/src/index.ts'
import { createTimestampFormatter, formatTimestamp } from './timestamp.ts'

export { createTimestampFormatter, formatTimestamp } from './timestamp.ts'

/** Source marker of injected readings. */
export const name = 'time-context'

/** Default minimum gap between two readings. */
export const TIME_CONTEXT_REFRESH_MS = 600_000

export interface TimeContextConfig {
  /** IANA zone of the readings; defaults to the process zone. */
  timeZone?: string
  /** Minimum gap between two readings in milliseconds; 0 injects before every step. */
  refreshIntervalMs?: number
}

interface TimeContextState {
  lastMessageTime: number | null
  lastInjectionTime: number | null
  lastTurnInjectionTime: number | null
}

/** Format a non-negative elapsed millisecond count as compact whole-second units. */
export function formatDuration(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const seconds = total % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join(' ')
}

/** Fold the session log into the timestamps the next reading is phrased against. */
export function timeContextState(session: Session): TimeContextState {
  const state: TimeContextState = { lastMessageTime: null, lastInjectionTime: null, lastTurnInjectionTime: null }
  for (const event of session.events()) {
    if (event.type === 'turn/start' || event.type === 'turn/end') state.lastTurnInjectionTime = null
    else if (event.type === 'user/message') {
      state.lastMessageTime = event.time
      if (event.data.source.kind === name) {
        state.lastInjectionTime = event.time
        state.lastTurnInjectionTime = event.time
      }
    } else if (event.type === 'assistant/message' || event.type === 'tool/result') {
      state.lastMessageTime = event.time
    }
  }
  return state
}

/** The wording of one reading. */
export function renderText(now: number, turn: number, step: number, previous: number | undefined, formatter: Intl.DateTimeFormat, timeZone: string): string {
  const elapsed = previous === undefined ? 'unavailable' : formatDuration(now - previous)
  const baseline = step === 1 ? 'model-visible message' : 'step context'
  return `Time sampled while preparing turn ${turn}, step ${step}: ${formatTimestamp(now, formatter, timeZone)}\n`
    + `Elapsed since the preceding ${baseline}: ${elapsed}.`
}

/** Append a reading before `turn`/`step` unless one landed within the refresh interval. */
export function injectTimeContext(agent: Agent, turn: number, step: number, config: TimeContextConfig = {}): boolean {
  const refreshIntervalMs = config.refreshIntervalMs ?? TIME_CONTEXT_REFRESH_MS
  const formatter = createTimestampFormatter(config.timeZone)
  const timeZone = formatter.resolvedOptions().timeZone
  const now = Date.now()
  const state = timeContextState(agent.session)
  const lastInjection = state.lastInjectionTime
  if (refreshIntervalMs > 0 && lastInjection !== null && now >= lastInjection && now - lastInjection < refreshIntervalMs) {
    return false
  }
  const previous = step === 1 ? (state.lastMessageTime ?? undefined) : (state.lastTurnInjectionTime ?? undefined)
  const text = renderText(now, turn, step, previous, formatter, timeZone)
  agent.session.append('user/message', { message: { role: 'user', content: text }, source: { kind: name } }, { surfaceOp: 'append' })
  return true
}
