/**
 * Fixed-density heuristic token pricing.
 * Port of `packages/llm/token-meter/src/estimate.ts` for flat wire messages.
 * @module @astra/token-meter/estimate
 */

import type { Message, ToolSchema } from '../../llm/src/index.ts'

/** Fixed text-density estimate used until exact tokenization is needed. */
const CHARS_PER_TOKEN = 4

/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4

/** Role-field framing overhead added to every priced message. */
export const ROLE_OVERHEAD = 4

function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Price the rendered system prompt: text density plus role framing, no per-block overhead. */
export function estimateSystemMessage(text: string): number {
  return text.length === 0 ? 0 : textTokens(text) + ROLE_OVERHEAD
}

/** Heuristically price one model-visible message. */
export function estimateMessage(message: Message): number {
  let tokens = ROLE_OVERHEAD
  if (typeof message.content === 'string' && message.content.length > 0) {
    tokens += textTokens(message.content) + BLOCK_OVERHEAD
  }
  for (const call of message.tool_calls ?? []) {
    tokens += textTokens(call.function.name) + textTokens(call.function.arguments) + BLOCK_OVERHEAD
  }
  return tokens
}

/** Price the tool-schema part of a request envelope. */
export function estimateToolsTokens(tools: readonly ToolSchema[] | undefined): number {
  if (tools === undefined || tools.length === 0) return 0
  return textTokens(JSON.stringify(tools)) + BLOCK_OVERHEAD
}
