#!/usr/bin/env node
/**
 * Astra CLI entry point: flag parsing, composition root, and the one-shot path.
 *
 *   node harness/cli/index.ts                 # interactive chat
 *   node harness/cli/index.ts -p "问题"        # one-shot answer
 *   node harness/cli/index.ts --session <id>  # resume
 *
 * @module @astra/cli
 */

import { createAgent, runExclusive } from '../packages/core/agent/src/index.ts'
import { runTurn } from '../packages/core/agent-loop/src/index.ts'
import { createSession, listSessions, resumeSession } from '../packages/core/session/src/index.ts'
import type { Session } from '../packages/core/session/src/index.ts'
import { NativeToolExecutor } from '../packages/core/tool-executor-native/src/index.ts'
import { createTools } from '../packages/core/tools/src/index.ts'
import { resolveRetryPolicy } from '../packages/llm/llm/src/index.ts'
import type { Llm } from '../packages/llm/llm/src/index.ts'
import { DeepSeekAdapter } from '../packages/llm/llm-deepseek/src/index.ts'
import { TokenMeter } from '../packages/llm/token-meter/src/index.ts'
import { BasicCompactionEngine } from '../packages/compaction/compaction-basic/src/index.ts'
import { ToolResultPruner } from '../packages/compaction/compaction-tool-result-pruner/src/index.ts'
import { REPO_ROOT, VERSION, parseArgs, resolveConfig } from './src/config.ts'
import type { CliConfig } from './src/config.ts'
import { ModelStore, applyModel } from './src/models.ts'
import { createSystemPrompt } from './src/prompt.ts'
import { createTheme, printError } from './src/render.ts'
import { startRepl } from './src/repl.ts'
import type { AppState } from './src/repl.ts'

const HELP = `Astra CLI — 终端里的对话式编程助手

用法
  node harness/cli/index.ts                    交互式对话
  node harness/cli/index.ts -p "解释目录结构"    单次问答后退出
  node harness/cli/index.ts --session <id>     恢复历史会话

选项
  -p, --print <text>     单次问答，回答写到 stdout
  -m, --model <id>       模型 id，默认 deepseek-chat
  -C, --cwd <dir>        工作目录，默认当前目录
      --session <id>     恢复历史会话（id 或前缀）
      --system <text>    追加到系统提示词
      --max-tokens <n>   单次回复上限，默认 8192
      --max-steps <n>    单轮工具调用步数上限，默认 24
  -y, --yes              自动执行所有工具（写文件、跑命令不再询问）
      --ask              每次写操作都询问（交互模式默认如此）
      --no-color         关闭颜色
      --repl             强制进入交互界面（即使 stdin 不是终端）
  -h, --help             显示帮助
  -v, --version          显示版本

环境变量
  DEEPSEEK_API_KEY          必填；也可写在 AstraCode/.env
  DEEPSEEK_BASE_URL         默认 https://api.deepseek.com
  ASTRA_AGENT_MODEL         默认 deepseek-chat
  ASTRA_SESSION_DIR         默认 harness/cli/sessions
  ASTRA_CONTEXT_WINDOW      模型上下文容量，默认 131072
  ASTRA_AUTO_COMPACT        设为 0 关闭自动压缩
  ASTRA_TIME_CONTEXT        设为 0 关闭每步的时间提示

交互
  直接输入内容即可对话；/help 查看命令；/compact 手动压缩历史；
  Ctrl+C 中断本轮，提示符下再按一次退出。
`

/** One provider name for every route this shell builds. */
function createLlm(config: CliConfig): Llm {
  return new DeepSeekAdapter({
    connection: {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      contextWindow: config.contextWindow,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    },
    retryPolicy: resolveRetryPolicy({ mode: 'normal' }, 'astra.llm.retryPolicy'),
  })
}

function createCompaction(config: CliConfig, llm: Llm, notice: (text: string) => void): BasicCompactionEngine {
  return new BasicCompactionEngine({
    llm,
    tokenMeter: new TokenMeter(),
    toolResultPruner: new ToolResultPruner(),
    config: {
      thresholdRatio: config.compactThresholdRatio,
      headroomTokens: config.compactHeadroomTokens,
      retainRatio: config.compactRetainRatio,
      maxTokens: config.compactMaxTokens,
      auto: config.autoCompact,
    },
    onCompaction: (result, trigger) => {
      if (trigger === 'manual') return
      notice(`已压缩 ${result.shadowedSeqs.length} 条历史（约 ${result.shadowedTokenCount} tokens，${trigger}）`)
    },
  })
}

/** Read a one-shot prompt from the remaining stdin. */
async function readStdin(): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of process.stdin) chunks.push(String(chunk))
  return chunks.join('').trim()
}

/** Explain how to supply a key, used by the headless path. */
function missingKeyMessage(config: CliConfig): string {
  return (
    `模型 ${config.alias || config.model}（${config.baseUrl}）没有可用的 API Key。\n` +
    '  1. 交互模式里执行 /key 设置，或 /model add 新建一个带密钥的模型；\n' +
    `  2. 在 ${REPO_ROOT}\\.env 写 DEEPSEEK_API_KEY=sk-... ，并把条目设为 env:DEEPSEEK_API_KEY。\n`
  )
}

/** Non-interactive run: answer on stdout, progress on stderr. */
async function runOnce(state: AppState, input: string): Promise<number> {
  const theme = createTheme(false)
  const started = Date.now()
  const llm = state.createLlm()
  const compaction = state.createCompaction(llm, (text) => process.stderr.write(`[compact] ${text}\n`))
  const executor = new NativeToolExecutor({ approve: async () => true })
  let answer = ''

  try {
    const result = await runExclusive(state.agent, () => runTurn(
      state.agent,
      { text: input, signal: new AbortController().signal },
      {
        llm,
        tools: state.tools,
        executor,
        systemPrompt: createSystemPrompt(state.config, state.tools),
        selection: { provider: llm.provider, model: state.config.model },
        maxSteps: state.config.maxSteps,
        maxTokens: state.config.maxTokens,
        temperature: state.config.temperature,
        compaction: state.config.autoCompact ? compaction : undefined,
        timeContext: state.config.timeContext ? {} : false,
      },
      {
        onText: (chunk) => {
          answer += chunk
          process.stdout.write(chunk)
        },
        onReasoning: () => {},
        onToolCall: (call) => {
          const preview = call.arguments.replace(/\s+/g, ' ').slice(0, 120)
          process.stderr.write(`[tool] ${call.name} ${preview}\n`)
        },
        onToolResult: (_call, result_) => {
          process.stderr.write(`[tool] ${result_.isError ? 'failed' : 'ok'} · ${result_.summary}\n`)
        },
        onNotice: (text) => process.stderr.write(`[note] ${text}\n`),
      },
    ))
    if (answer.length === 0) process.stdout.write('（模型没有返回内容）\n')
    process.stdout.write('\n')
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    process.stderr.write(
      `[done] ${seconds}s · ↑${result.usage.inputTokens} ↓${result.usage.outputTokens}` +
        ` · session ${state.session.id}\n`,
    )
    return 0
  } catch (error) {
    printError(theme, error instanceof Error ? error.message : String(error))
    return 1
  }
}

async function main(): Promise<void> {
  let flags
  try {
    flags = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`)
    process.exit(2)
  }

  if (flags.help) {
    process.stdout.write(HELP)
    return
  }
  if (flags.version) {
    process.stdout.write(`${VERSION}\n`)
    return
  }

  const config = resolveConfig(flags)
  const store = ModelStore.load(config.modelsPath, { baseUrl: config.baseUrl, model: config.model })
  if (store.loadWarning) process.stderr.write(`${store.loadWarning}\n`)

  const tools = createTools()

  let session: Session | undefined
  let target: string | undefined
  if (flags.session) {
    const resumed = resumeSession(config.sessionDir, flags.session, config.cwd)
    if (!resumed) {
      process.stderr.write(`找不到会话 ${flags.session}。\n`)
      const recent = listSessions(config.sessionDir).slice(0, 5)
      if (recent.length > 0) {
        process.stderr.write(`最近的会话：\n${recent.map((item) => `  ${item.id}`).join('\n')}\n`)
      }
      process.exit(1)
    }
    session = resumed
    config.cwd = resumed.cwd
    target = flags.model ?? (resumed.alias === '' ? undefined : resumed.alias)
  } else if (config.modelSource !== 'default') {
    // An explicit flag or ASTRA_AGENT_MODEL wins over the stored default alias.
    target = config.model
  }

  applyModel(config, store, target)

  const initialSession = session ?? createSession(config.sessionDir, { alias: config.alias, cwd: config.cwd })
  const state: AppState = {
    config,
    store,
    tools,
    theme: createTheme(config.color),
    session: initialSession,
    agent: createAgent(initialSession),
    createLlm: () => createLlm(config),
    createCompaction: (llm, notice) => createCompaction(config, llm, notice),
  }
  if (config.alias !== '' && initialSession.alias !== config.alias) {
    initialSession.selectModel(config.alias, state.createLlm().provider, config.model)
  }

  const headless = !flags.repl && (flags.prompt !== undefined || process.stdin.isTTY !== true)
  if (headless) {
    if (config.apiKey === '') {
      process.stderr.write(missingKeyMessage(config))
      process.exit(1)
    }
    const input = flags.prompt ?? (await readStdin())
    if (input.trim() === '') {
      process.stderr.write('没有输入内容。用法：node harness/cli/index.ts -p "你的问题"\n')
      process.exit(2)
    }
    process.exitCode = await runOnce(state, input)
    return
  }

  if (config.apiKey === '') process.stderr.write(missingKeyMessage(config))
  startRepl(state)
}

void main().catch((error: unknown) => {
  process.stderr.write(`启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
