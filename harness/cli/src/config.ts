/**
 * Runtime configuration: environment loading, defaults, flag resolution.
 * @module @astra/cli/config
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** CLI version reported by `--version` and the banner. */
export const VERSION = '0.1.0'

/** Absolute path of `harness/cli`. */
export const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Absolute path of the `AstraCode` checkout that contains `.env`. */
export const REPO_ROOT = resolve(CLI_ROOT, '..', '..')

/** Everything one process needs to talk to the model and to the local machine. */
export interface CliConfig {
  apiKey: string
  baseUrl: string
  model: string
  /** Alias of the active entry in `modelsPath`; empty until resolved. */
  alias: string
  /** Where `model` came from, so the registry default is not overridden blindly. */
  modelSource: 'flag' | 'env' | 'default'
  /** Location of the editable model/key registry. */
  modelsPath: string
  maxTokens: number
  temperature?: number
  /** Default working directory for tools, changeable with `/cd`. */
  cwd: string
  sessionDir: string
  /** Run mutating tools without asking. */
  autoApprove: boolean
  color: boolean
  /** Extra instructions appended to the built-in system prompt. */
  systemExtra?: string
  maxSteps: number
  /** Model context capacity used for compaction pressure. */
  contextWindow: number
  /** Compact automatically when the next request reaches the threshold. */
  autoCompact: boolean
  /** Fraction of the context window at which compaction starts. */
  compactThresholdRatio: number
  /** Fraction of the message budget kept verbatim as the recent tail. */
  compactRetainRatio: number
  /** Extra room kept free below the context window, in tokens. */
  compactHeadroomTokens: number
  /** Upper bound for one summary request. */
  compactMaxTokens: number
  /** Append a durable clock reading before each eligible step. */
  timeContext: boolean
}

/** Flags accepted on the command line. */
export interface CliFlags {
  prompt?: string
  model?: string
  cwd?: string
  session?: string
  system?: string
  maxTokens?: number
  maxSteps?: number
  yes: boolean
  ask: boolean
  color?: boolean
  /** Force the interactive UI even when stdin is not a TTY. */
  repl: boolean
  help: boolean
  version: boolean
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-chat'

/** Parse `KEY = value`, `KEY=value`, `export KEY=value`, quotes and comments. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    let key = line.slice(0, eq).trim()
    if (key.startsWith('export ')) key = key.slice(7).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2) {
      const quote = value[0]
      if ((quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/** Read the first `.env` that exists, later files override earlier ones. */
function loadEnvFiles(paths: readonly string[]): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const path of paths) {
    if (!existsSync(path)) continue
    try {
      Object.assign(merged, parseDotEnv(readFileSync(path, 'utf8')))
    } catch {
      // An unreadable .env is not fatal: the process environment may still work.
    }
  }
  return merged
}

let cachedFileEnv: Record<string, string> | undefined

/** Values from `.env` files, loaded once. */
function fileEnv(): Record<string, string> {
  cachedFileEnv ??= loadEnvFiles([
    join(REPO_ROOT, '.env'),
    join(CLI_ROOT, '.env'),
    join(process.cwd(), '.env'),
  ])
  return cachedFileEnv
}

/** Look a variable up in the process environment first, then in `.env` files. */
export function envValue(name: string): string | undefined {
  const fromProcess = process.env[name]
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess
  const fromFile = fileEnv()[name]
  return fromFile !== undefined && fromFile !== '' ? fromFile : undefined
}

/** Resolve a relative path against the CLI cwd, expanding `~`. */
export function resolvePath(input: string, cwd: string): string {
  let p = input.trim()
  if (p === '~') p = process.env.USERPROFILE ?? process.env.HOME ?? p
  else if (p.startsWith('~/') || p.startsWith('~\\')) {
    p = join(process.env.USERPROFILE ?? process.env.HOME ?? '', p.slice(2))
  }
  return isAbsolute(p) ? p : resolve(cwd, p)
}

/** Build the effective configuration, applying flags over environment values. */
export function resolveConfig(flags: CliFlags): CliConfig {
  const pick = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = envValue(name)
      if (value !== undefined) return value
    }
    return undefined
  }

  const cwd = resolvePath(flags.cwd ?? pick('ASTRA_CWD') ?? process.cwd(), process.cwd())

  const envModel = pick('ASTRA_AGENT_MODEL', 'ASTRA_MODEL')
  const maxTokensRaw = flags.maxTokens ?? Number(pick('ASTRA_MAX_TOKENS') ?? '')
  const maxStepsRaw = flags.maxSteps ?? Number(pick('ASTRA_MAX_STEPS') ?? '')

  const positive = (name: string, fallback: number): number => {
    const raw = pick(name)
    const value = raw === undefined ? Number.NaN : Number(raw)
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  const ratio = (name: string, fallback: number): number => {
    const value = positive(name, fallback)
    return value > 0 && value <= 1 ? value : fallback
  }

  return {
    apiKey: pick('DEEPSEEK_API_KEY', 'ASTRA_API_KEY') ?? '',
    baseUrl: (pick('DEEPSEEK_BASE_URL', 'ASTRA_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: flags.model ?? envModel ?? DEFAULT_MODEL,
    modelSource: flags.model !== undefined ? 'flag' : envModel !== undefined ? 'env' : 'default',
    alias: '',
    modelsPath: resolvePath(pick('ASTRA_MODELS_FILE') ?? join(CLI_ROOT, 'models.json'), process.cwd()),
    maxTokens: Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? maxTokensRaw : 8192,
    temperature: pick('ASTRA_TEMPERATURE') ? Number(pick('ASTRA_TEMPERATURE')) : undefined,
    cwd,
    sessionDir: resolvePath(pick('ASTRA_SESSION_DIR') ?? join(CLI_ROOT, 'sessions'), process.cwd()),
    autoApprove: flags.ask ? false : (flags.yes || !process.stdin.isTTY),
    color: flags.color ?? (process.stdout.isTTY === true && !process.env.NO_COLOR),
    systemExtra: flags.system ?? pick('ASTRA_SYSTEM_EXTRA'),
    maxSteps: Number.isFinite(maxStepsRaw) && maxStepsRaw > 0 ? maxStepsRaw : 24,
    contextWindow: positive('ASTRA_CONTEXT_WINDOW', 131_072),
    autoCompact: pick('ASTRA_AUTO_COMPACT') !== '0',
    compactThresholdRatio: ratio('ASTRA_COMPACT_THRESHOLD', 0.8),
    compactRetainRatio: ratio('ASTRA_COMPACT_RETAIN', 0.16),
    compactHeadroomTokens: positive('ASTRA_COMPACT_HEADROOM', 65_536),
    compactMaxTokens: positive('ASTRA_COMPACT_MAX_TOKENS', Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? maxTokensRaw : 8192),
    timeContext: pick('ASTRA_TIME_CONTEXT') !== '0',
  }
}

/** Parse argv into flags. Unknown options are rejected by the caller via help. */
export function parseArgs(argv: readonly string[]): CliFlags {
  const flags: CliFlags = { yes: false, ask: false, repl: false, help: false, version: false }
  const take = (i: number, name: string): string => {
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`${name} 缺少取值`)
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '-p':
      case '--print':
        flags.prompt = take(i, arg)
        i++
        break
      case '-m':
      case '--model':
        flags.model = take(i, arg)
        i++
        break
      case '-C':
      case '--cwd':
        flags.cwd = take(i, arg)
        i++
        break
      case '--session':
        flags.session = take(i, arg)
        i++
        break
      case '--system':
        flags.system = take(i, arg)
        i++
        break
      case '--max-tokens':
        flags.maxTokens = Number(take(i, arg))
        i++
        break
      case '--max-steps':
        flags.maxSteps = Number(take(i, arg))
        i++
        break
      case '-y':
      case '--yes':
        flags.yes = true
        break
      case '--ask':
        flags.ask = true
        break
      case '--no-color':
        flags.color = false
        break
      case '--color':
        flags.color = true
        break
      case '--repl':
        flags.repl = true
        break
      case '-h':
      case '--help':
        flags.help = true
        break
      case '-v':
      case '--version':
        flags.version = true
        break
      default:
        if (arg.startsWith('-')) throw new Error(`未知选项：${arg}`)
        // A bare argument is treated as the one-shot prompt.
        flags.prompt = flags.prompt === undefined ? arg : `${flags.prompt} ${arg}`
    }
  }
  return flags
}
