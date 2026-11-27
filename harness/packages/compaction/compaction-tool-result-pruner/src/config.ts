/**
 * Tool-result pruning budgets. Port of
 * `packages/compaction/compaction-tool-result-pruner/src/config.ts`.
 * @module @astra/compaction-tool-result-pruner/config
 */

/** Fixed marker substituted for a removed tool-result middle span. */
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

/** Low-friction budgets for coding-agent tool output. */
export const DEFAULTS = Object.freeze({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 })

export interface ResolvedConfig {
  readonly thresholdChars: number
  readonly headChars: number
  readonly tailChars: number
}

/** Length in Unicode code points, so a cut never splits a surrogate pair. */
export function codePointLength(text: string): number {
  let length = 0
  for (const _ of text) length++
  return length
}

/** Validate, default, and freeze the character budgets. */
export function resolveConfig(config: Partial<ResolvedConfig> = {}): ResolvedConfig {
  const resolved = {
    thresholdChars: config.thresholdChars ?? DEFAULTS.thresholdChars,
    headChars: config.headChars ?? DEFAULTS.headChars,
    tailChars: config.tailChars ?? DEFAULTS.tailChars,
  }
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`tool-result-pruner: ${name} must be a non-negative safe integer`)
  }
  if (resolved.thresholdChars < 1) throw new Error('tool-result-pruner: thresholdChars must be at least 1')
  if (resolved.headChars + resolved.tailChars >= resolved.thresholdChars) {
    throw new Error('tool-result-pruner: headChars + tailChars must be smaller than thresholdChars')
  }
  return Object.freeze(resolved)
}
