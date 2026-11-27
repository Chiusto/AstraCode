/**
 * Provider limits for the DeepSeek chat-completions route this CLI uses.
 * Upstream `defaults.ts` targets the Messages API (1M context); the public
 * `/chat/completions` route served by `api.deepseek.com` is smaller.
 */

/** Default maximum idle interval while a stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 131_072
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 8192
