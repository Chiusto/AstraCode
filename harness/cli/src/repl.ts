/**
 * Interactive terminal UI: prompt, streaming output, tool blocks, slash commands.
 * Input is serialized through one promise chain so a turn, a command and a
 * queued line never interleave.
 * @module @astra/cli/repl
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as readline from 'node:readline'
import { createAgent, runExclusive } from '../../packages/core/agent/src/index.ts'
import type { Agent } from '../../packages/core/agent/src/index.ts'
import { runTurn } from '../../packages/core/agent-loop/src/index.ts'
import type { TurnHooks } from '../../packages/core/agent-loop/src/index.ts'
import { createSession, listSessions, resumeSession as loadSession } from '../../packages/core/session/src/index.ts'
import type { Session } from '../../packages/core/session/src/index.ts'
import { NativeToolExecutor } from '../../packages/core/tool-executor-native/src/index.ts'
import type { ToolDefinition } from '../../packages/core/tools/src/index.ts'
import type { Llm } from '../../packages/llm/llm/src/index.ts'
import { requestModelListing } from '../../packages/llm/llm-deepseek/src/index.ts'
import type { BasicCompactionEngine } from '../../packages/compaction/compaction-basic/src/index.ts'
import { executeCompact } from '../../packages/compaction/command-compact/src/index.ts'
import { resolvePath, VERSION } from './config.ts'
import type { CliConfig } from './config.ts'
import { applyModel, maskKey } from './models.ts'
import type { ModelStore } from './models.ts'
import { createSystemPrompt } from './prompt.ts'
import { readSecret } from './secret.ts'
import {
  BULLET,
  clipLine,
  columns,
  contextLeft,
  composerPrompt,
  displayWidth,
  MessageWriter,
  printError,
  printFooter,
  printHeader,
  printHelp,
  printInterrupt,
  printNotice,
  printToolCall,
  printToolResult,
  printUsage,
} from './render.ts'
import type { Theme } from './render.ts'
import { selectOption } from './select.ts'
import type { SelectItem } from './select.ts'
import { Waiting } from './waiting.ts'

export interface AppState {
  config: CliConfig
  /** Editable alias / endpoint / key registry. */
  store: ModelStore
  tools: ToolDefinition[]
  theme: Theme
  session: Session
  agent: Agent
  /** Builds the provider adapter for the current config entry. */
  createLlm: () => Llm
  /** Builds the compaction engine bound to one adapter. */
  createCompaction: (llm: Llm, notice: (text: string) => void) => BasicCompactionEngine
}

/** Short, human-readable preview of a tool call's arguments. */
function previewOf(name: string, raw: string): string {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(raw === '' ? '{}' : raw) as Record<string, unknown>
  } catch {
    return clipLine(raw, 80)
  }
  const text = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '')
  switch (name) {
    case 'run_terminal':
      return text('command')
    case 'write_file':
      return `${text('path')} · ${Buffer.byteLength(text('content'), 'utf8')} B`
    case 'edit_file':
      return text('path')
    default:
      return text('path') || clipLine(raw, 80)
  }
}

/** 斜杠命令菜单：键入 `/` 即弹出，输入即筛选。 */
const COMMAND_MENU: SelectItem[] = [
  { label: '/model', hint: '选择模型（切换 / 添加 / 手动输入）', value: '/model' },
  { label: '/model add', hint: '新增模型：别名 → model id → 地址 → 密钥', value: '/model add' },
  { label: '/model remove', hint: '删除某个模型配置', value: '/model remove' },
  { label: '/model remote', hint: '查询服务端可用模型', value: '/model remote' },
  { label: '/key', hint: '设置某个模型的 API Key', value: '/key' },
  { label: '/cd', hint: '切换工作目录', value: '/cd' },
  { label: '/compact', hint: '把较早的历史压缩成摘要', value: '/compact' },
  { label: '/resume', hint: '恢复某个历史会话', value: '/resume' },
  { label: '/new', hint: '开新会话', value: '/new' },
  { label: '/sessions', hint: '历史会话列表', value: '/sessions' },
  { label: '/session', hint: '当前会话信息', value: '/session' },
  { label: '/tools', hint: '查看工具', value: '/tools' },
  { label: '/usage', hint: '本会话 token 用量', value: '/usage' },
  { label: '/help', hint: '完整帮助', value: '/help' },
  { label: '/exit', hint: '退出（等同 Ctrl+D）', value: '/exit' },
]

/** Skip dirs in the directory picker. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.workbuddy', 'dist', 'build', '.venv', '__pycache__'])

/** Dim text shown in the empty composer. */
const PLACEHOLDER = '问问 Astra，或描述一个任务'

/** Mount the interactive loop. Returns as soon as the interface is created. */
export function startRepl(state: AppState): void {
  const theme = state.theme
  const waiting = new Waiting(theme)
  let llm = state.createLlm()
  let compaction = state.createCompaction(llm, (text) => printNotice(theme, text))
  let systemPrompt = createSystemPrompt(state.config, state.tools)
  const historyFile = join(state.config.sessionDir, '.history')
  const commands = COMMAND_MENU.map((item) => item.value)
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
    history: loadHistory(historyFile),
    historySize: 300,
    completer: (line: string) => {
      if (!line.startsWith('/')) return [[], line]
      const hits = commands.filter((command) => command.startsWith(line))
      return [hits.length > 0 ? hits : commands, line]
    },
  })

  let busy = false
  let menuOpen = false
  let usedTokens = 0
  let closed = false
  let farewelled = false
  let abort: AbortController | null = null
  let chain: Promise<void> = Promise.resolve()
  let pending: string[] = []
  let pendingTimer: NodeJS.Timeout | undefined

  /** Empty composer shows a dim placeholder, with the cursor parked before it. */
  const promptText = (): string =>
    rl.line === '' ? composerPrompt(theme, PLACEHOLDER) : theme.accent('› ')

  /** Redraw the composer; on an empty line park the cursor in front of the placeholder. */
  const drawPrompt = (preserve: boolean): void => {
    rl.setPrompt(promptText())
    rl.prompt(preserve)
    if (rl.line === '') process.stdout.write(`\u001B[${displayWidth(PLACEHOLDER)}D`)
  }

  const showPrompt = (): void => {
    if (busy || closed || !process.stdin.isTTY) return
    showFooter()
    drawPrompt(false)
  }

  /** Model, directory and key hints kept above the composer; readline cannot own a line below it. */
  const showFooter = (): void => {
    if (!process.stdin.isTTY) return
    printFooter(theme, {
      model: state.config.model,
      cwd: state.session.cwd,
      hint: '? 查看命令',
      right: contextLeft(usedTokens, state.config.contextWindow),
    })
  }

  const farewell = (): void => {
    if (farewelled) return
    farewelled = true
    process.stdout.write(theme.gray(`\n会话已保存：${state.session.path}\n`))
    process.stdout.write(theme.gray(`恢复：node harness/cli/index.ts --session ${state.session.id}\n\n`))
    saveHistory(historyFile, rl.history)
    // Give stdout a tick to flush before the process leaves.
    setTimeout(() => process.exit(0), 30)
  }

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()))
    })

  const approve = async (name: string, raw: string): Promise<boolean> => {
    if (!process.stdin.isTTY) return true
    // The interface is gone (Ctrl+D mid-turn): do not block on a question.
    if (closed) return false
    process.stdout.write(
      `\n  ${theme.green(BULLET)} ${theme.bold('需要确认')} ${theme.cyan(name)} ${theme.gray(clipLine(previewOf(name, raw), columns() - 20))}\n`,
    )
    const answer = (
      await ask(`  ${theme.gray('›')} ${theme.bold('允许执行？')} ${theme.gray('[y/N/a=全部允许]')} `)
    ).toLowerCase()
    if (answer === 'a' || answer === 'all') {
      state.config.autoApprove = true
      printNotice(theme, '本会话剩余工具调用将自动执行')
      return true
    }
    return answer === 'y' || answer === 'yes'
  }

  /** Rebuild the adapter, engine and prompt after a model or key change. */
  const rebuild = (): void => {
    llm = state.createLlm()
    compaction = state.createCompaction(llm, (text) => printNotice(theme, text))
    systemPrompt = createSystemPrompt(state.config, state.tools)
  }

  const executor = new NativeToolExecutor({ approve: (tool, call) => approve(tool.name, call.arguments) })

  const hooks: TurnHooks = {
    onThinking: () => waiting.start('思考中'),
    onText: (chunk) => {
      waiting.stop()
      process.stdout.write(chunk)
    },
    onReasoning: (chunk) => {
      waiting.stop()
      process.stdout.write(theme.gray(chunk))
    },
    onToolCall: (call) => {
      waiting.stop()
      printToolCall(theme, call.name, previewOf(call.name, call.arguments))
      waiting.start('执行工具')
    },
    onToolResult: (_call, result) => {
      waiting.stop()
      printToolResult(theme, {
        ok: !result.isError,
        summary: result.summary,
        content: result.content,
        diff: result.diff,
      })
    },
    onNotice: (text) => {
      waiting.stop()
      printNotice(theme, text)
    },
  }

  const runInput = async (input: string): Promise<void> => {
    busy = true
    const controller = new AbortController()
    abort = controller
    const message = new MessageWriter(theme)
    let partial = ''
    const feed = (chunk: string): void => {
      partial += chunk
      let at = partial.indexOf('\n')
      while (at >= 0) {
        message.write(partial.slice(0, at))
        partial = partial.slice(at + 1)
        at = partial.indexOf('\n')
      }
    }
    try {
      if (state.config.apiKey === '') {
        printError(theme, '尚未配置 API Key：用 /key 设置，或 /model add 新建一个带密钥的模型')
        return
      }
      const result = await runExclusive(state.agent, () => runTurn(
        state.agent,
        { text: input, signal: controller.signal },
        {
          llm,
          tools: state.tools,
          executor,
          systemPrompt,
          selection: { provider: llm.provider, model: state.config.model },
          maxSteps: state.config.maxSteps,
          maxTokens: state.config.maxTokens,
          temperature: state.config.temperature,
          compaction: state.config.autoCompact ? compaction : undefined,
          timeContext: state.config.timeContext ? {} : false,
        },
        {
          ...hooks,
          onText: (chunk) => {
            waiting.stop()
            feed(chunk)
          },
        },
      ))
      if (partial !== '') feed('\n')
      usedTokens = result.usage.inputTokens + result.usage.outputTokens
      if (result.aborted) {
        printInterrupt(theme, '已中断本轮')
      } else if (usedTokens > 0) {
        printUsage(theme, { seconds: result.seconds })
      }
    } catch (error) {
      if (partial !== '') feed('\n')
      printError(theme, error instanceof Error ? error.message : String(error))
    } finally {
      waiting.stop()
      busy = false
      abort = null
      process.stdout.write('\n')
      showPrompt()
    }
  }

  /** Host part of an endpoint, for compact listings. */
  const hostOf = (baseUrl: string): string => {
    try {
      return new URL(baseUrl).host
    } catch {
      return baseUrl
    }
  }

  const listConfigured = (): void => {
    process.stdout.write('\n')
    for (const entry of state.store.entries) {
      const mark = entry.alias === state.config.alias ? theme.cyan('●') : '○'
      process.stdout.write(
        `  ${mark} ${theme.bold(entry.alias.padEnd(18))} ${theme.gray(entry.model.padEnd(22))} ` +
          `${hostOf(entry.baseUrl).padEnd(26)} ${theme.gray(state.store.keySource(entry))}\n`,
      )
    }
    if (state.config.alias !== '' && !state.store.find(state.config.alias)) {
      process.stdout.write(
        `  ${theme.cyan('●')} ${theme.bold(state.config.alias.padEnd(18))} ${theme.gray(state.config.model.padEnd(22))} ` +
          `${hostOf(state.config.baseUrl).padEnd(26)} ${theme.gray('临时（未保存）')}\n`,
      )
    }
    process.stdout.write('\n')
    printNotice(theme, `配置文件 ${state.store.path}`)
    printNotice(theme, '用法：/model <别名> · /model add · /model remove <别名> · /model remote · /key [别名]')
  }

  const switchModel = (target: string): void => {
    const applied = applyModel(state.config, state.store, target)
    if (state.store.find(applied.alias)) state.store.setDefault(applied.alias)
    rebuild()
    state.session.selectModel(applied.alias, llm.provider, state.config.model)
    printNotice(
      theme,
      `已切换 ${theme.bold(applied.alias)} → ${state.config.model} @ ${hostOf(state.config.baseUrl)} · 密钥 ${applied.keySource}`,
    )
    if (state.config.apiKey === '') printError(theme, '没有可用密钥，请用 /key 配置')
  }

  /** Pick a configured alias; undefined when the list is empty or cancelled. */
  const pickAlias = async (title: string, exclude?: string): Promise<string | undefined> => {
    const items: SelectItem[] = state.store.entries
      .filter((entry) => entry.alias !== exclude)
      .map((entry) => ({
        label: entry.alias,
        hint: `${entry.model} @ ${hostOf(entry.baseUrl)} · ${state.store.keySource(entry)}`,
        value: entry.alias,
      }))
    if (items.length === 0) return undefined
    return selectOption({
      rl,
      theme,
      title,
      items,
      footer: `当前 ${state.config.alias || state.config.model}`,
      filterable: true,
    })
  }

  const pickModel = async (): Promise<void> => {
    const items: SelectItem[] = state.store.entries.map((entry) => ({
      label: entry.alias === state.config.alias ? `${entry.alias}（当前）` : entry.alias,
      hint: `${entry.model} @ ${hostOf(entry.baseUrl)} · ${state.store.keySource(entry)}`,
      value: entry.alias,
    }))
    items.push({ label: '＋ 添加模型…', hint: '别名 / model id / 地址 / 密钥', value: '__add__' })
    items.push({ label: '－ 删除模型…', hint: '从 models.json 移除一项', value: '__remove__' })
    items.push({ label: '⌨  手动输入 model id', hint: '临时使用，不写入配置', value: '__manual__' })
    const picked = await selectOption({ rl, theme, title: '选择模型', items, filterable: true })
    if (picked === undefined) {
      printNotice(theme, '已取消')
      return
    }
    if (picked === '__add__') {
      await addModel()
      return
    }
    if (picked === '__remove__') {
      const alias = await pickAlias('删除哪个模型？', state.config.alias)
      if (alias === undefined) printNotice(theme, '已取消')
      else removeModel(alias)
      return
    }
    if (picked === '__manual__') {
      const id = await ask('  model id: ')
      if (id !== '') switchModel(id)
      return
    }
    switchModel(picked)
  }

  const pickSession = async (): Promise<void> => {
    const sessions = listSessions(state.config.sessionDir).slice(0, 20)
    if (sessions.length === 0) {
      printNotice(theme, '还没有历史会话')
      return
    }
    const items: SelectItem[] = sessions.map((item) => ({
      label: item.id === state.session.id ? `${item.id}（当前）` : item.id,
      hint: `${item.updated.toLocaleString('zh-CN', { hour12: false })} · ${item.alias || '未记录模型'} · ${item.messages} 条`,
      value: item.id,
    }))
    const picked = await selectOption({ rl, theme, title: '恢复会话', items, filterable: true })
    if (picked === undefined) {
      printNotice(theme, '已取消')
      return
    }
    resumeSession(picked)
  }

  const pickCommand = async (): Promise<string | undefined> =>
    selectOption({
      rl,
      theme,
      title: '命令',
      items: COMMAND_MENU,
      filterable: true,
      // 输入行由菜单接管：`› /` 钉在原位，筛选词就地增长，菜单只在下面展开。
      prompt: (text) => `${theme.accent('› ')}${text}`,
    })

  const resumeSession = (target: string): void => {
    const resumed = loadSession(state.config.sessionDir, target, state.session.cwd)
    if (!resumed) {
      printError(theme, `找不到会话 ${target}`)
      return
    }
    state.session = resumed
    state.agent = createAgent(state.session)
    state.config.cwd = resumed.cwd
    if (resumed.alias !== '') applyModel(state.config, state.store, resumed.alias)
    rebuild()
    printNotice(theme, `已恢复 ${resumed.id}（${resumed.messageCount} 条消息）`)
  }

  const changeDir = (target: string): void => {
    const next = resolvePath(target, state.session.cwd)
    if (!existsSync(next) || !statSync(next).isDirectory()) {
      printError(theme, `不是有效目录：${next}`)
      return
    }
    state.session.changeCwd(next)
    state.config.cwd = next
    printNotice(theme, `工作目录 ${next}`)
  }

  /** 用菜单浏览子目录，省得手敲路径。 */
  const pickDirectory = async (): Promise<void> => {
    const cwd = state.session.cwd
    let entries: string[] = []
    try {
      entries = readdirSync(cwd, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right))
    } catch {
      printError(theme, `无法读取目录 ${cwd}`)
      return
    }
    const items: SelectItem[] = [{ label: '..', hint: '上级目录', value: '..' }]
    for (const name of entries) items.push({ label: `${name}/`, hint: '进入', value: name })
    const picked = await selectOption({
      rl,
      theme,
      title: '切换工作目录',
      items,
      footer: `当前 ${cwd}`,
      filterable: true,
    })
    if (picked === undefined) {
      printNotice(theme, '已取消')
      return
    }
    changeDir(picked)
  }

  const addModel = async (): Promise<void> => {
    const alias = await ask('  别名（字母、数字与 . _ -）: ')
    if (alias === '') {
      printError(theme, '别名不能为空')
      return
    }
    if (!/^[A-Za-z0-9._-]+$/.test(alias)) {
      printError(theme, '别名只能包含字母、数字与 . _ -')
      return
    }
    if (state.store.find(alias)) {
      printError(theme, `别名 ${alias} 已存在；改密钥用 /key ${alias}`)
      return
    }
    const model = (await ask(`  model id [${alias}]: `)) || alias
    const baseUrl = (await ask(`  API 地址 [${state.config.baseUrl}]: `)) || state.config.baseUrl
    const secret = await readSecret(rl, '  API Key（回车表示引用环境变量 DEEPSEEK_API_KEY）: ')
    const apiKey = secret === '' ? 'env:DEEPSEEK_API_KEY' : secret
    try {
      state.store.add({ alias, model, baseUrl, apiKey })
    } catch (error) {
      printError(theme, error instanceof Error ? error.message : String(error))
      return
    }
    printNotice(theme, `已写入 ${state.store.path}`)
    if (secret !== '') printNotice(theme, `密钥已保存 ${maskKey(secret)}（该文件已在 .gitignore 中）`)
    switchModel(alias)
  }

  const removeModel = (alias: string): void => {
    if (alias === '') {
      printError(theme, '用法：/model remove <别名>')
      return
    }
    if (alias === state.config.alias) {
      printError(theme, '不能删除当前使用的模型，先切换到别的别名')
      return
    }
    if (!state.store.remove(alias)) {
      printError(theme, `没有别名 ${alias}`)
      return
    }
    printNotice(theme, `已删除 ${alias}`)
  }

  const setModelKey = async (target: string): Promise<void> => {
    const alias = target === '' ? state.config.alias : target
    if (alias === '') {
      printError(theme, '当前没有别名，先用 /model add 添加一个模型')
      return
    }
    const entry = state.store.find(alias)
    if (!entry) {
      printError(theme, `没有别名 ${alias}，先用 /model add 添加`)
      return
    }
    printNotice(theme, `当前密钥：${state.store.keySource(entry)}`)
    const secret = await readSecret(rl, `  ${alias} 的新 API Key（回车取消）: `)
    if (secret === '') {
      printNotice(theme, '已取消')
      return
    }
    state.store.setKey(alias, secret)
    if (alias === state.config.alias) {
      applyModel(state.config, state.store, alias)
      rebuild()
    }
    printNotice(theme, `已保存 ${maskKey(secret)}，下一轮请求生效`)
  }

  const listRemote = async (): Promise<void> => {
    printNotice(theme, `查询 ${hostOf(state.config.baseUrl)} …`)
    let models: string[]
    try {
      models = await requestModelListing(
        { baseUrl: state.config.baseUrl, apiKey: state.config.apiKey, model: state.config.model },
        new AbortController().signal,
      )
    } catch (error) {
      printNotice(theme, `无法获取列表：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (models.length === 0) {
      printNotice(theme, '（无法获取列表，检查密钥或地址）')
      return
    }
    const known = new Set(state.store.entries.map((entry) => entry.model))
    for (const id of models) {
      const mark = id === state.config.model ? theme.cyan('●') : known.has(id) ? '○' : theme.gray('·')
      process.stdout.write(`  ${mark} ${id}${known.has(id) ? theme.gray('（已配置）') : ''}\n`)
    }
  }

  const handleCommand = async (line: string): Promise<void> => {
    const [command, ...rest] = line.trim().split(/\s+/)
    const argument = rest.join(' ')
    switch (command) {
      case '/help':
      case '/?':
        printHelp(theme)
        break
      case '/new':
        state.session = createSession(state.config.sessionDir, {
          alias: state.config.alias,
          cwd: state.session.cwd,
        })
        state.agent = createAgent(state.session)
        if (state.config.alias !== '') state.session.selectModel(state.config.alias, llm.provider, state.config.model)
        printNotice(theme, `新会话 ${state.session.id}`)
        break
      case '/model': {
        const [sub, ...rest] = argument.split(/\s+/).filter(Boolean)
        if (sub === undefined) {
          if (process.stdin.isTTY) await pickModel()
          else listConfigured()
        }
        else if (sub === 'add') await addModel()
        else if (sub === 'remove') {
          const target = rest.join(' ')
          if (target !== '') removeModel(target)
          else if (process.stdin.isTTY) {
            const alias = await pickAlias('删除哪个模型？', state.config.alias)
            if (alias === undefined) printNotice(theme, '已取消')
            else removeModel(alias)
          } else printError(theme, '用法：/model remove <别名>')
        }
        else if (sub === 'remote') await listRemote()
        else switchModel(sub)
        break
      }
      case '/key': {
        let target = argument.trim()
        if (target === '' && process.stdin.isTTY) {
          const alias = await pickAlias('为哪个模型设置密钥？')
          if (alias === undefined) {
            printNotice(theme, '已取消')
            break
          }
          target = alias
        }
        await setModelKey(target)
        break
      }
      case '/cd': {
        if (argument === '') {
          if (process.stdin.isTTY) await pickDirectory()
          else printNotice(theme, `当前目录 ${state.session.cwd}`)
          break
        }
        changeDir(argument)
        break
      }
      case '/tools':
        process.stdout.write('\n')
        for (const tool of state.tools) {
          const tag = tool.mutating ? theme.yellow(' [需确认]') : ''
          process.stdout.write(`  ${theme.cyan(tool.name)}${tag}  ${theme.gray(clipLine(tool.description, 90))}\n`)
        }
        process.stdout.write('\n')
        break
      case '/session':
        printNotice(theme, `id ${state.session.id}`)
        printNotice(theme, `文件 ${state.session.path}`)
        printNotice(
          theme,
          `模型 ${state.session.alias || state.config.model} · 目录 ${state.session.cwd} · 消息 ${state.session.messageCount}`,
        )
        break
      case '/sessions': {
        const sessions = listSessions(state.config.sessionDir).slice(0, 15)
        if (sessions.length === 0) {
          printNotice(theme, '还没有历史会话')
          break
        }
        process.stdout.write('\n')
        for (const item of sessions) {
          const current = item.id === state.session.id ? theme.cyan('●') : '○'
          const when = item.updated.toLocaleString('zh-CN', { hour12: false })
          const tag = item.legacy === true ? ' · 旧格式（不可恢复）' : ''
          process.stdout.write(
            `  ${current} ${theme.bold(item.id)}  ${theme.gray(`${when} · ${item.alias || '未记录模型'} · ${item.messages} 条${tag}`)}\n`,
          )
        }
        process.stdout.write('\n')
        break
      }
      case '/compact': {
        // Manual compaction requires an idle agent, so it runs outside runExclusive.
        const outcome = await executeCompact(compaction, state.agent, argument, new AbortController().signal)
        if (outcome.kind === 'success') printNotice(theme, outcome.text)
        else printError(theme, outcome.text)
        break
      }
      case '/resume':
        if (argument === '') {
          if (process.stdin.isTTY) await pickSession()
          else printError(theme, '用法：/resume <会话 id 或前缀>')
        } else resumeSession(argument)
        break
      case '/usage': {
        const totals = state.session.usage()
        printNotice(
          theme,
          `↑${totals.inputTokens} ↓${totals.outputTokens} 缓存 ${totals.cacheReadTokens ?? 0}`,
        )
        break
      }
      case '/exit':
      case '/quit':
        closed = true
        rl.close()
        return
      default:
        printError(theme, `未知命令 ${command}，输入 /help 查看`)
    }
  }

  const execute = async (text: string): Promise<void> => {
    const trimmed = text.trim()
    if (trimmed === '') {
      showPrompt()
      return
    }
    if (trimmed === '/' && process.stdin.isTTY) {
      busy = true
      try {
        const picked = await pickCommand()
        if (picked !== undefined) await handleCommand(picked)
      } finally {
        busy = false
        showPrompt()
      }
      return
    }
    if (text.startsWith('/') && !text.includes('\n')) {
      busy = true
      try {
        await handleCommand(text)
      } finally {
        busy = false
        showPrompt()
      }
      return
    }
    await runInput(text)
  }

  const enqueue = (text: string): void => {
    chain = chain
      .then(() => execute(text))
      .catch((error: unknown) => {
        printError(theme, error instanceof Error ? error.message : String(error))
        showPrompt()
      })
  }

  /** 清空当前输入行：readline 的 write(null, key) 在部分版本上不生效，直接改状态再重绘。 */
  const clearLine = (): void => {
    const internal = rl as unknown as { line: string; cursor: number; _refreshLine?: () => void }
    internal.line = ''
    internal.cursor = 0
    internal._refreshLine?.()
  }

  /** 键入 `/` 当场弹出命令菜单：输入即筛选，选中即执行。 */
  const openCommandMenu = async (): Promise<void> => {
    if (menuOpen || busy || closed) return
    menuOpen = true
    try {
      clearLine()
      const picked = await pickCommand()
      if (picked === undefined) {
        // 菜单期间页脚没动过，只需把输入行画回原位，别再叠一遍页脚。
        drawPrompt(false)
        return
      }
      await execute(picked)
    } catch (error) {
      printError(theme, error instanceof Error ? error.message : String(error))
      showPrompt()
    } finally {
      menuOpen = false
      // 菜单期间可能被 readline 顺手写进了字符，收尾时抹掉。
      if (rl.line !== '') clearLine()
    }
  }

  rl.on('line', (line) => {
    // 菜单打开时残留的按键（粘贴里带的后续字符）不算输入。
    if (closed || menuOpen) return
    if (!process.stdin.isTTY) {
      enqueue(line)
      return
    }
    pending.push(line)
    if (pendingTimer) clearTimeout(pendingTimer)
    // Coalesce a multi-line paste into one message.
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined
      const text = pending.join('\n')
      pending = []
      enqueue(text)
    }, 50)
  })

  if (process.stdin.isTTY) {
    // Let a lone Esc cancel the running turn, the way Claude Code does.
    readline.emitKeypressEvents(process.stdin, rl)
    process.stdin.on('keypress', (input: string, key: readline.Key) => {
      if (busy && abort && key?.name === 'escape') {
        waiting.stop()
        abort.abort()
        process.stdout.write(`\n${theme.yellow(BULLET)} 正在中断…\n`)
        return
      }
      if (!busy && !menuOpen && !closed) drawPrompt(true)
      // 提示符为空时敲下 `/`：立刻接管成命令菜单，不用再按回车。
      // 中文输入法下常打出全角 `／`，一并当作触发字符。
      const slash = (input === '/' || input === '／') && (rl.line === '/' || rl.line === '／')
      if (!busy && !menuOpen && !closed && slash) {
        void openCommandMenu()
      }
    })
  }

  rl.on('SIGINT', () => {
    if (busy && abort) {
      waiting.stop()
      abort.abort()
      process.stdout.write(`\n${theme.yellow(BULLET)} 正在中断…\n`)
      return
    }
    // A non-empty line is cleared first; an empty one exits.
    if (rl.line !== '' && rl.line !== undefined) {
      clearLine()
      process.stdout.write('\n')
      showPrompt()
      return
    }
    if (process.stdin.isTTY) process.stdout.write('\n')
    closed = true
    rl.close()
  })

  rl.on('close', () => {
    closed = true
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      pendingTimer = undefined
      if (pending.length > 0) {
        const text = pending.join('\n')
        pending = []
        enqueue(text)
      }
    }
    chain = chain.then(() => {
      farewell()
    })
  })

  printHeader(theme, {
    version: VERSION,
    model: state.config.model,
    cwd: state.session.cwd,
    tips: [
      ['/model', '切换或添加模型'],
      ['/compact', '把较早的对话压缩成摘要'],
      ['/resume', '恢复历史会话'],
      ['/cd', '切换工作目录'],
      ['/help', '查看全部命令'],
    ],
  })
  showPrompt()
}

/** Load the most recent inputs so arrow-up works across sessions. */
function loadHistory(path: string): string[] {
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .slice(-300)
  } catch {
    return []
  }
}

/** Persist readline history (newest first in memory, oldest first on disk). */
function saveHistory(path: string, history: readonly string[]): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const lines = history.slice(0, 300).slice().reverse()
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
  } catch {
    // History is a convenience; losing it must not break the exit path.
  }
}
