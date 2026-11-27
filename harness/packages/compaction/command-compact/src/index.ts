/**
 * `/compact`: one argument-free manual compaction request, reported as text.
 * Port of `packages/compaction/command-compact/src/index.ts`; the command
 * registry becomes a function the shell calls, and `CommandResult` loses its
 * presentation-only fields.
 * @module @astra/command-compact
 */

import type { Agent } from '../../../core/agent/src/index.ts'
import type { CompactionEngine } from '../../compaction/src/index.ts'
import { ManualCompactionError } from '../../compaction/src/index.ts'

/** Usage text of the command. */
export const USAGE = 'Usage: /compact (no arguments)'

/** Description shown in command listings. */
export const DESCRIPTION = 'Compact older conversation history'

export interface CommandResult {
  kind: 'success' | 'error'
  text: string
}

/** Convert expected capability failures into concise human-only outcomes. */
function expectedFailure(error: ManualCompactionError): CommandResult {
  switch (error.code) {
    case 'busy':
      return {
        kind: 'error',
        text: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
      }
    case 'cancelled':
      return { kind: 'error', text: 'Compaction cancelled.' }
    case 'changed':
      return {
        kind: 'error',
        text: 'The history selected for compaction changed before it could be replaced. The attempt is recorded in the session log.',
      }
    case 'summary':
      return {
        kind: 'error',
        text: 'Compaction could not produce a useful summary. The attempt is recorded in the session log.',
      }
    case 'commit':
      return {
        kind: 'error',
        text: 'Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.',
      }
    case 'persistence':
      return {
        kind: 'error',
        text: 'Compaction finished, but the session could not be saved.',
      }
  }
}

/** Execute one argument-free manual compaction request. */
export async function executeCompact(
  compaction: CompactionEngine,
  agent: Agent,
  rawInput: string,
  signal: AbortSignal,
): Promise<CommandResult> {
  if (rawInput.trim().length > 0) return { kind: 'error', text: USAGE }
  try {
    const result = await compaction.compactNow(agent, signal)
    if (result === null) return { kind: 'success', text: 'No compactable history yet.' }
    return {
      kind: 'success',
      text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,
    }
  } catch (error: unknown) {
    if (signal.aborted) return { kind: 'error', text: 'Compaction cancelled.' }
    if (error instanceof ManualCompactionError) return expectedFailure(error)
    throw error
  }
}
