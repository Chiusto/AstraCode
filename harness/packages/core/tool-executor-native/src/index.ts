/**
 * Native tool executor: argument parsing, unknown-tool and approval failures,
 * sequential execution in model order, and error-to-result conversion.
 * Port of `packages/core/tool-executor-native/src/index.ts` without cordis.
 * @module @astra/tool-executor-native
 */

import {
  APPROVAL_ERROR_NAME,
  APPROVAL_REJECTED,
  TOOL_ABORTED,
  TOOL_ABORTED_BEFORE_DISPATCH,
  ToolNotFoundError,
} from '../../tools/src/contracts.ts'
import type {
  ToolBatchInput,
  ToolBatchResult,
  ToolCallResult,
  ToolDefinition,
  ToolExecutor,
  ToolExecutionResult,
  ToolFailure,
  ToolModelInput,
} from '../../tools/src/contracts.ts'
import { toolSchemas } from '../../tools/src/index.ts'

export interface NativeToolExecutorOptions {
  /** Ask the user before a `mutating` tool runs. */
  approve?: (tool: ToolDefinition, call: ToolBatchInput['calls'][number]) => Promise<boolean>
}

/** Whether a thrown value reports a cancellation. */
export function isAbortFailure(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

export function failureOf(error: unknown): ToolFailure {
  if (error instanceof ToolNotFoundError) return { message: error.message, info: { name: error.name, code: error.code } }
  return { message: error instanceof Error ? error.message : String(error) }
}

/** Execute model tool calls against registered `ToolDefinition`s. */
export class NativeToolExecutor implements ToolExecutor {
  private readonly approve?: NativeToolExecutorOptions['approve']

  constructor(options: NativeToolExecutorOptions = {}) {
    this.approve = options.approve
  }

  describe(tools: readonly ToolDefinition[]): ToolModelInput {
    return { schemas: toolSchemas(tools), knownNames: tools.map((tool) => tool.name) }
  }

  async execute(input: ToolBatchInput, tools: readonly ToolDefinition[]): Promise<ToolBatchResult> {
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const results: ToolCallResult[] = []
    for (const call of input.calls) {
      results.push({ callId: call.id, result: await this.executeOne(call, byName, input) })
    }
    return { results }
  }

  private async executeOne(
    call: ToolBatchInput['calls'][number],
    byName: Map<string, ToolDefinition>,
    input: ToolBatchInput,
  ): Promise<ToolExecutionResult> {
    if (input.signal.aborted) {
      return {
        isError: true,
        content: 'The tool call was cancelled before it started.',
        summary: '已取消',
        error: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
      }
    }
    const tool = byName.get(call.name)
    if (tool === undefined) {
      const error = new ToolNotFoundError(call.name)
      return { isError: true, content: error.message, summary: '未知工具', error: failureOf(error) }
    }

    let args: Record<string, unknown>
    try {
      const parsed = JSON.parse(call.arguments === '' ? '{}' : call.arguments) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('must be an object')
      args = parsed as Record<string, unknown>
    } catch (error) {
      return {
        isError: true,
        content: `参数不是合法 JSON 对象：${error instanceof Error ? error.message : String(error)}`,
        summary: '参数错误',
        error: { name: 'ToolArgsError', code: 'INVALID_TOOL_ARGUMENTS' },
      }
    }

    if (tool.mutating === true && this.approve !== undefined) {
      const allowed = await this.approve(tool, call)
      if (!allowed) {
        return {
          isError: true,
          content: 'The user declined this tool call.',
          summary: '已拒绝',
          error: { name: APPROVAL_ERROR_NAME, code: APPROVAL_REJECTED },
        }
      }
    }

    try {
      const outcome = await tool.run(args, { cwd: input.cwd, signal: input.signal })
      // A tool body may report failure without structured error facts; supply them.
      if (outcome.isError && (outcome as ToolExecutionResult & { error?: ToolFailure }).error === undefined) {
        return { ...outcome, isError: true, error: failureOf(new Error(outcome.content)) }
      }
      return outcome as ToolExecutionResult
    } catch (error) {
      const aborted = input.signal.aborted || isAbortFailure(error)
      return {
        isError: true,
        content: aborted ? 'The tool call was cancelled.' : `工具执行失败：${error instanceof Error ? error.message : String(error)}`,
        summary: aborted ? '已取消' : '执行失败',
        error: aborted ? { name: 'AbortError', code: TOOL_ABORTED } : failureOf(error),
      }
    }
  }
}
