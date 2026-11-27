/**
 * Range selection and the single compaction transaction over one surface span.
 * Port of `packages/compaction/compaction-basic/src/region.ts`; the system
 * prompt is request-supplied here, so every surface node is compactable.
 * @module @astra/compaction-basic/region
 */

import { randomUUID } from 'node:crypto'
import type { Session, SessionSeq } from '../../../core/session/src/index.ts'
import { surfaceMessageOf } from '../../../core/session/src/index.ts'
import type { TokenMeasurement, TokenMeter } from '../../../llm/token-meter/src/index.ts'
import type { Message } from '../../../llm/llm/src/index.ts'
import { errorChain } from '../../../llm/llm/src/index.ts'
import { estimateMessage } from '../../../llm/token-meter/src/index.ts'
import { compactCheckpointSource, frameSummary, toolPairingBalancedAfter, toolPairingBalancedBefore } from '../../compaction/src/index.ts'
import type { CompactionResult } from '../../compaction/src/index.ts'
import { ManualCompactionError, assertNoActiveCompaction } from '../../compaction/src/index.ts'
import type { SummaryResult, SummarizationInput } from './summarizer.ts'

/** The meter, the summarizer hook, and the route that summarizes. */
export interface RegionDependencies {
  meter: TokenMeter
  summarize: (input: SummarizationInput, signal?: AbortSignal) => Promise<SummaryResult>
  provider: string
  model: string
}

export interface CompactionTransactionOptions {
  /** Open turn enclosing an automatic compaction; `null` for a standalone manual one. */
  owner: number | null
}

/** The selected surface changed between selection and replacement. */
export class SurfaceChangedError extends Error {
  override readonly name = 'SurfaceChangedError'
  constructor(message: string) {
    super(message)
  }
}

interface SurfaceSelection {
  startIdx: number
  endIdx: number
  shadowedSeqs: SessionSeq[]
  shadowedTokenCount: number
}

/**
 * Resolve the next range while retaining a priced recent tail and never
 * splitting an assistant tool-call/result pair.
 * @returns the inclusive positional seq range to compact, or `null`.
 */
export function selectCompactableRange(
  session: Session,
  measurement: TokenMeasurement,
  retainTokens: number,
): { start: SessionSeq; end: SessionSeq } | null {
  const pricedNodes = measurement.nodes
  if (pricedNodes.length === 0) return null
  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== pricedNodes.length || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error('compaction: token-meter surface does not match the current session surface')
  }

  let accumulated = 0
  let keepFromIdx = pricedNodes.length
  for (let index = pricedNodes.length - 1; index >= 0; index--) {
    accumulated += pricedNodes[index]?.tokens ?? 0
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx <= 0) return null

  while (keepFromIdx > 0 && !toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx] as SessionSeq)) keepFromIdx -= 1
  if (keepFromIdx <= 0) return null
  return { start: surfaceNodes[0] as SessionSeq, end: surfaceNodes[keepFromIdx - 1] as SessionSeq }
}

function validateSurfaceRegion(session: Session, start: SessionSeq, end: SessionSeq): SurfaceSelection {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`)
  if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`)
  if (endIdx < startIdx) throw new Error(`compactRegion: end seq ${end} precedes start seq ${start} in the surface`)
  if (!toolPairingBalancedBefore(session, start)) {
    throw new Error(`compactRegion: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`)
  }
  if (!toolPairingBalancedAfter(session, end)) {
    throw new Error(`compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`)
  }
  const shadowedSeqs = nodes.slice(startIdx, endIdx + 1)
  const shadowedTokenCount = shadowedSeqs.reduce((sum, seq) => {
    const event = session.eventAt(seq)
    const message = event === undefined ? undefined : surfaceMessageOf(event)
    return sum + (message === undefined ? 0 : estimateMessage(message))
  }, 0)
  return { startIdx, endIdx, shadowedSeqs, shadowedTokenCount }
}

/**
 * Run the single compaction transaction over one selected positional span.
 * `compaction/start` is the durable lock before summarization yields; every
 * later failure makes exactly one `compaction/end` attempt.
 */
export async function compactSurfaceRegion(
  dependencies: RegionDependencies,
  session: Session,
  start: SessionSeq,
  end: SessionSeq,
  options: CompactionTransactionOptions,
  signal?: AbortSignal,
): Promise<CompactionResult> {
  const selection = validateSurfaceRegion(session, start, end)
  assertNoActiveCompaction(session, 'compaction')
  const openTurn = session.openTurn()
  if (options.owner === null) {
    if (openTurn !== null) throw new ManualCompactionError('busy', 'manual compaction: the session already has an open turn')
  } else if (openTurn === null) {
    throw new Error('compactRegion: no open turn — automatic compaction events must be enclosed in a turn')
  }

  const compactionId = randomUUID()
  const lifecycle = { compactionId, turn: options.owner }
  const snapshot = [...session.surface.nodes]
  const assertStable = (stage: string): void => {
    const current = session.surface.nodes
    if (current.length !== snapshot.length || current.some((seq, index) => seq !== snapshot[index])) {
      throw new SurfaceChangedError(`compaction: ${stage}`)
    }
  }

  const startEvent = session.append('compaction/start', lifecycle)
  let stage: 'summary' | 'commit' = 'summary'
  let failure: { error: unknown; stage: 'summary' | 'commit' } | undefined
  let result: CompactionResult | undefined

  try {
    const header = session.requestHeader()
    const summarized = await dependencies.summarize({
      systemPrompt: header?.systemPrompt ?? '',
      tools: header?.tools ?? [],
      messages: session.messages.slice(0, selection.endIdx + 1),
    }, signal)
    assertStable('the selected span changed during summarization')

    const message: Message = {
      role: 'user',
      content: frameSummary(summarized.summary),
    }
    const summaryTokens = estimateMessage(message)
    if (summaryTokens >= selection.shadowedTokenCount) {
      throw new Error(
        `compaction: framed summary (${summaryTokens} tokens) is not smaller than the shadowed history `
        + `(${selection.shadowedTokenCount} tokens)`,
      )
    }
    stage = 'commit'
    const summaryEvent = session.append('compaction/summary', {
      ...lifecycle,
      summary: summarized.summary,
      shadowedRange: { start, end },
      shadowedSeqs: selection.shadowedSeqs,
      shadowedTokenCount: selection.shadowedTokenCount,
      provider: dependencies.provider,
      model: dependencies.model,
      ...summarized.maxTokens === undefined ? {} : { maxTokens: summarized.maxTokens },
      ...summarized.usage === undefined ? {} : { usage: summarized.usage },
    })
    session.append('user/message', { message, source: compactCheckpointSource(compactionId) }, {
      surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
      sourceEventSeqs: selection.shadowedSeqs,
    })
    const endEvent = session.append('compaction/end', lifecycle)
    result = {
      compactionId,
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      endSeq: endEvent.seq,
      summary: summarized.summary,
      shadowedRange: { start, end },
      shadowedSeqs: selection.shadowedSeqs,
      shadowedTokenCount: selection.shadowedTokenCount,
    }
  } catch (error: unknown) {
    failure = { error, stage }
    session.append('compaction/end', { ...lifecycle, error: errorChain(error) })
  }

  if (failure !== undefined) {
    if (options.owner === null) throwManualFailure(failure)
    throw failure.error
  }
  if (result === undefined) throw new Error('compaction committed without a result')
  return result
}

/** Classify one closed manual attempt without weakening cancellation precedence. */
function throwManualFailure(failure: { error: unknown; stage: 'summary' | 'commit' }): never {
  if (failure.stage === 'commit') {
    throw new ManualCompactionError('commit', 'manual compaction did not commit cleanly', { cause: failure.error })
  }
  if (failure.error instanceof SurfaceChangedError) {
    throw new ManualCompactionError('changed', 'the compacted history changed during manual compaction', { cause: failure.error })
  }
  throw new ManualCompactionError('summary', 'manual compaction could not produce a smaller summary', { cause: failure.error })
}
