/**
 * Dependency-light compaction backend using the token meter for pressure,
 * retention, and summary-convergence pricing.
 * Port of `packages/compaction/compaction-basic/src/index.ts` without cordis:
 * the `agent/pre-step` and `agent/request-error` listeners become methods the
 * agent loop calls, and `ctx.*` services become constructor dependencies.
 * @module @astra/compaction-basic
 */

import type { Agent, RequestErrorAction } from '../../../core/agent/src/index.ts'
import type { RequestHeader } from '../../../core/session/src/index.ts'
import type { Llm } from '../../../llm/llm/src/index.ts'
import type { TokenMeasurement, TokenMeter } from '../../../llm/token-meter/src/index.ts'
import type { ToolResultPruner } from '../../compaction-tool-result-pruner/src/index.ts'
import { assertNoActiveCompaction } from '../../compaction/src/index.ts'
import type { CompactionEngine, CompactionResult, CompactionTrigger } from '../../compaction/src/index.ts'
import { ManualCompactionError } from '../../compaction/src/index.ts'
import { resolveCompactSpec, resolveConfig } from './config.ts'
import type { BasicCompactionConfig, ResolvedConfig } from './config.ts'
import { compactSurfaceRegion, selectCompactableRange } from './region.ts'
import { summarizeWithLlm } from './summarizer.ts'

export {
  COMPACTION_INSTRUCTION,
  summarizeWithLlm,
} from './summarizer.ts'
export type { SummaryResult, SummarizationInput } from './summarizer.ts'
export { DEFAULTS, resolveCompactSpec, resolveConfig } from './config.ts'
export type { BasicCompactionConfig, CompactionSpec, ResolvedConfig } from './config.ts'
export { SurfaceChangedError, compactSurfaceRegion, selectCompactableRange } from './region.ts'
export type { CompactionTransactionOptions, RegionDependencies } from './region.ts'

export interface BasicCompactionEngineOptions {
  llm: Llm
  tokenMeter: TokenMeter
  toolResultPruner?: ToolResultPruner
  config?: BasicCompactionConfig
  /** Called after every summary compaction this engine lands. */
  onCompaction?: (result: CompactionResult, trigger: CompactionTrigger | 'manual') => void
}

export class BasicCompactionEngine implements CompactionEngine {
  readonly config: ResolvedConfig
  private readonly options: BasicCompactionEngineOptions
  /** Overflow attempts of the current request sequence; a successful response starts a fresh one. */
  private readonly overflowRetries = new WeakMap<Agent, number>()

  constructor(options: BasicCompactionEngineOptions) {
    this.options = options
    this.config = resolveConfig(options.config)
  }

  private get llm(): Llm {
    return this.options.llm
  }

  private get meter(): TokenMeter {
    return this.options.tokenMeter
  }

  /**
   * Compact for replayed step-boundary pressure or one provider-confirmed
   * context overflow. Overflow bypasses the threshold and retained-tail policy
   * so it can force one useful balanced reduction.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  async compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
    const session = agent.session
    const header = session.requestHeader()
    if (header === undefined) return null
    if (trigger === 'pressure') return this.compactPressure(agent, header, signal)

    this.options.toolResultPruner?.pruneSession(session, this.meter)
    const range = selectCompactableRange(session, this.measure(agent, header), 0)
    if (range === null) return null
    return this.compactRegion(range.start, range.end, agent, signal)
  }

  /**
   * Between-step pressure check. Once pressure qualifies, the model-free prune
   * lands before a summary range is chosen, then pressure is remeasured.
   * @returns the compaction that brought the session below threshold, or `null`.
   */
  private async compactPressure(agent: Agent, header: RequestHeader, signal: AbortSignal): Promise<CompactionResult | null> {
    const session = agent.session
    const spec = resolveCompactSpec(this.config, this.llm.contextWindow, header.maxTokens)
    let measurement = this.measure(agent, header)
    if (measurement.totalTokens < spec.thresholdTokens) return null
    assertNoActiveCompaction(session, 'automatic pressure compaction')

    if (this.options.toolResultPruner !== undefined) {
      this.options.toolResultPruner.pruneSession(session, this.meter)
      measurement = this.measure(agent, header)
      if (measurement.totalTokens < spec.thresholdTokens) return null
    }

    let result: CompactionResult | null = null
    for (let attempt = 0; attempt <= this.config.compactionRetries; attempt += 1) {
      const range = selectCompactableRange(session, measurement, spec.retainTokens)
      if (range === null) {
        if (result === null) return null
        throw new Error(
          `no safe compaction range can reduce context below threshold `
          + `(${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
        )
      }
      result = await this.compactRegion(range.start, range.end, agent, signal)
      this.options.onCompaction?.(result, 'pressure')
      measurement = this.measure(agent, header)
      if (measurement.totalTokens < spec.thresholdTokens) return result
    }
    throw new Error(
      `compaction still above threshold after ${this.config.compactionRetries + 1} compaction attempts `
      + `(${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
    )
  }

  /** Compact one inclusive positional range from the agent-owned surface. */
  async compactRegion(start: number, end: number, agent: Agent, signal?: AbortSignal): Promise<CompactionResult> {
    const turn = agent.session.openTurn()
    if (turn === null) {
      throw new Error('compactRegion: no open turn — automatic compaction events must be enclosed in a turn')
    }
    return compactSurfaceRegion(this.regionDependencies(), agent.session, start, end, { owner: turn }, signal)
  }

  /**
   * Force one useful idle-session compaction below the pressure threshold.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  async compactNow(agent: Agent, signal: AbortSignal): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    if (agent.status !== 'idle') {
      throw new ManualCompactionError('busy', 'manual compaction requires an idle agent')
    }
    const session = agent.session
    try {
      const range = selectCompactableRange(session, this.meter.measure(session), 0)
      if (range === null) return null
      const result = await compactSurfaceRegion(this.regionDependencies(), session, range.start, range.end, { owner: null }, signal)
      this.options.onCompaction?.(result, 'manual')
      return result
    } catch (error: unknown) {
      if (signal.aborted) {
        throw new ManualCompactionError('cancelled', 'manual compaction was cancelled', { cause: error })
      }
      throw error
    }
  }

  /**
   * `request-error` recovery for a provider-confirmed context overflow. A
   * model-free prune that landed before a later summary failure still counts
   * as durable progress and justifies one retry.
   * @returns `retry` when the surface shrank and the request may be resent.
   */
  async recoverFromOverflow(agent: Agent, signal: AbortSignal): Promise<RequestErrorAction> {
    const retries = this.overflowRetries.get(agent) ?? 0
    if (retries >= this.config.maxOverflowRetries) return undefined
    const session = agent.session
    const generation = session.surface.replaceGeneration
    try {
      const result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      if (result !== null) this.options.onCompaction?.(result, 'context-overflow')
    } catch (error: unknown) {
      if (!signal.aborted && session.surface.replaceGeneration > generation) {
        this.overflowRetries.set(agent, retries + 1)
        return { kind: 'retry' }
      }
      throw error
    }
    if (signal.aborted || session.surface.replaceGeneration <= generation) return undefined
    this.overflowRetries.set(agent, retries + 1)
    return { kind: 'retry' }
  }

  /** A successful response starts a fresh overflow-recovery sequence. */
  noteAssistantMessage(agent: Agent): void {
    this.overflowRetries.delete(agent)
  }

  private measure(agent: Agent, header: RequestHeader): TokenMeasurement {
    return this.meter.measure(agent.session, header)
  }

  private regionDependencies() {
    return {
      meter: this.meter,
      provider: this.llm.provider,
      model: this.llm.model,
      summarize: (input: Parameters<typeof summarizeWithLlm>[1], signal?: AbortSignal) =>
        summarizeWithLlm(this.llm, input, { maxTokens: this.config.maxTokens }, signal),
    }
  }
}
