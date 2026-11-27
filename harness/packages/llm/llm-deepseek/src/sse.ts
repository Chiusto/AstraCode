/**
 * Server-sent-events reader for streaming chat completions.
 * @module @astra/llm-deepseek/sse
 */

/** Decode a response body into complete SSE `data` payloads, dropping keep-alives and `[DONE]`. */
export async function* parseSse(body: ReadableStream<Uint8Array>, activity: () => void): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      activity()
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer)
        if (match === null) break
        const payload = dataOf(buffer.slice(0, match.index))
        buffer = buffer.slice(match.index + match[0].length)
        if (payload !== undefined && payload !== '[DONE]') yield payload
      }
    }
    const rest = dataOf(buffer.trim())
    if (rest !== undefined && rest !== '[DONE]') yield rest
  } finally {
    await reader.cancel().catch(() => {})
  }
}

function dataOf(event: string): string | undefined {
  const data: string[] = []
  for (const line of event.split(/\r?\n/)) {
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  return data.length === 0 ? undefined : data.join('\n')
}
