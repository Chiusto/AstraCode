/**
 * Fold streamed deltas into one complete assistant response.
 * Port of `packages/llm/llm/src/assembler.ts` for the flat wire shape.
 * @module @astra/llm/assembler
 */

import type { FinishReason, StreamChunk, TokenUsage, ToolCall } from './types.ts'

/** A tool-call delta; providers split id, name and arguments across chunks. */
export interface ToolCallDelta {
  index: number
  id?: string
  name?: string
  arguments?: string
}

export interface AssistantResponse {
  text: string
  reasoning: string
  toolCalls: ToolCall[]
  usage?: TokenUsage
  finish: FinishReason
}

/** Accumulates {@link StreamChunk}s until the terminal `finish` chunk. */
export class BlockAssembler {
  private text = ''
  private reasoning = ''
  private readonly calls = new Map<number, { id: string; name: string; arguments: string }>()
  private usage?: TokenUsage
  private finish?: FinishReason

  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'text':
        this.text += chunk.text
        break
      case 'reasoning':
        this.reasoning += chunk.text
        break
      case 'tool-call': {
        const current = this.calls.get(chunk.index) ?? { id: '', name: '', arguments: '' }
        if (chunk.id !== undefined) current.id += chunk.id
        if (chunk.name !== undefined) current.name += chunk.name
        if (chunk.arguments !== undefined) current.arguments += chunk.arguments
        this.calls.set(chunk.index, current)
        break
      }
      case 'finish':
        if (chunk.usage !== undefined) this.usage = chunk.usage
        this.finish = chunk.finish
        break
    }
  }

  get usage(): TokenUsage | undefined {
    return this.usage
  }

  get finish(): FinishReason | undefined {
    return this.finish
  }

  /** The assembled response; a stream that ended without `finish` counts as closed early. */
  response(): AssistantResponse {
    const toolCalls = [...this.calls.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([index, call]) => ({
        id: call.id === '' ? `call_${index}` : call.id,
        name: call.name,
        arguments: call.arguments === '' ? '{}' : call.arguments,
      }))
    return {
      text: this.text,
      reasoning: this.reasoning,
      toolCalls,
      usage: this.usage,
      finish: this.finish ?? { kind: 'error', failure: { message: '模型响应流在没有结束标记的情况下关闭', code: 'STREAM_CLOSED' } },
    }
  }
}
