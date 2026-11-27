/**
 * Summarization directive and the one-shot LLM call that produces a checkpoint.
 * Port of `packages/compaction/compaction-basic/src/summarizer.ts`.
 * @module @astra/compaction-basic/summarizer
 */

import type { Llm, Message, TokenUsage, ToolSchema } from '../../../llm/llm/src/index.ts'
import { LlmError } from '../../../llm/llm/src/index.ts'
import { SUMMARY_OPEN_TAG } from '../../compaction/src/checkpoint.ts'

/**
 * The summarization directive, delivered as the final user message after the
 * replayed conversation so the provider's warm prefix cache is reused.
 */
export const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** The replayed conversation prefix to condense. */
export interface SummarizationInput {
  systemPrompt: string
  tools: readonly ToolSchema[]
  messages: readonly Message[]
}

/** Safe summary text and the auxiliary call's facts. */
export interface SummaryResult {
  /** Trimmed checkpoint text without framing. */
  summary: string
  /** Complete provider output before trimming. */
  rawOutput: string
  maxTokens?: number
  usage?: TokenUsage
}

/**
 * Summarize through a direct one-shot `llm.stream()` call whose prefix reuses
 * the conversation's own system prompt, tools, and messages.
 */
export async function summarizeWithLlm(
  llm: Llm,
  input: SummarizationInput,
  options: { maxTokens?: number; model?: string } = {},
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const maxTokens = options.maxTokens ?? llm.defaultMaxTokens
  let text = ''
  let usage: TokenUsage | undefined
  let toolCalls = 0
  let finish = ''
  for await (const chunk of llm.stream({
    model: options.model ?? llm.model,
    messages: [{ role: 'system', content: input.systemPrompt }, ...input.messages, { role: 'user', content: COMPACTION_INSTRUCTION }],
    tools: input.tools,
    maxTokens,
    signal,
  })) {
    if (chunk.type === 'text') text += chunk.text
    else if (chunk.type === 'tool-call') toolCalls += 1
    else if (chunk.type === 'finish') {
      usage = chunk.usage
      finish = chunk.finish.kind
      if (chunk.finish.kind === 'error' || chunk.finish.kind === 'aborted') {
        throw LlmError.fromFailure(chunk.finish.failure)
      }
    }
  }
  if (finish === 'max-tokens') throw new LlmError('compaction summary hit max-tokens', 'MAX_TOKENS')
  if (toolCalls > 0) throw new LlmError('compaction summary requested a tool call', 'MALFORMED_RESPONSE')
  const summary = text.trim()
  if (summary === '') throw new LlmError('compaction summary is empty', 'EMPTY_RESPONSE')
  return { summary, rawOutput: text, maxTokens, ...usage === undefined ? {} : { usage } }
}
