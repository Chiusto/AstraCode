/**
 * Session event vocabulary: an append-only log whose model-visible subset is
 * the "surface". Port of `packages/core/session/src/types.ts` for flat wire messages.
 * @module @astra/session/types
 */

import type { LlmRetryEventData, LlmRetryStartedEventData } from '../../../llm/llm-retry/src/types.ts'
import type { Message, TokenUsage, ToolSchema } from '../../../llm/llm/src/index.ts'

/** 0-based position of an event in the durable log. */
export type SessionSeq = number

/** Why a turn ended. */
export type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'aborted' }
  | { kind: 'blocked' }
  | { kind: 'error' }
  | { kind: 'max-tokens' }
  | { kind: 'interrupted' }
  | { kind: 'forked' }

/** What produced a user-role message. */
export type MessageSource =
  | { kind: 'user' }
  | { kind: 'time-context' }
  | { kind: 'compact-checkpoint'; compactionId: string }

/** The envelope of the latest request: what the next request would carry. */
export interface RequestHeader {
  provider: string
  model: string
  maxTokens: number
  systemPrompt: string
  tools: readonly ToolSchema[]
}

export interface ShadowPrice {
  /** Surface-position span of the replaced nodes. */
  shadowedRange: { start: SessionSeq; end: SessionSeq }
  /** Seqs of all shadowed surface nodes, in surface order. */
  shadowedSeqs: SessionSeq[]
  /** Heuristic token price of the shadowed content. */
  shadowedTokenCount: number
}

export interface SessionEventMap {
  'turn/start': { turn: number }
  'turn/end': { turn: number; reason: TurnEndReason }
  'step/start': { turn: number; step: number }
  'step/end': { turn: number; step: number }
  'user/message': { message: Message; source: MessageSource }
  'assistant/message': {
    turn: number
    step: number
    message: Message
    usage?: TokenUsage
    interrupted?: boolean
  }
  'tool/call': { turn: number; step: number; callId: string; name: string; arguments: string }
  'tool/result': {
    turn: number
    step: number
    message: Message
    error?: { name: string; code: string }
  }
  'request/header': RequestHeader
  'model/selection': { provider: string; model: string; alias: string }
  'cwd': { cwd: string }
  'compaction/start': { compactionId: string; turn: number | null }
  'compaction/summary': ShadowPrice & {
    compactionId: string
    turn: number | null
    summary: string
    provider: string
    model: string
    maxTokens?: number
    usage?: TokenUsage
  }
  'compaction/end': { compactionId: string; turn: number | null; error?: string }
  'compaction/prune': ShadowPrice
  'llm/retry': LlmRetryEventData
  'llm/retry-started': LlmRetryStartedEventData
}

export type SessionEventType = keyof SessionEventMap

/** One durable log record. */
export interface SessionEvent<Type extends SessionEventType = SessionEventType> {
  type: Type
  seq: SessionSeq
  /** Epoch milliseconds. */
  time: number
  data: SessionEventMap[Type]
  /** How the event changes the surface; absent means log-only. */
  surfaceOp?: 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }
  /** Inputs a replacement was derived from. */
  sourceEventSeqs?: SessionSeq[]
}

/** Event types that carry a model-visible message. */
export const SURFACE_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set<SessionEventType>([
  'user/message',
  'assistant/message',
  'tool/result',
])

/** The wire message carried by a surface event. */
export function surfaceMessageOf(event: SessionEvent): Message | undefined {
  switch (event.type) {
    case 'user/message':
    case 'assistant/message':
    case 'tool/result':
      return event.data.message
    default:
      return undefined
  }
}
