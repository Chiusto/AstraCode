# llm-deepseek

DeepSeek 的 chat/completions 流式适配器（`https://api.deepseek.com`）。

## 文件

| 文件 | 内容 |
|---|---|
| `adapter.ts` | `DeepSeekAdapter`：POST `/chat/completions`，解析 SSE 为 `StreamChunk` |
| `sse.ts` | `parseSse(body, activity)`：拼接多行 `data:`，丢弃 `[DONE]`，每个事件回调心跳 |
| `transport.ts` | `providerError(raw, status, headers)`：把 HTTP 错误分类为 `LlmError` 码；解析 `Retry-After` |
| `listing.ts` | `parseModelListing` / `requestModelListing`（`/models`） |
| `defaults.ts` | 空闲超时 300 s、默认上下文 131072、默认输出上限 8192 |

## 行为

- `stream_options.include_usage` 打开用量汇报；`inputTokens = prompt_tokens − cached`，缓存命中单独记为 `cacheReadTokens`。
- 空闲看门狗：连续 300 s 没有数据 → `TIMEOUT`；调用方取消 → `ABORTED`；网络失败 → `TRANSPORT`。
- 终止原因映射：`length → max-tokens`、`tool_calls → tool-calls`、`stop` 但既无文本也无工具调用 → `EMPTY_RESPONSE`；流未给终止原因 → `STREAM_CLOSED`。
- 工具调用分片原样向上游产出，由 `BlockAssembler` 合并。

## 用法

```ts
const llm = new DeepSeekAdapter({
  connection: { baseUrl, apiKey, model: 'deepseek-chat', maxTokens: 8192 },
  retryPolicy: resolveRetryPolicy({ mode: 'normal' }, 'astra.llm.retryPolicy'),
})
for await (const chunk of llm.stream({ messages, tools, signal })) { /* ... */ }
```
