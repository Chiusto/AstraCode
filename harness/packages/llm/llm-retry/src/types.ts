/**
 * Durable records of scheduled and started request retries.
 * Port of `packages/llm/llm-retry/src/types.ts`.
 * @module @astra/llm-retry/types
 */

import type { LlmFailure } from '../../llm/src/index.ts'

/** One scheduled retry, written before its cancellable backoff wait. */
export interface LlmRetryEventData {
  retryId: string
  turn: number
  step: number
  provider: string
  mode: 'normal' | 'always'
  /** Identity of the policy in force, so counters do not leak across policies. */
  policyKey: string
  retry: number
  /** Only present under `normal` mode. */
  maxRetries?: number
  delayMs: number
  failure: LlmFailure
}

/** The backoff wait of one retry completed without cancellation. */
export interface LlmRetryStartedEventData {
  retryId: string
  turn: number
  step: number
  retry: number
}
