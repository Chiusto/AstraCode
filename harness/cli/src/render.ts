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
function displayWidth(text: string): number {
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

function padColumns(text: string, target: number): string {
  return text + ' '.repeat(Math.max(0, target - displayWidth(text)))
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

export function humanTokens(value: number): string {
  if (value < 1000) return String(value)
  return `${(value / 1000).toFixed(1)}k`
}

/** Spinner / completion glyph. */
export const SPARK = '✻'
/** Tool bullet. */
export const BULLET = '⏺'
/** Result elbow. */
export const ELBOW = '⎿'

/** Startup banner: identity, active model, workspace, session. */
export function printHeader(
  theme: Theme,
  info: {
    version: string
    model: string
    alias?: string
    key?: string
    cwd: string
    session: string
    tools: number
  },
): void {
  const rule = theme.gray('─'.repeat(Math.min(columns() - 4, 64)))
  const model =
    info.alias && info.alias !== info.model ? `${info.alias} ${theme.gray('→')} ${info.model}` : info.model
  const lines: string[] = []
  lines.push('')
  lines.push(`  ${theme.bold(theme.cyan(SPARK))} ${theme.bold('Astra CLI')} ${theme.gray(`v${info.version}`)}`)
  lines.push(`    ${theme.gray('终端里的对话式编程助手')}`)
  lines.push('')
  lines.push(
    `  ${theme.gray('model'.padEnd(8))}${theme.bold(model)}` +
      (info.key ? `  ${theme.gray(`· 密钥 ${info.key}`)}` : ''),
  )
  lines.push(`  ${theme.gray('cwd'.padEnd(8))}${info.cwd}`)
  lines.push(`  ${theme.gray('session'.padEnd(8))}${info.session}  ${theme.gray(`· ${info.tools} 个工具`)}`)
  lines.push('')
  lines.push(`  ${theme.gray('/ 呼出命令菜单 · 直接输入开始对话 · Esc 中断 · Ctrl+C 退出')}`)
  lines.push('')
  lines.push(`  ${rule}`)
  lines.push('')
  process.stdout.write(lines.join('\n'))
}

/** Render the announcement of one tool call. */
export function printToolCall(theme: Theme, name: string, detail: string): void {
  process.stdout.write(
    `\n${theme.green(BULLET)} ${theme.bold(name)}${detail ? `(${theme.cyan(clipLine(detail, columns() - 8))})` : ''}\n`,
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

/** Completion line after a turn. */
export function printUsage(
  theme: Theme,
  info: { seconds: number; prompt: number; completion: number; cached: number },
): void {
  const parts = [
    `${info.seconds.toFixed(1)}s`,
    `↑${humanTokens(info.prompt)}`,
    `↓${humanTokens(info.completion)}`,
  ]
  if (info.cached > 0) parts.push(`缓存 ${humanTokens(info.cached)}`)
  process.stdout.write(`\n${theme.green(SPARK)} ${theme.gray(`完成 · ${parts.join(' · ')}`)}\n`)
}

export function printInterrupt(theme: Theme, message = '已中断'): void {
  process.stdout.write(`\n${theme.yellow(BULLET)} ${theme.yellow(message)}\n`)
}

export function printError(theme: Theme, message: string): void {
  process.stdout.write(`\n${theme.red(BULLET)} ${theme.red(message)}\n`)
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
