/**
 * Compaction checkpoint source: the constructor and predicate for the
 * replacement user message, plus the predicate that recognizes persisted
 * checkpoints. Port of `packages/compaction/compaction/src/checkpoint.ts`.
 *
 * Flat wire messages carry no `source`, so a persisted checkpoint is
 * recognized by its durable preamble prefix.
 * @module @astra/compaction/checkpoint
 */

import type { Message } from '../../../llm/llm/src/index.ts'
import type { MessageSource } from '../../../core/session/src/index.ts'
import type { CompactionId } from './types.ts'

/** Framing that makes the replacement user message established context. */
export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/** Tags wrapping the structured summary inside the landed checkpoint node. */
export const SUMMARY_OPEN_TAG = '<compacted-summary>'
export const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** Message source carried by a compaction checkpoint. */
export type CompactionCheckpointSource = { kind: 'compact-checkpoint'; compactionId: CompactionId }

/** Create a checkpoint source correlated with one compaction transaction. */
export function compactCheckpointSource(compactionId: CompactionId): CompactionCheckpointSource {
  return { kind: 'compact-checkpoint', compactionId }
}

/** Whether a message source identifies a compaction checkpoint. */
export function isCompactCheckpointSource(source: MessageSource): source is CompactionCheckpointSource {
  return source.kind === 'compact-checkpoint'
}

/** Wrap raw summary text in the durable checkpoint framing. */
export function frameSummary(summary: string): string {
  return `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}\n${summary.trim()}\n${SUMMARY_CLOSE_TAG}`
}

/** Whether a persisted user message is a compaction checkpoint. */
export function isCheckpointMessage(message: Message): boolean {
  return message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(CHECKPOINT_PREAMBLE)
}
