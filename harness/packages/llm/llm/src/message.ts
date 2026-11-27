/**
 * Assistant-message construction shared by the adapter and the loop.
 * Port of `createAssistantMessage` from `packages/llm/llm/src/index.ts`.
 * @module @astra/llm/message
 */

import type { Message, ToolCall } from './types.ts'

/** The wire assistant message for one assembled response. */
export function createAssistantMessage(text: string, toolCalls: readonly ToolCall[]): Message {
  const message: Message = { role: 'assistant', content: text === '' && toolCalls.length > 0 ? null : text }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }))
  }
  return message
}
