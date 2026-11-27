/**
 * Default Agent driver: one user turn, up to `maxSteps` model requests, tool
 * calls executed between them. Every request is derived from the session log;
 * pressure compaction and the time reading run at the step boundary.
 * Port of `packages/core/agent-loop/src/agent.ts` without the cordis registry,
 * queued turns and live stream frames.
 * @module @astra/agent-loop
 */

import {
  BlockAssembler,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmError,
  createAssistantMessage,
  toLlmFailure,
} from '../../../llm/llm/src/index.ts'
import type { Llm, TokenUsage, ToolCall, ToolSchema } from '../../../llm/llm/src/index.ts'
import { retryRequest } from '../../../llm/llm-retry/src/index.ts'
import type { RetryDecision, RetryRequest } from '../../../llm/llm-retry/src/index.ts'
import type { Agent, ModelSelection } from '../../agent/src/index.ts'
import type { TurnEndReason } from '../../session/src/index.ts'
import { ToolCallRecovery } from '../../session/src/index.ts'
import type { ToolDefinition, ToolExecutionResult, ToolExecutor } from '../../tools/src/index.ts'
import type { CompactionEngine } from '../../../compaction/compaction/src/index.ts'
import { injectTimeContext } from '../../../context/time-context/src/index.ts'
import type { TimeContextConfig } from '../../../context/time-context/src/index.ts'

export interface TurnHooks {
  /** Called before each model request, so the shell can show a spinner. */
  onThinking?: (turn: number, step: number) => void
  onText: (chunk: string) => void
  onReasoning: (chunk: string) => void
  /** One accepted call, before the tool body runs. */
  onToolCall?: (call: ToolCall) => void
  onToolResult?: (call: ToolCall, result: ToolExecutionResult) => void
  /** Non-fatal notes: compaction failures and turn-limit notices. */
  onNotice?: (text: string) => void
}

export interface TurnInput {
  text: string
  signal: AbortSignal
}

export interface AgentLoopOptions {
  llm: Llm
  tools: readonly ToolDefinition[]
  executor: ToolExecutor
  /** The system prompt sent with every request; recorded in the request header. */
  systemPrompt: () => string
  /** The configured route the session's model alias resolves to. */
  selection: ModelSelection
  /** Maximum model requests per turn. */
  maxSteps: number
  maxTokens?: number
  temperature?: number
  /** Pressure and overflow compaction; omitted disables both. */
  compaction?: CompactionEngine
  /** Durable time reading before each eligible step; `false` disables it. */
  timeContext?: TimeContextConfig | false
  /** Overrides the retry-policy execution for a failed request. */
  retry?: (request: RetryRequest) => Promise<RetryDecision | undefined>
}

export interface TurnResult {
  ok: boolean
  aborted: boolean
  steps: number
  seconds: number
  usage: TokenUsage
}

/** Internal signal that the caller cancelled the turn. */
class TurnAbortedError extends Error {
  override readonly name = 'TurnAbortedError'
}

type StepEnd = 'completed' | 'max-tokens'

/** Run one user turn to completion. The caller owns the agent's running status. */
export async function runTurn(
  agent: Agent,
  input: TurnInput,
  options: AgentLoopOptions,
  hooks: TurnHooks,
): Promise<TurnResult> {
  const { llm } = options
  const { session } = agent
  const { signal } = input
  const turn = session.nextTurn
  const started = Date.now()
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
  const model = agent.options.model ?? options.selection.model
  const maxTokens = agent.options.maxTokens ?? options.maxTokens ?? llm.defaultMaxTokens
  const temperature = agent.options.temperature ?? options.temperature
  const schemas: readonly ToolSchema[] = options.executor.describe(options.tools).schemas
  const retry = options.retry ?? retryRequest
  let steps = 0
  let turnEnd: TurnEndReason = { kind: 'completed' }
  let pendingError: unknown = undefined

  const addUsage = (reported?: TokenUsage): void => {
    if (reported === undefined) return
    usage.inputTokens += reported.inputTokens
    usage.outputTokens += reported.outputTokens
    usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (reported.cacheReadTokens ?? 0)
    if (reported.totalTokens !== undefined) usage.totalTokens = (usage.totalTokens ?? 0) + reported.totalTokens
  }

  /** Keep partial output of a cancelled stream and balance its tool calls. */
  const settleInterrupted = (assembler: BlockAssembler): void => {
    const response = assembler.response()
    addUsage(response.usage)
    if (!response.text && response.toolCalls.length === 0) return
    const message = createAssistantMessage(response.text, response.toolCalls)
    const event = session.append('assistant/message', {
      turn,
      step: steps,
      message,
      interrupted: true,
      ...response.usage === undefined ? {} : { usage: response.usage },
    }, { surfaceOp: 'append' })
    if (response.toolCalls.length === 0) return
    const recovery = new ToolCallRecovery()
    recovery.observe(event)
    for (const result of recovery.results()) {
      session.append('tool/result', result.data, {
        surfaceOp: 'append',
        ...result.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: result.sourceEventSeqs },
      })
    }
  }

  const recover = async (failure: ReturnType<typeof toLlmFailure>): Promise<boolean> => {
    if (options.compaction !== undefined && failure.code === CONTEXT_WINDOW_EXCEEDED_CODE) {
      const action = await options.compaction.recoverFromOverflow(agent, signal)
      if (action?.kind === 'retry') return true
    }
    const decision = await retry({
      session,
      provider: llm.provider,
      policy: llm.retryPolicy,
      turn,
      step: steps,
      failure,
      signal,
    })
    return decision !== undefined
  }

  const runStep = async (step: number): Promise<StepEnd | null> => {
    const turnStep = { turn, step }
    while (true) {
      hooks.onThinking?.(turn, step)
      session.recordRequest({
        provider: llm.provider,
        model,
        maxTokens,
        systemPrompt: options.systemPrompt(),
        tools: schemas,
      })
      const assembler = new BlockAssembler()
      try {
        for await (const chunk of llm.stream({ model, messages: session.messages, tools: schemas, maxTokens, temperature, signal })) {
          assembler.push(chunk)
          if (chunk.type === 'text') hooks.onText(chunk.text)
          else if (chunk.type === 'reasoning') hooks.onReasoning(chunk.text)
        }
      } catch (error) {
        const failure = toLlmFailure(error)
        if (signal.aborted || failure.code === 'ABORTED') {
          settleInterrupted(assembler)
          throw new TurnAbortedError('turn aborted')
        }
        if (!await recover(failure)) {
          if (signal.aborted) {
            settleInterrupted(assembler)
            throw new TurnAbortedError('turn aborted')
          }
          throw error instanceof LlmError ? error : LlmError.fromFailure(failure, error)
        }
        continue
      }

      const response = assembler.response()
      if (response.finish.kind === 'error' || response.finish.kind === 'aborted') {
        const failure = response.finish.failure
        if (response.finish.kind === 'aborted' || signal.aborted) {
          settleInterrupted(assembler)
          throw new TurnAbortedError('turn aborted')
        }
        if (!await recover(failure)) {
          if (signal.aborted) {
            settleInterrupted(assembler)
            throw new TurnAbortedError('turn aborted')
          }
          throw LlmError.fromFailure(failure)
        }
        continue
      }

      addUsage(response.usage)
      session.append('assistant/message', {
        ...turnStep,
        message: createAssistantMessage(response.text, response.toolCalls),
        ...response.usage === undefined ? {} : { usage: response.usage },
      }, { surfaceOp: 'append' })
      options.compaction?.noteAssistantMessage?.(agent)
      if (response.finish.kind === 'max-tokens') return 'max-tokens'
      if (response.toolCalls.length === 0) return 'completed'

      for (const call of response.toolCalls) {
        session.append('tool/call', { ...turnStep, callId: call.id, name: call.name, arguments: call.arguments })
        hooks.onToolCall?.(call)
      }
      const batch = await options.executor.execute({ calls: response.toolCalls, signal, cwd: session.cwd }, options.tools)
      batch.results.forEach(({ callId, result }, index) => {
        const call = response.toolCalls[index]
        session.append('tool/result', {
          ...turnStep,
          message: {
            role: 'tool',
            tool_call_id: callId,
            content: result.isError ? `Error: ${result.content}` : result.content,
          },
          ...result.isError ? { error: result.error.info ?? { name: 'ToolError', code: 'TOOL_ERROR' } } : {},
        }, { surfaceOp: 'append' })
        if (call !== undefined) hooks.onToolResult?.(call, result)
      })
      return null
    }
  }

  session.append('user/message', { message: { role: 'user', content: input.text }, source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('turn/start', { turn })

  let ended: StepEnd | null = null
  try {
    const maxSteps = Math.max(1, options.maxSteps)
    for (let step = 1; step <= maxSteps; step++) {
      steps = step
      signal.throwIfAborted()
      if (options.compaction !== undefined) {
        try {
          await options.compaction.compactIfNeeded(agent, 'pressure', signal)
        } catch (error) {
          if (signal.aborted) throw error
          hooks.onNotice?.(`压缩上下文失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (options.timeContext !== undefined && options.timeContext !== false) {
        injectTimeContext(agent, turn, step, options.timeContext)
      }
      signal.throwIfAborted()

      session.append('step/start', { turn, step })
      const stepStart = session.seq - 1
      try {
        ended = await runStep(step)
      } catch (error) {
        // Balance any tool request the failed step left unanswered before the
        // surface becomes unreadable to the next request or a resume.
        const recovery = new ToolCallRecovery()
        for (const event of session.events().slice(stepStart)) recovery.observe(event)
        for (const result of recovery.results()) {
          session.append('tool/result', result.data, {
            surfaceOp: 'append',
            ...result.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: result.sourceEventSeqs },
          })
        }
        throw error
      } finally {
        session.append('step/end', { turn, step })
      }
      if (ended !== null) break
    }
    if (ended === null) {
      turnEnd = { kind: 'completed' }
      hooks.onNotice?.(`已达到单轮最大步数 ${options.maxSteps}，停止继续调用工具。`)
    } else {
      turnEnd = ended === 'max-tokens' ? { kind: 'max-tokens' } : { kind: 'completed' }
    }
  } catch (error) {
    if (error instanceof TurnAbortedError || signal.aborted) turnEnd = { kind: 'aborted' }
    else {
      turnEnd = { kind: 'error' }
      pendingError = error
    }
  } finally {
    session.append('turn/end', { turn, reason: turnEnd })
  }

  if (pendingError !== undefined) throw pendingError
  return {
    ok: turnEnd.kind !== 'aborted',
    aborted: turnEnd.kind === 'aborted',
    steps,
    seconds: (Date.now() - started) / 1000,
    usage,
  }
}
