/**
 * Provider-neutral LLM failure codes and shared error classification.
 * Port of `packages/llm/llm/src/error.ts` without the HarnessError base.
 * @module @astra/llm/error
 */

export type LlmFailureCode =
  | 'AUTH'
  | 'QUOTA'
  | 'RATE_LIMIT'
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'INVALID_REQUEST'
  | 'SERVER'
  | 'TIMEOUT'
  | 'TRANSPORT'
  | 'EMPTY_RESPONSE'
  | 'STREAM_CLOSED'
  | 'MALFORMED_RESPONSE'
  | 'ABORTED'
  | `HTTP_${number}`

export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED' satisfies LlmFailureCode
export const QUOTA_EXCEEDED_CODE = 'QUOTA' satisfies LlmFailureCode
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE' satisfies LlmFailureCode

/** Failure codes offered as retryable choices in provider configuration. */
export const RETRY_CODE_CHOICES: readonly LlmFailureCode[] = Object.freeze([
  EMPTY_RESPONSE_CODE,
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  QUOTA_EXCEEDED_CODE,
  'MALFORMED_RESPONSE',
  'STREAM_CLOSED',
])

/** Serializable failure facts; the retry policy decides whether they are retryable. */
export interface LlmFailure {
  readonly message: string
  readonly code: string
  readonly status?: number
  readonly providerRetryAfterMs?: number
}

/** An API or transport failure with a message safe to show the user. */
export class LlmError extends Error implements LlmFailure {
  override readonly name = 'LlmError'
  readonly code: string
  readonly status?: number
  readonly providerRetryAfterMs?: number

  constructor(
    message: string,
    code: LlmFailureCode,
    extra: { status?: number; providerRetryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, extra.cause === undefined ? {} : { cause: extra.cause })
    this.code = code
    this.status = extra.status
    this.providerRetryAfterMs = extra.providerRetryAfterMs
  }

  static fromFailure(failure: LlmFailure, cause?: unknown): LlmError {
    return new LlmError(failure.message, failure.code as LlmFailureCode, {
      status: failure.status,
      providerRetryAfterMs: failure.providerRetryAfterMs,
      cause,
    })
  }
}

/** Coerce any thrown value into failure facts. */
export function toLlmFailure(error: unknown): LlmFailure {
  if (error instanceof LlmError) return error
  return { message: error instanceof Error ? error.message : String(error), code: 'TRANSPORT' }
}

/** Account quota wording from dsh-llm/error.ts. */
export function isQuotaExceededError(detail: string): boolean {
  return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail)
    || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail)
    || /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail)
    || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail)
    || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail)
}

/** Context-overflow wording from dsh-llm/error.ts. */
export function isContextWindowExceededError(detail: string): boolean {
  return /(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-](?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])/i.test(detail)
    || /\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?(?:model(?:'s)?\s+)?context(?:\s+window)?\b/i.test(detail)
    || /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail)
    || /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(detail)
    || /\b(?:input|prompt|request|messages?)\b.{0,40}\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b/i.test(detail)
}

/** Join an error and its `cause` chain into one durable line. */
export function errorChain(value: unknown): string {
  const parts: string[] = []
  let current = value
  for (let depth = 0; current !== undefined && current !== null && depth < 10; depth++) {
    parts.push(current instanceof Error ? current.message : String(current))
    const cause = (current as { cause?: unknown }).cause
    if (!(cause instanceof Error) && typeof cause !== 'string') break
    current = cause
  }
  return parts.join(': ')
}
