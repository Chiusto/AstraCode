/**
 * DeepSeek provider over streaming chat completions, with one cancellable
 * lifecycle and an idle watchdog per model request.
 * Port of `packages/llm/llm-deepseek/src/adapter.ts`; the public
 * `api.deepseek.com` route speaks `/chat/completions`, not the Messages API.
 * @module @astra/llm-deepseek/adapter
 */

import { BlockAssembler, LlmError } from '../../llm/src/index.ts'
import type {
  GenerateOptions,
  Llm,
  ResolvedRetryPolicy,
  StreamChunk,
  TokenUsage,
} from '../../llm/src/index.ts'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from './defaults.ts'
import { parseSse } from './sse.ts'
import { providerError } from './transport.ts'

/** One DeepSeek-compatible endpoint and credential. */
export interface DeepSeekConnectionOptions {
  baseUrl: string
  apiKey: string
  model?: string
  contextWindow?: number
  maxTokens?: number
  temperature?: number
  streamIdleTimeoutMs?: number
}

export interface DeepSeekAdapterOptions {
  connection: DeepSeekConnectionOptions
  retryPolicy?: ResolvedRetryPolicy
}

interface WireDelta {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: Array<{
    index?: number
    id?: string
    function?: { name?: string; arguments?: string }
  }>
}

interface WireChunk {
  choices?: Array<{ delta?: WireDelta; finish_reason?: string | null }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

function finishOf(reason: string | null | undefined, assembler: BlockAssembler): Extract<StreamChunk, { type: 'finish' }> {
  if (reason === 'length') return { type: 'finish', finish: { kind: 'max-tokens' }, usage: assembler.usage }
  if (reason === 'tool_calls') return { type: 'finish', finish: { kind: 'tool-calls' }, usage: assembler.usage }
  if (assembler.response().toolCalls.length > 0) {
    return { type: 'finish', finish: { kind: 'tool-calls' }, usage: assembler.usage }
  }
  if (reason === 'stop' && assembler.response().text === '') {
    return {
      type: 'finish',
      finish: { kind: 'error', failure: { message: 'DeepSeek returned an empty response', code: 'EMPTY_RESPONSE' } },
      usage: assembler.usage,
    }
  }
  return { type: 'finish', finish: { kind: 'stop' }, usage: assembler.usage }
}

/** DeepSeek provider using chat completions. */
export class DeepSeekAdapter implements Llm {
  readonly provider = 'deepseek'
  readonly model: string
  readonly contextWindow: number
  readonly defaultMaxTokens: number
  readonly retryPolicy?: ResolvedRetryPolicy
  private readonly connection: DeepSeekConnectionOptions

  constructor(options: DeepSeekAdapterOptions) {
    this.connection = options.connection
    this.model = options.connection.model ?? 'deepseek-chat'
    this.contextWindow = options.connection.contextWindow ?? DEFAULT_CONTEXT_WINDOW
    this.defaultMaxTokens = options.connection.maxTokens ?? DEFAULT_MAX_TOKENS
    this.retryPolicy = options.retryPolicy
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.generate(options)
  }

  private async *generate(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const consumer = new AbortController()
    const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([consumer.signal, options.signal])
    const idleTimeoutMs = this.connection.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
    const idle = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const pulse = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => idle.abort(new Error('idle')), idleTimeoutMs)
    }
    const fused = AbortSignal.any([signal, idle.signal])
    const assembler = new BlockAssembler()

    try {
      pulse()
      const body: Record<string, unknown> = {
        model: options.model ?? this.model,
        messages: options.messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      }
      const temperature = options.temperature ?? this.connection.temperature
      if (temperature !== undefined && Number.isFinite(temperature)) body.temperature = temperature
      if (options.tools !== undefined && options.tools.length > 0) body.tools = options.tools

      let response: Response
      try {
        response = await fetch(`${this.connection.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.connection.apiKey}` },
          body: JSON.stringify(body),
          signal: fused,
          redirect: 'error',
        })
      } catch (error) {
        if (idle.signal.aborted) throw new LlmError('DeepSeek stream idle timeout', 'TIMEOUT', { cause: error })
        if (options.signal?.aborted) throw new LlmError('DeepSeek request aborted', 'ABORTED', { cause: error })
        throw new LlmError('DeepSeek transport failed', 'TRANSPORT', { cause: error })
      }

      if (!response.ok) {
        const text = await response.text()
        let raw: unknown
        try {
          raw = JSON.parse(text)
        } catch {
          // HTTP status is authoritative when a gateway does not return JSON.
        }
        throw providerError(raw, response.status, response.headers)
      }
      if (response.body === null) throw new LlmError('DeepSeek returned no response body', 'EMPTY_RESPONSE')

      let finish: Extract<StreamChunk, { type: 'finish' }> | undefined
      for await (const payload of parseSse(response.body, pulse)) {
        let chunk: WireChunk
        try {
          chunk = JSON.parse(payload) as WireChunk
        } catch {
          continue
        }
        if (chunk.usage) {
          const cached = chunk.usage.prompt_cache_hit_tokens ?? chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
          const inputTokens = Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cached)
          const usage: TokenUsage = { inputTokens, outputTokens: chunk.usage.completion_tokens ?? 0, cacheReadTokens: cached }
          if (chunk.usage.total_tokens !== undefined) usage.totalTokens = chunk.usage.total_tokens
          assembler.push({ type: 'finish', finish: { kind: 'stop' }, usage })
        }
        const choice = chunk.choices?.[0]
        if (choice === undefined) continue
        const delta = choice.delta
        if (delta?.reasoning_content) {
          assembler.push({ type: 'reasoning', text: delta.reasoning_content })
          yield { type: 'reasoning', text: delta.reasoning_content }
        }
        if (delta?.content) {
          assembler.push({ type: 'text', text: delta.content })
          yield { type: 'text', text: delta.content }
        }
        for (const call of delta?.tool_calls ?? []) {
          const piece = {
            type: 'tool-call' as const,
            index: call.index ?? 0,
            id: call.id,
            name: call.function?.name,
            arguments: call.function?.arguments,
          }
          assembler.push(piece)
          yield piece
        }
        if (choice.finish_reason) finish = finishOf(choice.finish_reason, assembler)
      }
      yield finish ?? {
        type: 'finish',
        finish: { kind: 'error', failure: { message: 'DeepSeek stream closed before a finish reason', code: 'STREAM_CLOSED' } },
        usage: assembler.usage,
      }
    } catch (error) {
      if (idle.signal.aborted && !options.signal?.aborted) {
        throw new LlmError('DeepSeek stream idle timeout', 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) throw new LlmError('DeepSeek request aborted', 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      throw new LlmError('DeepSeek transport failed', 'TRANSPORT', { cause: error })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      consumer.abort()
    }
  }
}
