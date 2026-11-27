/**
 * Provider-routed model-request retry policy on the agent loop's request
 * recovery extension point. Each scheduled retry is durable before its
 * cancellable wait. Port of `packages/llm/llm-retry/src/index.ts` without cordis:
 * the retry projection becomes a fold over the session's `llm/retry` events.
 * @module @astra/llm-retry
 */

import { randomUUID } from 'node:crypto'
import type { ResolvedRetryPolicy } from '../../llm/src/index.ts'
import type { LlmFailure } from '../../llm/src/index.ts'
import type { Session } from '../../../core/session/src/index.ts'
import type { LlmRetryEventData } from './types.ts'

export type { LlmRetryEventData, LlmRetryStartedEventData } from './types.ts'

/** Non-serializable hooks used to make timing policy deterministic in tests. */
export interface RetryInternals {
  /** Random sample in the inclusive zero-to-one range used for jitter. */
  random?: () => number
}

export interface RetryRequest {
  session: Session
  provider: string
  /** Policy of the route that failed; undefined disables recovery. */
  policy: ResolvedRetryPolicy | undefined
  turn: number
  step: number
  failure: LlmFailure
  signal: AbortSignal
}

export interface RetryDecision {
  retryId: string
  retry: number
  delayMs: number
}

function localDelay(policy: ResolvedRetryPolicy, retry: number, random: () => number): number {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs)
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * random()
  return Math.min(exponential * jitter, policy.maxDelayMs)
}

function retryPolicyKey(policy: ResolvedRetryPolicy): string {
  return policy.mode === 'always'
    ? JSON.stringify([policy.mode, policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio])
    : JSON.stringify([
      policy.mode,
      policy.maxRetries,
      [...policy.retryableCodes].sort(),
      policy.initialDelayMs,
      policy.maxDelayMs,
      policy.jitterRatio,
    ])
}

function retryStateKey(provider: string, policyKey: string): string {
  return JSON.stringify([provider, policyKey])
}

/** Retries scheduled in the current step or turn; a later boundary resets the counter. */
export function scheduledRetries(session: Session, provider: string, policy: ResolvedRetryPolicy): number {
  const key = retryStateKey(provider, retryPolicyKey(policy))
  let retry = 0
  for (const event of session.events()) {
    if (event.type === 'step/start' || event.type === 'turn/end') retry = 0
    else if (event.type === 'llm/retry' && retryStateKey(event.data.provider, event.data.policyKey) === key) {
      retry = event.data.retry
    }
  }
  return retry
}

/** Resolve true when `delayMs` elapsed before `signal` aborted. */
export function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Decide whether one failed request is resent, record that decision durably,
 * and wait out its backoff. `normal` mode retries only configured transient
 * codes, at most `maxRetries` times per step; `always` mode retries every
 * failure. A provider `Retry-After` longer than `maxDelayMs` is not honored
 * under `normal` mode, which delegates the failure instead.
 * @returns the executed decision, or undefined when the failure is not retried.
 */
export async function retryRequest(
  { session, provider, policy, turn, step, failure, signal }: RetryRequest,
  internals: RetryInternals = {},
): Promise<RetryDecision | undefined> {
  if (policy === undefined || signal.aborted) return undefined
  if (policy.mode === 'normal' && !policy.retryableCodes.includes(failure.code)) return undefined

  const policyKey = retryPolicyKey(policy)
  const previousRetry = scheduledRetries(session, provider, policy)
  if (policy.mode === 'normal' && previousRetry >= policy.maxRetries) return undefined
  const retry = previousRetry + 1

  const after = failure.providerRetryAfterMs
  let delayMs: number
  const random = internals.random ?? Math.random
  if (after !== undefined && Number.isFinite(after) && after > 0) {
    if (after > policy.maxDelayMs) {
      if (policy.mode === 'normal') return undefined
      delayMs = localDelay(policy, retry, random)
    } else {
      delayMs = after
    }
  } else {
    delayMs = localDelay(policy, retry, random)
  }

  const eventData: LlmRetryEventData = {
    retryId: randomUUID(),
    turn,
    step,
    provider,
    mode: policy.mode,
    policyKey,
    retry,
    ...policy.mode === 'normal' ? { maxRetries: policy.maxRetries } : {},
    delayMs,
    failure: { message: failure.message, code: failure.code, ...failure },
  }
  session.append('llm/retry', eventData)
  if (!await cancellableDelay(delayMs, signal)) return undefined
  session.append('llm/retry-started', { retryId: eventData.retryId, turn, step, retry })
  return { retryId: eventData.retryId, retry, delayMs }
}
