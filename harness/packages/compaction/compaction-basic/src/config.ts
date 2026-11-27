/**
 * Backend-neutral compaction configuration and the pressure/retention arithmetic.
 * Port of `packages/compaction/compaction-basic/src/config.ts` without schemastery
 * and without per-model policy overrides.
 * @module @astra/compaction-basic/config
 */

export interface BasicCompactionConfig {
  /** Fraction of the context window at which compaction starts. */
  thresholdRatio?: number
  /** Extra room kept free below the context window, in tokens. */
  headroomTokens?: number
  /** Fraction of the message budget kept verbatim as the recent tail. */
  retainRatio?: number
  /** Fixed recent-tail budget in tokens; overrides `retainRatio`. */
  retainTokens?: number
  /** Upper bound for one summary request; defaults to the route's output cap. */
  maxTokens?: number
  /** Extra summary attempts when the threshold is still exceeded. */
  compactionRetries?: number
  /** Extra attempts after a provider-confirmed context overflow. */
  maxOverflowRetries?: number
  /** Compact automatically on step-boundary pressure and context overflow. */
  auto?: boolean
}

export const DEFAULTS = Object.freeze({
  thresholdRatio: 0.8,
  headroomTokens: 65_536,
  retainRatio: 0.16,
  compactionRetries: 1,
  maxOverflowRetries: 1,
  auto: true,
})

export interface ResolvedConfig {
  readonly thresholdRatio: number
  readonly headroomTokens: number
  readonly retainRatio: number
  readonly retainTokens?: number
  readonly maxTokens?: number
  readonly compactionRetries: number
  readonly maxOverflowRetries: number
  readonly auto: boolean
}

const ratio = (value: number, fallback: number): number => (Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback)
const count = (value: number | undefined, fallback: number): number => (Number.isSafeInteger(value) && value >= 0 ? (value as number) : fallback)

/** Validate, default, and freeze the compaction configuration. */
export function resolveConfig(config: BasicCompactionConfig = {}): ResolvedConfig {
  return Object.freeze({
    thresholdRatio: ratio(config.thresholdRatio ?? DEFAULTS.thresholdRatio, DEFAULTS.thresholdRatio),
    headroomTokens: count(config.headroomTokens, DEFAULTS.headroomTokens),
    retainRatio: ratio(config.retainRatio ?? DEFAULTS.retainRatio, DEFAULTS.retainRatio),
    ...config.retainTokens === undefined ? {} : { retainTokens: count(config.retainTokens, 0) },
    ...config.maxTokens === undefined || !Number.isSafeInteger(config.maxTokens) || (config.maxTokens as number) < 1
      ? {}
      : { maxTokens: config.maxTokens },
    compactionRetries: count(config.compactionRetries, DEFAULTS.compactionRetries),
    maxOverflowRetries: count(config.maxOverflowRetries, DEFAULTS.maxOverflowRetries),
    auto: config.auto ?? DEFAULTS.auto,
  })
}

/** Resolved pressure and retention budgets for one model route. */
export interface CompactionSpec {
  contextWindow: number
  /** Context capacity left for input after the reserved completion budget. */
  messageBudgetTokens: number
  /** Estimated request size at which compaction starts. */
  thresholdTokens: number
  /** Minimum recent tail kept verbatim by a pressure compaction. */
  retainTokens: number
}

/**
 * Reserve the completion budget and headroom first, then take the smaller of
 * the ratio threshold and the remaining pressure budget. The retained tail is a
 * fraction of the message budget and must stay below the threshold.
 */
export function resolveCompactSpec(
  config: ResolvedConfig,
  contextWindow: number,
  reservedCompletionTokens: number,
): CompactionSpec {
  const messageBudgetTokens = Math.max(1, contextWindow - reservedCompletionTokens)
  const pressureBudgetTokens = Math.max(1, messageBudgetTokens - config.headroomTokens)
  const thresholdTokens = Math.max(1, Math.floor(Math.min(contextWindow * config.thresholdRatio, pressureBudgetTokens)))
  const retainTokens = Math.min(
    config.retainTokens ?? Math.floor(messageBudgetTokens * config.retainRatio),
    thresholdTokens - 1,
  )
  if (retainTokens >= thresholdTokens) {
    throw new Error(
      `compaction-basic: retained tail (${retainTokens} tokens) must stay below the compaction threshold (${thresholdTokens} tokens)`,
    )
  }
  return { contextWindow, messageBudgetTokens, thresholdTokens, retainTokens: Math.max(0, retainTokens) }
}
