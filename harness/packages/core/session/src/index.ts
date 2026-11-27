/**
 * Session: an append-only event log, its model-visible surface, and the JSONL
 * store that persists it. Port of `packages/core/session/src/index.ts` without cordis.
 * @module @astra/session
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Message, TokenUsage } from '../../../llm/llm/src/index.ts'
import { interruptedTurnClosers } from './repair.ts'
import { SessionSurface } from './surface.ts'
import type { RequestHeader, SessionEvent, SessionEventMap, SessionEventType, SessionSeq } from './types.ts'

export { TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN, ToolCallRecovery, interruptedTurnClosers, openTurnClosers } from './repair.ts'
export type { OpenTurnCloseCause } from './repair.ts'
export { SessionSurface } from './surface.ts'
export { SURFACE_EVENT_TYPES, surfaceMessageOf } from './types.ts'
export type {
  MessageSource,
  RequestHeader,
  SessionEvent,
  SessionEventMap,
  SessionEventType,
  SessionSeq,
  ShadowPrice,
  TurnEndReason,
} from './types.ts'

export interface AppendOptions {
  surfaceOp?: SessionEvent['surfaceOp']
  sourceEventSeqs?: SessionSeq[]
}

/** One live conversation plus its durable log. */
export class Session {
  readonly id: string
  readonly path: string
  readonly surface = new SessionSurface()
  /** Next turn number; a resumed session continues where its log stopped. */
  nextTurn = 1
  alias: string
  cwd: string
  /** Called after every appended event, for live presentation. */
  onEvent?: (event: SessionEvent) => void
  private readonly log: SessionEvent[] = []
  private header?: RequestHeader

  private constructor(options: { id: string; path: string; alias: string; cwd: string }) {
    this.id = options.id
    this.path = options.path
    this.alias = options.alias
    this.cwd = options.cwd
  }

  /** Number of committed events; also the seq the next append receives. */
  get seq(): number {
    return this.log.length
  }

  eventAt(seq: SessionSeq): SessionEvent | undefined {
    const event = this.log[seq]
    return event !== undefined && event.seq === seq ? event : undefined
  }

  /** The model-visible messages in replay order. */
  get messages(): Message[] {
    const out: Message[] = []
    for (const seq of this.surface.nodes) {
      const event = this.log[seq]
      if (event === undefined) continue
      switch (event.type) {
        case 'user/message':
        case 'assistant/message':
        case 'tool/result':
          out.push(event.data.message)
          break
        default:
          break
      }
    }
    return out
  }

  /** Number of model-visible messages. */
  get messageCount(): number {
    return this.surface.nodes.length
  }

  /** The latest recorded request envelope, if any. */
  requestHeader(): RequestHeader | undefined {
    return this.header
  }

  /** The turn left open by the log tail, or null when every turn is closed. */
  openTurn(): number | null {
    let open: number | null = null
    for (const event of this.log) {
      if (event.type === 'turn/start') open = event.data.turn
      else if (event.type === 'turn/end') open = null
    }
    return open
  }

  /** Sum of provider-reported usage over every model call, including compaction summaries. */
  usage(): TokenUsage {
    const total: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
    const add = (usage: TokenUsage | undefined): void => {
      if (usage === undefined) return
      total.inputTokens += usage.inputTokens
      total.outputTokens += usage.outputTokens
      total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0)
    }
    for (const event of this.log) {
      if (event.type === 'assistant/message') add(event.data.usage)
      else if (event.type === 'compaction/summary') add(event.data.usage)
    }
    return total
  }

  /** Record one event durably, then apply its surface effect. */
  append<Type extends SessionEventType>(
    type: Type,
    data: SessionEventMap[Type],
    options: AppendOptions = {},
  ): SessionEvent<Type> {
    const event = {
      type,
      seq: this.log.length,
      time: Date.now(),
      data,
      ...options.surfaceOp === undefined ? {} : { surfaceOp: options.surfaceOp },
      ...options.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: options.sourceEventSeqs },
    } as SessionEvent<Type>
    this.commit(event)
    return event
  }

  /** Record the envelope the next request carries; repeated identical envelopes are skipped. */
  recordRequest(header: RequestHeader): void {
    if (this.header !== undefined && JSON.stringify(this.header) === JSON.stringify(header)) return
    this.header = header
    this.append('request/header', header)
  }

  /** Remember which configured model alias produced the following turns. */
  selectModel(alias: string, provider: string, model: string): void {
    this.alias = alias
    this.append('model/selection', { provider, model, alias })
  }

  changeCwd(cwd: string): void {
    this.cwd = cwd
    this.append('cwd', { cwd })
  }

  private commit(event: SessionEvent): void {
    this.log.push(event)
    this.adopt(event)
    this.surface.fold(event)
    try {
      appendFileSync(this.path, `${JSON.stringify(event)}\n`, 'utf8')
    } catch {
      // Losing the log must not abort the conversation.
    }
    this.onEvent?.(event)
  }

  /** Restore one durable event without rewriting it; its seq and time stand. */
  private replay(event: SessionEvent): void {
    this.log.push(event)
    this.adopt(event)
    this.surface.fold(event)
  }

  private adopt(event: SessionEvent): void {
    if (event.type === 'request/header') this.header = event.data
    else if (event.type === 'model/selection') this.alias = event.data.alias
    else if (event.type === 'cwd') this.cwd = event.data.cwd
    if (event.type === 'turn/start' && event.data.turn >= this.nextTurn) this.nextTurn = event.data.turn + 1
  }

  /** Every committed event in seq order. */
  events(): readonly SessionEvent[] {
    return this.log
  }
}

function stamp(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** Start a new session file. */
export function createSession(dir: string, options: { alias: string; cwd: string }): Session {
  mkdirSync(dir, { recursive: true })
  let id = `${stamp()}-${Math.random().toString(36).slice(2, 6)}`
  let path = join(dir, `${id}.jsonl`)
  for (let attempt = 0; existsSync(path) && attempt < 5; attempt++) {
    id = `${stamp()}-${Math.random().toString(36).slice(2, 6)}`
    path = join(dir, `${id}.jsonl`)
  }
  mkdirSync(dir, { recursive: true })
  const session = new Session({ id, path, alias: options.alias, cwd: options.cwd })
  session.append('cwd', { cwd: options.cwd })
  return session
}

export interface SessionSummary {
  id: string
  path: string
  alias: string
  cwd: string
  updated: Date
  /** Number of model-visible messages. */
  messages: number
  /** Set when the file predates the event-log format and cannot be resumed. */
  legacy?: boolean
}

function readEvents(path: string): SessionEvent[] {
  const events: SessionEvent[] = []
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const event = JSON.parse(line) as Partial<SessionEvent>
      if (typeof event.type !== 'string' || typeof event.seq !== 'number' || typeof event.time !== 'number') return []
      events.push(event as SessionEvent)
    } catch {
      return []
    }
  }
  return events
}

/** Read every log header in a session directory, newest first. */
export function listSessions(dir: string): SessionSummary[] {
  if (!existsSync(dir)) return []
  const out: SessionSummary[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(dir, name)
    try {
      const first = readFileSync(path, 'utf8').split(/\r?\n/, 1)[0] ?? ''
      if (first.trim() === '') continue
      const head = JSON.parse(first) as Record<string, unknown>
      if (typeof head.type !== 'string') {
        out.push({
          id: name.replace(/\.jsonl$/, ''),
          path,
          alias: '',
          cwd: '',
          updated: statSync(path).mtime,
          messages: 0,
          legacy: true,
        })
        continue
      }
      const events = readEvents(path)
      const model = [...events].reverse().find((event) => event.type === 'model/selection')
      const cwd = [...events].reverse().find((event) => event.type === 'cwd')
      out.push({
        id: name.replace(/\.jsonl$/, ''),
        path,
        alias: model?.type === 'model/selection' ? model.data.alias : '',
        cwd: cwd?.type === 'cwd' ? cwd.data.cwd : '',
        updated: statSync(path).mtime,
        messages: events.filter((event) => event.surfaceOp === 'append').length,
      })
    } catch {
      continue
    }
  }
  return out.sort((left, right) => right.updated.getTime() - left.updated.getTime())
}

/**
 * Load an existing log by id or unique prefix. A tail left inside an open turn
 * (crash, kill) is closed with synthetic interrupted events before the session
 * is returned. Returns undefined when the id is unknown or the file is not an
 * event log.
 */
export function resumeSession(dir: string, idOrPrefix: string, fallbackCwd: string): Session | undefined {
  const matches = listSessions(dir).filter((item) => item.id === idOrPrefix || item.id.startsWith(idOrPrefix))
  const summary = matches.length === 1 ? matches[0] : undefined
  if (summary === undefined || summary.legacy === true) return undefined
  const events = readEvents(summary.path)
  if (events.length === 0) return undefined
  const session = new Session({
    id: summary.id,
    path: summary.path,
    alias: summary.alias,
    cwd: summary.cwd === '' ? fallbackCwd : summary.cwd,
  })
  for (const event of events) session.replay(event)
  for (const closer of interruptedTurnClosers(session.events())) {
    session.append(closer.type, closer.data, {
      surfaceOp: closer.surfaceOp,
      sourceEventSeqs: closer.sourceEventSeqs,
    })
  }
  return session
}
