/**
 * Compaction seam: the engine contract every backend fulfils and the manual
 * failure vocabulary. Port of `packages/compaction/compaction/src/index.ts`.
 * @module @astra/compaction
 */

import type { Session, SessionSeq } from '../../../core/session/src/index.ts'
import type { Agent, RequestErrorAction } from '../../../core/agent/src/index.ts'
import type { CompactionResult, CompactionTrigger } from './types.ts'

export { CHECKPOINT_PREAMBLE, SUMMARY_CLOSE_TAG, SUMMARY_OPEN_TAG, compactCheckpointSource, frameSummary, isCheckpointMessage, isCompactCheckpointSource } from './checkpoint.ts'
export type { CompactionCheckpointSource } from './checkpoint.ts'
export { toolPairingBalancedAfter, toolPairingBalancedBefore } from './tool-pairing.ts'
export type { CompactionId, CompactionResult, CompactionTrigger } from './types.ts'

/** Why a manual compaction did not complete. */
export type ManualCompactionErrorCode = 'busy' | 'cancelled' | 'changed' | 'summary' | 'commit' | 'persistence'

/** A manual compaction failure that is reported to the user instead of thrown as a crash. */
export class ManualCompactionError extends Error {
  override readonly name = 'ManualCompactionError'
  readonly code: ManualCompactionErrorCode

  constructor(code: ManualCompactionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}

/** A backend that summarizes older history into one checkpoint. */
export interface CompactionEngine {
  /** Compact for step-boundary pressure or one provider-confirmed context overflow. */
  compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null>
  /** Compact one inclusive positional range from the agent-owned surface. */
  compactRegion(start: SessionSeq, end: SessionSeq, agent: Agent, signal?: AbortSignal): Promise<CompactionResult>
  /** Force one useful idle-session compaction below the pressure threshold. */
  compactNow(agent: Agent, signal: AbortSignal): Promise<CompactionResult | null>
  /** Optional: a successful response starts a fresh overflow-recovery sequence. */
  noteAssistantMessage?(agent: Agent): void
}

/** Latest unmatched `compaction/start`, i.e. the durable compaction lock. */
export function activeCompactionStart(session: Session): { seq: SessionSeq; compactionId: string } | undefined {
  let open: { seq: SessionSeq; compactionId: string } | undefined
  for (const event of session.events()) {
    if (event.type === 'compaction/start') open = { seq: event.seq, compactionId: event.data.compactionId }
    else if (event.type === 'compaction/end' && open !== undefined && open.compactionId === event.data.compactionId) open = undefined
  }
  return open
}

/** Throw the busy manual failure when the session compaction lock is already active. */
export function assertNoActiveCompaction(session: Session, stage: string): void {
  if (activeCompactionStart(session) !== undefined) {
    throw new ManualCompactionError('busy', `${stage}: compaction already in progress; the session compaction lock is already active`)
  }
}

/** What a `request-error` listener decides about one failed model request. */
export type { RequestErrorAction }
