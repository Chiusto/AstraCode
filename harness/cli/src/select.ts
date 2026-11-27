/**
 * Inline option picker: arrow keys, Enter to confirm, Esc to cancel.
 * With `filterable`, typing narrows the list live, so the menu doubles as a
 * search box. Only runs on a TTY; callers keep their static output for pipes.
 * @module @astra/cli/select
 */

import type * as readline from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
import { columns, fitLine, styledWidth } from './render.ts'
import type { Theme } from './render.ts'

export interface SelectItem {
  label: string
  hint?: string
  /** Value returned on confirm. */
  value: string
}

export interface SelectOptions {
  rl: readline.Interface
  theme: Theme
  title: string
  items: readonly SelectItem[]
  footer?: string
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
  /** Override TTY detection (tests). */
  interactive?: boolean
  /** Type to filter: 退格删除，Ctrl+U 清空。 */
  filterable?: boolean
  /**
   * 输入行怎么画。菜单打开期间由选择器接管这一行，保证提示符停在原位、
   * 菜单只在其下方展开；不传则画一个空的 `› `。
   */
  prompt?: (text: string) => string
}

const ESC = '\u001B'
const MAX_ROWS = 10
/** 不是 ↑↓ 的其它转义序列，匹配到就丢弃。 */
const ESC_SEQUENCE = /^\u001B(?:\[[0-9;?]*[ -/]*[@-~]|O.)/

/** 0 前缀 / 1 包含 / 2 子序列 / null 不匹配；越小越靠前。 */
function rankOf(text: string, query: string): number | null {
  if (text === '') return null
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  if (haystack.startsWith(needle)) return 0
  if (haystack.includes(needle)) return 1
  let cursor = 0
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor)
    if (found === -1) return null
    cursor = found + 1
  }
  return 2
}

/** 先看标签与取值，再看提示文字（降级到第 3 档）。 */
function rankItem(item: SelectItem, query: string): number | null {
  const direct = [rankOf(item.label, query), rankOf(item.value, query)].filter(
    (rank): rank is number => rank !== null,
  )
  if (direct.length > 0) return Math.min(...direct)
  if (item.hint !== undefined && rankOf(item.hint, query) !== null) return 3
  return null
}

/** Ask the user to pick one item. Resolves undefined when cancelled. */
export async function selectOption(options: SelectOptions): Promise<string | undefined> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const theme = options.theme
  const items = options.items
  const filterable = options.filterable === true
  const interactive = options.interactive ?? input.isTTY === true
  if (!interactive || items.length === 0) return undefined

  let index = 0
  let rendered = 0
  let settled = false
  let wasRaw = false
  let query = ''
  let shown: SelectItem[] = items.slice()
  let buffer = ''
  let escTimer: NodeJS.Timeout | undefined
  const decoder = new StringDecoder('utf8')

  const filter = (): void => {
    if (!filterable || query === '') {
      shown = items.slice()
      return
    }
    const scored: Array<{ item: SelectItem; rank: number; at: number }> = []
    items.forEach((item, at) => {
      const rank = rankItem(item, query)
      if (rank !== null) scored.push({ item, rank, at })
    })
    scored.sort((left, right) => left.rank - right.rank || left.at - right.at)
    shown = scored.map((entry) => entry.item)
  }
  filter()

  const windowStart = (): number => {
    if (shown.length <= MAX_ROWS) return 0
    return Math.max(0, Math.min(index - Math.floor(MAX_ROWS / 2), shown.length - MAX_ROWS))
  }

  const draw = (): void => {
    const lines: string[] = []
    const position = shown.length > 1 ? ` · ${index + 1}/${shown.length}` : ''
    const keys = filterable
      ? `输入筛选${position} · ↑↓ 选择 · Enter 确认 · Esc 取消`
      : `↑↓ 选择${position} · Enter 确认 · Esc 取消`
    const heading =
      `${theme.gray('›')} ${theme.bold(options.title)}` +
      (query !== '' ? ` ${theme.gray(`「${query}」`)}` : '')
    lines.push(`${heading}  ${theme.gray(keys)}`)

    if (shown.length === 0) {
      lines.push(`  ${theme.gray('（没有匹配项，退格修改或 Esc 取消）')}`)
    } else {
      const start = windowStart()
      for (let at = start; at < Math.min(shown.length, start + MAX_ROWS); at++) {
        const item = shown[at]
        const cursor = at === index ? theme.cyan('❯') : ' '
        const label = at === index ? theme.cyan(theme.bold(item.label)) : item.label
        lines.push(`  ${cursor} ${label}${item.hint ? `  ${theme.gray(item.hint)}` : ''}`)
      }
      if (shown.length > MAX_ROWS) lines.push(`  ${theme.gray(`… 共 ${shown.length} 项`)}`)
    }
    if (options.footer) lines.push(`  ${theme.gray(options.footer)}`)

    const width = columns()
    // 命令菜单：输入行钉在原位，菜单只往它下面长，结束时光标回到输入行末尾。
    if (options.prompt !== undefined) {
      const prompt = fitLine(options.prompt(`/${query}`), width)
      output.write(`\r${ESC}[2K${ESC}[J`)
      output.write(prompt)
      for (const line of lines) output.write(`\n\r${ESC}[2K${fitLine(line, width)}`)
      if (lines.length > 0) output.write(`${ESC}[${lines.length}A`)
      output.write('\r')
      const column = styledWidth(prompt)
      if (column > 0) output.write(`${ESC}[${column}C`)
      rendered = lines.length
      return
    }
    // 二级选择（/model 等）：就地展开，光标停在菜单末行。
    if (rendered > 0) output.write(`${ESC}[${rendered - 1}A`)
    output.write(`\r${ESC}[2K${ESC}[J`)
    lines.forEach((line, at) => {
      if (at > 0) output.write('\n')
      output.write(`\r${ESC}[2K${fitLine(line, width)}`)
    })
    rendered = lines.length
  }

  const erase = (): void => {
    if (options.prompt !== undefined) {
      // 光标在输入行：连同下方菜单一起清掉，位置留给调用方重画提示符。
      output.write(`\r${ESC}[2K${ESC}[J`)
    } else if (rendered > 0) {
      output.write(`${ESC}[${rendered - 1}A\r${ESC}[2K${ESC}[J`)
    }
    rendered = 0
  }

  const cleanup = (): void => {
    if (settled) return
    settled = true
    if (escTimer !== undefined) clearTimeout(escTimer)
    input.removeListener('data', onData)
    try {
      input.setRawMode(wasRaw)
    } catch {
      // Terminal already gone.
    }
    erase()
    options.rl.resume()
  }

  let resolve: (value: string | undefined) => void = () => {}
  const done = new Promise<string | undefined>((res) => {
    resolve = res
  })

  const finish = (value: string | undefined): void => {
    cleanup()
    resolve(value)
  }

  const move = (delta: number): void => {
    const next = index + delta
    if (next < 0 || next >= shown.length) return
    index = next
    draw()
  }

  /** 改动筛选词：重排列表并把光标放回第一项。 */
  const retype = (next: string): void => {
    query = next
    filter()
    index = 0
    draw()
  }

  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    if (escTimer !== undefined) {
      clearTimeout(escTimer)
      escTimer = undefined
    }
    for (;;) {
      if (buffer === '') return
      if (buffer.startsWith(`${ESC}[A`) || buffer.startsWith(`${ESC}OA`)) {
        buffer = buffer.slice(3)
        move(-1)
        continue
      }
      if (buffer.startsWith(`${ESC}[B`) || buffer.startsWith(`${ESC}OB`)) {
        buffer = buffer.slice(3)
        move(1)
        continue
      }
      const char = String.fromCodePoint(buffer.codePointAt(0) ?? 0)
      if (char === ESC) {
        // 其它功能键（←→、Home、PageUp…）直接忽略，别当成取消。
        const sequence = ESC_SEQUENCE.exec(buffer)
        if (sequence !== null) {
          buffer = buffer.slice(sequence[0].length)
          continue
        }
        // 可能是被拆成两个 chunk 的转义序列：稍等一下再说，等不到就是单独的 Esc。
        escTimer = setTimeout(() => {
          buffer = ''
          finish(undefined)
        }, 40)
        return
      }
      buffer = buffer.slice(char.length)
      if (char === '\r' || char === '\n') {
        const picked = shown[index]
        if (picked !== undefined) {
          finish(picked.value)
        } else {
          draw()
        }
        return
      }
      if (char === '\u0003') {
        finish(undefined)
        return
      }
      if (char === '\u007F' || char === '\b') {
        if (filterable && query !== '') retype([...query].slice(0, -1).join(''))
        continue
      }
      if (char === '\u0015') {
        if (filterable) retype('')
        continue
      }
      if (char === 'k' && !filterable) move(-1)
      else if (char === 'j' && !filterable) move(1)
      else if (!filterable && char >= '1' && char <= '9') {
        const target = Number(char) - 1
        if (target < shown.length) {
          index = target
          draw()
        }
      } else if (filterable && char >= ' ') {
        retype(query + char)
      }
    }
  }

  try {
    wasRaw = input.isRaw === true
    input.setRawMode(true)
  } catch {
    return undefined
  }
  options.rl.pause()
  input.resume()
  input.on('data', onData)
  draw()

  return done
}
