/**
 * DeepSeek provider adapter.
 * @module @astra/llm-deepseek
 */

export { DeepSeekAdapter } from './adapter.ts'
export type { DeepSeekAdapterOptions, DeepSeekConnectionOptions } from './adapter.ts'
export { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from './defaults.ts'
export { parseModelListing, requestModelListing } from './listing.ts'
export { parseSse } from './sse.ts'
export { providerError, providerErrorDetail } from './transport.ts'
