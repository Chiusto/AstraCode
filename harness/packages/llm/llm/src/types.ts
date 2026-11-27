/**
 * Provider-neutral request, message and stream vocabulary.
 * Messages keep the flat chat-completions wire shape this CLI already persists.
 * @module @astra/llm/types
 */

import type { LlmFailure } from './error.ts'

export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** A tool invocation requested by the model, with raw JSON arguments. */
export interface ToolCall {
  id: string
  name: string
  arguments: string
}

/** Wire shape of one assistant tool call. */
export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** One conversation entry as the provider receives it. */
export interface Message {
  role: Role
  content: string | null
  tool_calls?: WireToolCall[]
  tool_call_id?: string
}

/** Tool schema advertised to the model. */
export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** Token accounting for one model call. Counts are disjoint, like upstream. */
export interface TokenUsage {
  /** Uncached input only. */
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
}

/** Why a model response stopped. */
export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure }
  | { kind: 'error'; failure: LlmFailure }

/** A tool-call delta; providers split id, name and arguments across chunks. */
export interface ToolCallDelta {
  type: 'tool-call'
  index: number
  id?: string
  name?: string
  arguments?: string
}

/** One decoded piece of a streaming model response. */
export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | ToolCallDelta
  | { type: 'finish'; finish: FinishReason; usage?: TokenUsage }

/** One model request. */
export interface GenerateOptions {
  /** Overrides the route's default model. */
  model?: string
  messages: readonly Message[]
  tools?: readonly ToolSchema[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export type { LlmFailure }
