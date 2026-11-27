/**
 * Local tool set: shell, file read/write, exact edits, directory listing.
 * Every tool returns plain text that is fed back to the model verbatim.
 * @module @astra/tools
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { ToolSchema } from '../../../llm/llm/src/index.ts'
import { TextRetainer } from '../../../util/output-retention/src/index.ts'
import type { ToolContext, ToolDefinition, ToolModelInput, ToolResult } from './contracts.ts'
import { TERMINAL_OUTPUT_BYTES, retainText } from './presentation.ts'

export {
  APPROVAL_ERROR_NAME,
  APPROVAL_REJECTED,
  TOOL_ABORTED,
  TOOL_ABORTED_BEFORE_DISPATCH,
  ToolNotFoundError,
} from './contracts.ts'
export type {
  ApprovalErrorCode,
  ToolBatchInput,
  ToolBatchResult,
  ToolCallResult,
  ToolContext,
  ToolDefinition,
  ToolErrorInfo,
  ToolExecutionFailure,
  ToolExecutionResult,
  ToolExecutionSuccess,
  ToolExecutor,
  ToolFailure,
  ToolModelInput,
  ToolResult,
} from './contracts.ts'
export { TERMINAL_OUTPUT_BYTES, retainText } from './presentation.ts'

const MAX_FILE_BYTES = 2_000_000

let shellCache: string | boolean | undefined

/** Prefer bash when available so the agent and the user share one dialect. */
function shellOption(): string | boolean {
  if (shellCache !== undefined) return shellCache
  if (process.platform !== 'win32') {
    shellCache = true
    return shellCache
  }
  const candidates = [
    process.env.SHELL,
    process.env.BASH,
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files/Git/usr/bin/bash.exe',
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      shellCache = candidate
      return shellCache
    }
  }
  shellCache = true
  return shellCache
}

const ok = (content: string, summary: string, diff?: ToolResult['diff']): ToolResult => ({ content, isError: false, summary, ...diff ? { diff } : {} })
const fail = (content: string, summary: string): ToolResult => ({ content, isError: true, summary })

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`参数 ${key} 必须是非空字符串`)
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function resolveToolPath(input: string, ctx: ToolContext): string {
  let p = input.trim()
  if (p === '~') p = process.env.USERPROFILE ?? process.env.HOME ?? p
  else if (p.startsWith('~/') || p.startsWith('~\\')) {
    p = join(process.env.USERPROFILE ?? process.env.HOME ?? '', p.slice(2))
  }
  return resolve(ctx.cwd, p)
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Run a shell command, capturing output until it exits or is cancelled. */
async function runTerminal(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = requireString(args, 'command')
  const cwd = optionalString(args, 'cwd') ? resolveToolPath(optionalString(args, 'cwd') as string, ctx) : ctx.cwd
  const requested = optionalNumber(args, 'timeout_ms') ?? 120_000
  const timeout = Math.min(Math.max(requested, 1_000), 600_000)

  if (!existsSync(cwd)) return fail(`目录不存在：${cwd}`, '目录不存在')

  // Each stream keeps a byte-bounded head and tail while the process runs, so a
  // chatty command cannot grow memory without limit.
  const out = new TextRetainer({ kind: 'headTail', headBytes: 32_768, tailBytes: 8_192 })
  const err = new TextRetainer({ kind: 'headTail', headBytes: 32_768, tailBytes: 8_192 })
  let exitCode: number | null = null
  let spawnError: string | undefined
  let timedOut = false

  const child = spawn(command, {
    cwd,
    shell: shellOption(),
    windowsHide: true,
    env: {
      ...process.env,
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
      NO_COLOR: process.env.NO_COLOR ?? '',
    },
  })

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => out.push(chunk))
  child.stderr?.on('data', (chunk: string) => err.push(chunk))

  const kill = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 1_500).unref()
  }

  const onAbort = (): void => kill()
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, timeout)

  await new Promise<void>((done) => {
    child.on('error', (error) => {
      spawnError = error.message
      done()
    })
    child.on('close', (code) => {
      exitCode = code
      done()
    })
  })

  clearTimeout(timer)
  ctx.signal.removeEventListener('abort', onAbort)

  if (spawnError) return fail(`无法启动命令：${spawnError}`, '启动失败')

  const stdout = out.finish()
  const stderr = err.finish()
  const parts: string[] = []
  parts.push(`exit code: ${exitCode ?? 'null'}${timedOut ? `（超时 ${timeout} ms 后终止）` : ''}`)
  if (ctx.signal.aborted) parts.push('（用户取消了这次调用）')
  parts.push(`cwd: ${cwd}`)
  parts.push('--- stdout ---')
  parts.push(stdout.text.trim() === '' ? '（无输出）' : retainText(stdout.text.replace(/\s+$/, ''), TERMINAL_OUTPUT_BYTES, '需要中间内容时请缩小命令输出范围或重定向到文件后再分段读取。'))
  if (stderr.text.trim() !== '') {
    parts.push('--- stderr ---')
    parts.push(retainText(stderr.text.replace(/\s+$/, ''), TERMINAL_OUTPUT_BYTES, '需要中间内容时请缩小命令输出范围或重定向到文件后再分段读取。'))
  }

  const firstLine = (stdout.text.trim().split(/\r?\n/)[0] ?? '').slice(0, 60)
  const label = `exit ${exitCode ?? 'null'}${timedOut ? ' · 超时' : ''}`
  return {
    isError: exitCode !== 0 || timedOut,
    content: parts.join('\n'),
    summary: firstLine === '' ? label : `${label} · ${firstLine}`,
  }
}

/** Read a UTF-8 text file with line numbers. */
async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = resolveToolPath(requireString(args, 'path'), ctx)
  if (!existsSync(path)) return fail(`文件不存在：${path}`, '文件不存在')
  const stat = statSync(path)
  if (stat.isDirectory()) return fail(`${path} 是目录，请用 list_dir`, '是目录')
  if (stat.size > MAX_FILE_BYTES) {
    return fail(`文件过大（${humanSize(stat.size)}），请用 run_terminal 分段读取`, '文件过大')
  }
  const buffer = readFileSync(path)
  if (buffer.includes(0)) return fail(`${path} 看起来是二进制文件（${humanSize(stat.size)}）`, '二进制文件')
  const text = buffer.toString('utf8').replace(/\r?\n$/, '')
  const lines = text.split(/\r?\n/)
  const offset = Math.max(0, (optionalNumber(args, 'offset') ?? 1) - 1)
  const limit = Math.max(1, optionalNumber(args, 'limit') ?? 2_000)
  const slice = lines.slice(offset, offset + limit)
  if (slice.length === 0) return ok(`（第 ${offset + 1} 行之后没有内容，共 ${lines.length} 行）`, '空范围')
  const numbered = slice
    .map((line, index) => `${String(offset + index + 1).padStart(6, ' ')}  ${line}`)
    .join('\n')
  const truncated = offset + slice.length < lines.length
  const header = `${path}（共 ${lines.length} 行${truncated ? `，已截断到第 ${offset + slice.length} 行` : ''}）`
  return ok(`${header}\n${numbered}`, `${slice.length} 行`)
}

/** Create or overwrite a file, making parent directories as needed. */
async function writeFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = resolveToolPath(requireString(args, 'path'), ctx)
  const content = typeof args.content === 'string' ? args.content : undefined
  if (content === undefined) return fail('参数 content 必须是字符串', '缺少内容')
  mkdirSync(dirname(path), { recursive: true })
  const existed = existsSync(path)
  const before = existed && statSync(path).size <= MAX_FILE_BYTES ? readFileSync(path, 'utf8') : ''
  writeFileSync(path, content, 'utf8')
  const bytes = Buffer.byteLength(content, 'utf8')
  const lines = content === '' ? 0 : content.replace(/\r?\n$/, '').split(/\r?\n/).length
  return ok(
    `${existed ? '已覆盖' : '已创建'} ${path}（${bytes} 字节，${lines} 行）`,
    `${existed ? '覆盖' : '创建'} ${path} · ${lines} 行`,
    { before, after: content },
  )
}

/** Replace one exact occurrence (or all) of a snippet. */
async function editFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = resolveToolPath(requireString(args, 'path'), ctx)
  const oldString = requireString(args, 'old_string')
  const newString = typeof args.new_string === 'string' ? args.new_string : undefined
  if (newString === undefined) return fail('参数 new_string 必须是字符串', '缺少内容')
  if (!existsSync(path)) return fail(`文件不存在：${path}`, '文件不存在')

  const text = readFileSync(path, 'utf8')
  const count = text.split(oldString).length - 1
  if (count === 0) return fail('没有找到要替换的内容。请先用 read_file 确认原文（注意缩进与换行）。', '未匹配')
  const replaceAll = args.replace_all === true
  if (count > 1 && !replaceAll) {
    return fail(`该片段出现 ${count} 次，请提供更长的上下文，或设置 replace_all: true。`, `${count} 处匹配`)
  }
  const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString)
  writeFileSync(path, next, 'utf8')
  return ok(`已修改 ${path}（替换 ${replaceAll ? count : 1} 处）`, `修改 ${path} · ${replaceAll ? count : 1} 处`, { before: text, after: next })
}

/** List one directory. */
async function listDir(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = resolveToolPath(optionalString(args, 'path') ?? '.', ctx)
  if (!existsSync(path)) return fail(`目录不存在：${path}`, '目录不存在')
  if (!statSync(path).isDirectory()) return fail(`${path} 不是目录`, '不是目录')

  const entries = readdirSync(path, { withFileTypes: true })
    .map((entry) => {
      if (entry.isDirectory()) return { name: `${entry.name}/`, size: -1 }
      try {
        return { name: entry.name, size: statSync(join(path, entry.name)).size }
      } catch {
        return { name: entry.name, size: 0 }
      }
    })
    .sort((a, b) => {
      const aDir = a.size < 0 ? 0 : 1
      const bDir = b.size < 0 ? 0 : 1
      return aDir - bDir || a.name.localeCompare(b.name)
    })

  const limit = 300
  const shown = entries.slice(0, limit)
  const lines = shown.map((entry) => (entry.size < 0 ? entry.name : `${entry.name}  ${humanSize(entry.size)}`))
  if (entries.length > limit) lines.push(`… 还有 ${entries.length - limit} 项`)
  return ok(`${path}\n${lines.join('\n') || '（空目录）'}`, `${entries.length} 项`)
}

/** The default tool set advertised to the model. */
export function createTools(): ToolDefinition[] {
  return [
    {
      name: 'run_terminal',
      description:
        'Run a shell command in the working directory and return stdout, stderr and the exit code. ' +
        'Use it to inspect the repository, run tests or builds. GNU bash syntax on Windows.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The full command line to execute.' },
          cwd: { type: 'string', description: 'Optional working directory; defaults to the session cwd.' },
          timeout_ms: { type: 'number', description: 'Timeout in milliseconds. Default 120000, max 600000.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
      mutating: true,
      run: runTerminal,
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file and return it with line numbers. Use offset/limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, absolute or relative to the session cwd.' },
          offset: { type: 'number', description: '1-based first line to read. Default 1.' },
          limit: { type: 'number', description: 'Maximum number of lines. Default 2000.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      run: readFile,
    },
    {
      name: 'write_file',
      description: 'Create or fully overwrite a UTF-8 text file. Prefer edit_file for small changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, absolute or relative to the session cwd.' },
          content: { type: 'string', description: 'Complete file content.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      mutating: true,
      run: writeFile,
    },
    {
      name: 'edit_file',
      description:
        'Replace an exact snippet in a file. old_string must match the file byte for byte, ' +
        'including indentation. Fails when the snippet is missing or ambiguous.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          old_string: { type: 'string', description: 'Exact text to replace.' },
          new_string: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
        },
        required: ['path', 'old_string', 'new_string'],
        additionalProperties: false,
      },
      mutating: true,
      run: editFile,
    },
    {
      name: 'list_dir',
      description: 'List one directory, directories first.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path. Defaults to the session cwd.' },
        },
        additionalProperties: false,
      },
      run: listDir,
    },
  ]
}

/** Convert tool definitions into the wire schemas sent to the API. */
export function toolSchemas(tools: readonly ToolDefinition[]): ToolSchema[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}
