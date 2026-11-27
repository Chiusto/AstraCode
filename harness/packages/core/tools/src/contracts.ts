/**
 * Tool contracts shared by tool definitions and executors.
 * Port of `packages/core/tools/src/contracts.ts` and `executor.ts` with text
 * content in place of content blocks.
 * @module @astra/tools/contracts
 */

import type { ToolCall, ToolSchema } from '../../../llm/llm/src/index.ts'

/** The completed outcome of one tool body. */
export interface ToolResult {
  /** The model-facing content (or the rendered error text on failure). */
  content: string
  isError: boolean
  /** One-line rendering for the terminal. */
  summary: string
  /** Set by file-mutating tools so the terminal can render a diff. */
  diff?: { before: string; after: string }
}

/** What a tool body needs from its caller. */
export interface ToolContext {
  /** Default directory for relative paths and shell commands. */
  cwd: string
  signal: AbortSignal
}

/** A tool the model can call. */
export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>
  /** Requires confirmation unless the session auto-approves. */
  mutating?: boolean
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}

/** Canonical error code for cancellation after a tool body was invoked. */
export const TOOL_ABORTED = 'ABORTED'

/** Canonical error code for cancellation before a tool body was invoked. */
export const TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH'

export const APPROVAL_ERROR_NAME = 'ApprovalError'
export const APPROVAL_REJECTED = 'APPROVAL_REJECTED'
export type ApprovalErrorCode = typeof APPROVAL_REJECTED

/** Structured error metadata for a failed tool call. */
export interface ToolErrorInfo {
  name: string
  code: string
}

/** Canonical failure detail of one tool call. */
export interface ToolFailure {
  /** Human-readable failure message without the Native `Error: ` envelope. */
  message: string
  info?: ToolErrorInfo
}

/** Thrown when the model requests a tool that isn't registered. */
export class ToolNotFoundError extends Error {
  readonly code = 'UNKNOWN_TOOL'
  constructor(toolName: string) {
    super(`unknown tool "${toolName}"`)
    this.name = 'ToolNotFoundError'
  }
}

/** Successful tool execution. */
export interface ToolExecutionSuccess extends ToolResult {
  readonly isError: false
  readonly error?: never
}

/** Failed tool execution; failures never carry a successful value. */
export interface ToolExecutionFailure extends ToolResult {
  readonly isError: true
  readonly error: ToolFailure
}

/** The discriminated outcome of one tool call. */
export type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure

/** Raw model calls with their cancellation. */
export interface ToolBatchInput {
  readonly calls: readonly ToolCall[]
  readonly signal: AbortSignal
  readonly cwd: string
}

/** One settled result correlated with its original model call. */
export interface ToolCallResult {
  readonly callId: string
  readonly result: ToolExecutionResult
}

/** Model-ordered outcomes of one batch, one per input call in input order. */
export interface ToolBatchResult {
  readonly results: readonly ToolCallResult[]
}

/** Schemas and names of the model's callable tools. */
export interface ToolModelInput {
  readonly schemas: readonly ToolSchema[]
  readonly knownNames: readonly string[]
}

/** A component that owns argument parsing, dispatch, approval and cancellation. */
export interface ToolExecutor {
  describe(tools: readonly ToolDefinition[]): ToolModelInput
  execute(input: ToolBatchInput, tools: readonly ToolDefinition[]): Promise<ToolBatchResult>
}
