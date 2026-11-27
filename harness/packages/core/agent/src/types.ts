/**
 * Agent vocabulary.
 * Port of `packages/core/agent/src/types.ts` and the runtime types this CLI uses.
 * @module @astra/agent/types
 */

import type { Session } from '../../session/src/index.ts'

/** The provider route one request is sent to. */
export interface ModelSelection {
  provider: string
  model: string
}

/** Per-agent request settings that override the adapter route. */
export interface AgentOptions {
  model?: string
  maxTokens?: number
  temperature?: number
}

export type AgentStatus = 'idle' | 'running'

/** An agent owns exactly one session. */
export interface Agent {
  readonly id: string
  readonly session: Session
  readonly options: AgentOptions
  status: AgentStatus
}

/** What a `request-error` listener decides about one failed model request. */
export type RequestErrorAction = { kind: 'retry' } | undefined
