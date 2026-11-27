/**
 * Model registry: the `models.json` file that stores aliases, endpoints and
 * API key references, plus resolution of the active entry into the runtime
 * config.
 * @module @astra/cli/models
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { envValue } from './config.ts'
import type { CliConfig } from './config.ts'

/** One configured model. `apiKey` is either a literal secret or `env:NAME`. */
export interface ModelEntry {
  alias: string
  /** Wire model id sent to the provider. */
  model: string
  baseUrl: string
  apiKey?: string
  note?: string
  /** Context capacity in tokens, overriding ASTRA_CONTEXT_WINDOW. */
  contextWindow?: number
}

interface FileShape {
  default?: string
  models?: ModelEntry[]
}

/** Outcome of pointing the runtime config at one store entry. */
export interface AppliedModel {
  alias: string
  /** Where the key came from, for the status line. */
  keySource: string
}

const ENV_KEY = 'env:DEEPSEEK_API_KEY'

/** Short, safe rendering of a secret for the terminal. */
export function maskKey(key: string): string {
  if (key.length <= 10) return `${key.slice(0, 2)}***`
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

/** In-memory registry backed by one JSON file. */
export class ModelStore {
  readonly path: string
  entries: ModelEntry[] = []
  defaultAlias?: string
  /** Set when the file existed but could not be parsed; saving overwrites it. */
  loadWarning?: string

  private constructor(path: string) {
    this.path = path
  }

  /** Load the file, seeding a DeepSeek entry when it is missing or empty. */
  static load(path: string, seed: { baseUrl: string; model: string }): ModelStore {
    const store = new ModelStore(path)
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as FileShape
        store.entries = (raw.models ?? [])
          .filter((entry) => typeof entry?.alias === 'string' && entry.alias !== '')
          .map((entry) => ({
            alias: entry.alias,
            model: entry.model || entry.alias,
            baseUrl: normalizeBaseUrl(entry.baseUrl || seed.baseUrl),
            apiKey: entry.apiKey,
            note: entry.note,
            contextWindow: Number.isFinite(entry.contextWindow) && (entry.contextWindow as number) > 0
              ? entry.contextWindow
              : undefined,
          }))
        store.defaultAlias = raw.default
      } catch (error) {
        store.loadWarning = `models.json 解析失败，已按默认值启动：${error instanceof Error ? error.message : String(error)}`
      }
    }

    if (store.entries.length === 0) {
      store.entries.push({
        alias: seed.model,
        model: seed.model,
        baseUrl: normalizeBaseUrl(seed.baseUrl),
        apiKey: ENV_KEY,
        note: '默认（密钥引用环境变量）',
      })
      store.defaultAlias = store.defaultAlias ?? seed.model
      if (!existsSync(path)) store.save()
    }
    return store
  }

  find(alias: string): ModelEntry | undefined {
    return this.entries.find((entry) => entry.alias === alias)
  }

  /** Alias for the default entry, if it still exists. */
  currentDefault(): string | undefined {
    return this.defaultAlias !== undefined && this.find(this.defaultAlias) ? this.defaultAlias : this.entries[0]?.alias
  }

  add(entry: ModelEntry): void {
    if (this.find(entry.alias)) throw new Error(`别名 ${entry.alias} 已存在`)
    this.entries.push({ ...entry, baseUrl: normalizeBaseUrl(entry.baseUrl) })
    this.save()
  }

  remove(alias: string): boolean {
    const index = this.entries.findIndex((entry) => entry.alias === alias)
    if (index < 0) return false
    this.entries.splice(index, 1)
    if (this.defaultAlias === alias) this.defaultAlias = this.entries[0]?.alias
    this.save()
    return true
  }

  setKey(alias: string, apiKey: string): void {
    const entry = this.find(alias)
    if (!entry) throw new Error(`没有别名 ${alias}`)
    entry.apiKey = apiKey
    this.save()
  }

  setDefault(alias: string): void {
    if (!this.find(alias)) throw new Error(`没有别名 ${alias}`)
    this.defaultAlias = alias
    this.save()
  }

  /** Resolve an entry's key reference against the environment. */
  resolveKey(entry: ModelEntry): string | undefined {
    const reference = entry.apiKey?.trim()
    if (!reference) return undefined
    if (!reference.startsWith('env:')) return reference
    return envValue(reference.slice(4))
  }

  /** Human-readable key state for listings. */
  keySource(entry: ModelEntry): string {
    const reference = entry.apiKey?.trim()
    if (!reference) return '未配置'
    if (reference.startsWith('env:')) {
      const name = reference.slice(4)
      return this.resolveKey(entry) ? `env ${name}` : `env ${name}（未设置）`
    }
    return `已保存 ${maskKey(reference)}`
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const payload: FileShape = {
      default: this.defaultAlias,
      models: this.entries,
    }
    try {
      writeFileSync(this.path, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      this.loadWarning = undefined
    } catch (error) {
      throw new Error(`无法写入 ${this.path}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Point the runtime config at `target` (alias, else raw model id). */
export function applyModel(config: CliConfig, store: ModelStore, target?: string): AppliedModel {
  const wanted = target ?? (config.alias !== '' ? config.alias : undefined) ?? store.currentDefault()
  const entry = wanted === undefined ? undefined : store.find(wanted)
  const envKey = envValue('DEEPSEEK_API_KEY') ?? envValue('ASTRA_API_KEY') ?? ''

  if (!entry) {
    // Raw model id: keep the current endpoint, resolve the key from the environment.
    config.alias = wanted ?? config.model
    if (wanted !== undefined) config.model = wanted
    if (config.apiKey === '') config.apiKey = envKey
    return {
      alias: config.alias,
      keySource: config.apiKey !== '' ? '环境变量' : '未配置',
    }
  }

  config.alias = entry.alias
  config.model = entry.model
  config.baseUrl = entry.baseUrl
  if (entry.contextWindow !== undefined) config.contextWindow = entry.contextWindow
  const stored = store.resolveKey(entry)
  config.apiKey = stored ?? envKey
  let keySource = '未配置'
  if (stored) keySource = store.keySource(entry)
  else if (envKey) keySource = 'env DEEPSEEK_API_KEY'
  return { alias: entry.alias, keySource }
}
