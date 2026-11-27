/**
 * Terminal rendering: colors, banner, tool blocks, diffs, usage lines.
 * @module @astra/cli/render
 */

const CSI = '\u001B['

export interface Theme {
  bold: (text: string) => string
  dim: (text: string) => string
  red: (text: string) => string
  green: (text: string) => string
  yellow: (text: string) => string
  cyan: (text: string) => string
  gray: (text: string) => string
  /** Codex 用于提示符与 `/model` 等可操作文字的天蓝色 (CHATGPT_BLUE_200)。 */
  accent: (text: string) => string
}

function code(open: string, text: string, enabled: boolean): string {
  return enabled ? `${CSI}${open}m${text}${CSI}0m` : text
}

/** Build a palette; `enabled` false emits plain text so logs stay readable. */
export function createTheme(enabled: boolean): Theme {
  return {
    bold: (text) => code('1', text, enabled),
    dim: (text) => code('2', text, enabled),
    red: (text) => code('31', text, enabled),
    green: (text) => code('32', text, enabled),
    yellow: (text) => code('33', text, enabled),
    cyan: (text) => code('36', text, enabled),
    gray: (text) => code('90', text, enabled),
    accent: (text) => code('38;2;99;168;248', text, enabled),
  }
}

/** Terminal width, clamped to a sane range. */
export function columns(): number {
  const width = process.stdout.columns ?? 100
  return Math.max(40, Math.min(width, 160))
}

/** Drop ANSI sequences and control characters so tool output cannot move the cursor. */
export function sanitize(text: string): string {
  return text
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

export function clipLine(text: string, limit = columns() - 4): string {
  const single = sanitize(text).replace(/\s+/g, ' ').trim()
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`
}

/** Terminal width of a string, counting CJK characters as two columns. */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0
    const wide =
      (point >= 0x1100 && point <= 0x115f) ||
      (point >= 0x2e80 && point <= 0xa4cf) ||
      (point >= 0xac00 && point <= 0xd7a3) ||
      (point >= 0xf900 && point <= 0xfaff) ||
      (point >= 0xfe30 && point <= 0xfe6f) ||
      (point >= 0xff00 && point <= 0xff60) ||
      (point >= 0xffe0 && point <= 0xffe6)
    width += wide ? 2 : 1
  }
  return width
}

/** 含 ANSI 颜色时也能量出真实列宽（用于把光标停在着色文本末尾）。 */
export function styledWidth(text: string): number {
  return displayWidth(text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, ''))
}

function padColumns(text: string, target: number): string {
  return text + ' '.repeat(Math.max(0, target - displayWidth(text)))
}

function clipWidth(text: string, limit: number): string {
  let width = 0
  let out = ''
  for (const char of text) {
    const size = displayWidth(char)
    if (width + size > limit) return `${out}…`
    width += size
    out += char
  }
  return out
}

const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/y

/**
 * 把已带颜色的一行裁到终端宽度内，保留 ANSI 序列。
 * 菜单靠“上移 N 行”重绘，任何自动折行都会让画面错位，所以每行必须先裁好。
 */
export function fitLine(text: string, limit = columns()): string {
  let width = 0
  let out = ''
  const ceiling = Math.max(8, limit - 1)
  for (let at = 0; at < text.length; ) {
    ANSI.lastIndex = at
    const sequence = ANSI.exec(text)
    if (sequence !== null) {
      out += sequence[0]
      at = ANSI.lastIndex
      continue
    }
    const char = String.fromCodePoint(text.codePointAt(at) ?? 0)
    const size = displayWidth(char)
    if (width + size > ceiling) return `${out}…\u001B[0m`
    width += size
    out += char
    at += char.length
  }
  return out
}

/** Tool / status bullet, Codex style. */
export const BULLET = '•'
/** Result elbow. */
export const ELBOW = '└'
const TOOL_VERBS: Record<string, string> = {
  run_terminal: 'Ran',
  read_file: 'Read',
  write_file: 'Wrote',
  edit_file: 'Edited',
  list_dir: 'Listed',
}

/** 路径过长时保留开头与结尾，中间用省略号收窄（对齐 Codex 的 center_truncate_path）。 */
function clipPath(text: string, limit: number): string {
  if (displayWidth(text) <= limit) return text
  if (limit <= 1) return '…'
  const tail = text.slice(-Math.max(1, Math.floor(limit * 0.6)))
  let head = ''
  let width = 0
  const budget = limit - 1 - displayWidth(tail)
  for (const char of text) {
    const size = displayWidth(char)
    if (width + size > budget) break
    width += size
    head += char
  }
  return `${head}…${tail}`
}

/** Codex 的卡片内容宽度上限（`SESSION_HEADER_MAX_INNER_WIDTH`）。 */
const HEADER_MAX_INNER_WIDTH = 56

export interface HeaderInfo {
  version: string
  model: string
  /** 推理强度，有值时才跟在模型名后面。 */
  effort?: string
  cwd: string
  /** `[命令, 说明]` 行，列在框下面，与 Codex 首次启动一致。 */
  tips: ReadonlyArray<readonly [string, string]>
}

/**
 * 启动头：圆角卡片（标题 / model / directory）+ 框下的命令列表。
 * 几何照 Codex：内容宽 ≤ min(终端−4, 56)，边框在内容外各留一格。
 */
export function printHeader(theme: Theme, info: HeaderInfo): void {
  const inner = Math.max(20, Math.min(columns() - 4, HEADER_MAX_INNER_WIDTH))
  const labelWidth = 'directory:'.length

  const rows: Array<{ plain: string; paint: string }> = []

  rows.push({
    plain: `>_ Astra CLI (v${info.version})`,
    paint: `${theme.dim('>_ ')}${theme.bold('Astra CLI')}${theme.dim(` (v${info.version})`)}`,
  })
  rows.push({ plain: '', paint: '' })

  const modelLabel = 'model:'.padEnd(labelWidth)
  const effort = info.effort ? ` ${info.effort}` : ''
  const hintCommand = '/model'
  const hintTail = ' to change'
  const fixedWidth =
    displayWidth(modelLabel) + 1 + displayWidth(effort) + 3 + displayWidth(hintCommand + hintTail)
  const model =
    displayWidth(info.model) + fixedWidth > inner
      ? clipWidth(info.model, Math.max(4, inner - fixedWidth))
      : info.model
  rows.push({
    plain: `${modelLabel} ${model}${effort}   ${hintCommand}${hintTail}`,
    paint:
      theme.dim(`${modelLabel} `) +
      theme.bold(model) +
      (effort ? theme.dim(effort) : '') +
      theme.dim('   ') +
      theme.accent(hintCommand) +
      theme.dim(hintTail),
  })

  const dirLabel = 'directory:'.padEnd(labelWidth)
  const dir = clipPath(info.cwd, inner - displayWidth(dirLabel) - 1)
  rows.push({
    plain: `${dirLabel} ${dir}`,
    paint: theme.dim(`${dirLabel} `) + dir,
  })

  const contentWidth = Math.min(
    inner,
    rows.reduce((widest, row) => Math.max(widest, displayWidth(row.plain)), 0),
  )
  const rule = '─'.repeat(contentWidth + 2)

  const lines = [
    theme.dim(`╭${rule}╮`),
    ...rows.map(
      (row) =>
        `${theme.dim('│ ')}${row.paint}${' '.repeat(
          Math.max(0, contentWidth - displayWidth(row.plain)),
        )}${theme.dim(' │')}`,
    ),
    theme.dim(`╰${rule}╯`),
    '',
    `  ${theme.dim('描述一个任务开始，或试试这些命令：')}`,
    '',
    ...info.tips.map(([command, description]) => `  ${theme.accent(command)} ${theme.dim(`- ${description}`)}`),
    '',
  ]
  process.stdout.write(lines.join('\n'))
}

export interface FooterInfo {
  model: string
  effort?: string
  cwd: string
  hint: string
  right: string
}

/** 页脚两行：状态（模型 · 目录）+ 快捷键行（右侧放上下文余量），照 Codex 的底栏。 */
export function printFooter(theme: Theme, info: FooterInfo): void {
  const status = `${info.model}${info.effort ? ` ${info.effort}` : ''} default · ${info.cwd}`
  process.stdout.write(`  ${theme.dim(clipLine(status, columns() - 4))}\n`)
  const gap = columns() - 2 - displayWidth(info.hint) - displayWidth(info.right)
  process.stdout.write(
    `  ${theme.dim(info.hint)}${' '.repeat(Math.max(1, gap))}${theme.dim(info.right)}\n`,
  )
}

/** Prompt for an empty composer: accent `›` followed by a dim placeholder. */
export function composerPrompt(theme: Theme, placeholder: string): string {
  return `${theme.accent('› ')}${theme.dim(placeholder)}`
}

/** Share of the context window still unused, as a whole percent. */
export function contextLeft(usedTokens: number, contextWindow: number): string {
  const percent = Math.max(0, Math.min(100, Math.round((1 - usedTokens / contextWindow) * 100)))
  return `${percent}% 上下文剩余`
}

/** Composer shown while waiting: a static bullet and a running timer, no animation. */
export function workingLine(theme: Theme, label: string, elapsed: number): string {
  return `${theme.bold(BULLET)} ${label} ${theme.gray(`(${elapsed.toFixed(0)}s · esc 中断)`)}` 
}

/** Print the announcement of one tool call. */
export function printToolCall(theme: Theme, name: string, detail: string): void {
  const verb = TOOL_VERBS[name] ?? name
  process.stdout.write(
    `\n${theme.dim(BULLET)} ${verb}${detail ? ` ${clipLine(detail, columns() - 8)}` : ''}\n`,
  )
}

export interface DiffLine {
  kind: '+' | '-' | ' '
  text: string
}

/** Line diff with common prefix/suffix trimmed, LCS inside the changed block. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const head = a.slice(start, endA)
  const tail = b.slice(start, endB)

  if (head.length * tail.length > 250_000) {
    return [
      ...head.map((text) => ({ kind: '-' as const, text })),
      ...tail.map((text) => ({ kind: '+' as const, text })),
    ]
  }

  const table: number[][] = Array.from({ length: head.length + 1 }, () =>
    new Array<number>(tail.length + 1).fill(0),
  )
  for (let i = head.length - 1; i >= 0; i--) {
    for (let j = tail.length - 1; j >= 0; j--) {
      table[i][j] = head[i] === tail[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < head.length && j < tail.length) {
    if (head[i] === tail[j]) {
      out.push({ kind: ' ', text: head[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: '-', text: head[i++] })
    } else {
      out.push({ kind: '+', text: tail[j++] })
    }
  }
  while (i < head.length) out.push({ kind: '-', text: head[i++] })
  while (j < tail.length) out.push({ kind: '+', text: tail[j++] })
  return out
}

function printDiff(theme: Theme, before: string, after: string): void {
  const lines = diffLines(before, after)
  const changed = lines.filter((line) => line.kind !== ' ')
  const added = changed.filter((line) => line.kind === '+').length
  const removed = changed.length - added
  process.stdout.write(`  ${theme.gray(`+${added} -${removed}`)}\n`)
  const shown = changed.slice(0, 14)
  for (const line of shown) {
    const text = clipLine(line.text, columns() - 8)
    process.stdout.write(
      line.kind === '+'
        ? `    ${theme.green('+')} ${theme.green(text)}\n`
        : `    ${theme.red('-')} ${theme.red(text)}\n`,
    )
  }
  if (changed.length > shown.length) {
    process.stdout.write(`    ${theme.gray(`… 还有 ${changed.length - shown.length} 行变更`)}\n`)
  }
}

/** Render the outcome of one tool call, including a diff when the tool edited files. */
export function printToolResult(
  theme: Theme,
  result: {
    ok: boolean
    summary: string
    content: string
    diff?: { before: string; after: string }
  },
  maxLines = 4,
): void {
  if (result.diff) {
    process.stdout.write(`  ${theme.gray(ELBOW)} ${theme.gray(result.summary)}\n`)
    printDiff(theme, result.diff.before, result.diff.after)
    return
  }

  const summary = result.ok ? theme.gray(result.summary) : theme.red(result.summary)
  process.stdout.write(`  ${theme.gray(ELBOW)} ${summary}\n`)
  const noise = /^(exit code:|cwd:|---)/
  const visible = result.content.split(/\r?\n/).filter((line) => line.trim() !== '' && !noise.test(line.trim()))
  for (const line of visible.slice(0, maxLines)) {
    process.stdout.write(`    ${theme.gray(clipLine(line, columns() - 6))}\n`)
  }
  if (visible.length > maxLines) {
    process.stdout.write(`    ${theme.gray(`… 还有 ${visible.length - maxLines} 行`)}\n`)
  }
}

/** One assistant message: a dim bullet on the first line, hanging indent after. */
export class MessageWriter {
  private readonly theme: Theme
  private started = false

  constructor(theme: Theme) {
    this.theme = theme
  }

  write(line: string): void {
    process.stdout.write(`${this.started ? '  ' : this.theme.dim(`${BULLET} `)}${sanitize(line)}\n`)
    this.started = true
  }
}

/** Turn-end line. */
export function printUsage(
  theme: Theme,
  info: { seconds: number },
): void {
  process.stdout.write(`${theme.gray(`\n  用时 ${info.seconds.toFixed(1)}s`)}\n`)
}

export function printInterrupt(theme: Theme, message = '已中断'): void {
  process.stdout.write(`\n${theme.dim(BULLET)} ${theme.yellow(message)}\n`)
}

export function printError(theme: Theme, message: string): void {
  process.stdout.write(`\n${theme.red('■')} ${theme.red(message)}\n`)
}

export function printNotice(theme: Theme, message: string): void {
  process.stdout.write(`${theme.gray(`· ${message}`)}\n`)
}

export function printHelp(theme: Theme): void {
  const rows: Array<[string, string]> = [
    ['/help', '显示这份帮助'],
    ['/new', '开始新会话（当前会话已自动保存）'],
    ['/model', '弹菜单：切换 / 添加 / 删除 / 手动输入 model id'],
    ['/model <别名>', '直接切换到某个别名，也可直接填原始 model id'],
    ['/model add', '添加模型：别名 → model id → API 地址 → 密钥'],
    ['/model remove [别名]', '删除模型配置（不带别名时弹选择）'],
    ['/model remote', '查询服务端可用模型列表'],
    ['/key [别名]', '设置或更新某个模型的 API Key（不带别名时弹选择，输入不回显）'],
    ['/cd [dir]', '切换工作目录（不带参数时弹目录菜单）'],
    ['/compact', '把较早的对话压缩成摘要（手动入口）'],
    ['/tools', '列出工具'],
    ['/session', '显示当前会话信息与消息数'],
    ['/sessions', '列出历史会话'],
    ['/resume [id]', '恢复某个历史会话（不带 id 时弹会话列表）'],
    ['/usage', '本会话累计 token'],
    ['/exit', '退出（等同于 Ctrl+D）'],
  ]
  const width = Math.max(...rows.map(([key]) => displayWidth(key)))
  process.stdout.write(
    `\n${rows.map(([key, desc]) => `  ${theme.cyan(padColumns(key, width))}  ${theme.gray(desc)}`).join('\n')}\n\n`,
  )
  process.stdout.write(`${theme.gray('  直接输入内容即可对话；多行粘贴会自动合并成一条消息发送。')}\n\n`)
  process.stdout.write(
    `${theme.gray('  提示符下敲 / 立即弹出命令菜单：输入即筛选，↑↓ 选择，Enter 确认，Esc 取消；')}\n` +
      `${theme.gray('  选中 /model、/key、/resume、/cd 后还会继续弹出对应的候选列表。')}\n\n`,
  )
}
