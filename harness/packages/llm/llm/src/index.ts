/**
 * The provider-neutral LLM seam every adapter implements.
 * @module @astra/llm
 */

import type { ResolvedRetryPolicy } from './retry-policy.ts'

export { BlockAssembler } from './assembler.ts'
export type { AssistantResponse } from './assembler.ts'
export { createAssistantMessage } from './message.ts'
export {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  RETRY_CODE_CHOICES,
  errorChain,
  isContextWindowExceededError,
  isQuotaExceededError,
  toLlmFailure,
} from './error.ts'
export type { LlmFailure, LlmFailureCode } from './error.ts'
export { DEFAULT_MAX_RETRIES, resolveRetryPolicy } from './retry-policy.ts'
export type {
  AlwaysRetryPolicyConfig,
  BackoffConfig,
  NormalRetryPolicyConfig,
  ResolvedAlwaysRetryPolicy,
  ResolvedNormalRetryPolicy,
  ResolvedRetryPolicy,
  RetryPolicyConfig,
} from './retry-policy.ts'
export type {
  FinishReason,
  GenerateOptions,
  Message,
  Role,
  StreamChunk,
  TokenUsage,
  ToolCall,
  ToolCallDelta,
  ToolSchema,
  WireToolCall,
} from './types.ts'

/** One provider route: a model behind one endpoint and credential. */
export interface Llm {
  /** Stable provider name used in failure and compaction records. */
  readonly provider: string
  /** Default model id when a request omits `model`. */
  readonly model: string
  /** Combined request/response context capacity in tokens. */
  readonly contextWindow: number
  /** Output-token cap materialized when a request omits `maxTokens`. */
  readonly defaultMaxTokens: number
  readonly retryPolicy?: ResolvedRetryPolicy
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
