# llm

供应商无关的模型接口，是所有适配器的“插口”。

## 文件

| 文件 | 内容 |
|---|---|
| `types.ts` | `Message`、`ToolSchema`、`ToolCall`、`TokenUsage`、`StreamChunk`、`GenerateOptions`、`FinishReason` |
| `error.ts` | `LlmError` / `LlmFailure`、错误码（`AUTH`、`QUOTA`、`RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REQUEST`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE`、`ABORTED`、`HTTP_<n>`）、`toLlmFailure`、配额/上下文溢出文案识别、`errorChain` |
| `retry-policy.ts` | `resolveRetryPolicy`、默认值（最多 5 次、500 ms 起、10 s 上限、10% 抖动） |
| `assembler.ts` | `BlockAssembler`：把流式分片拼成完整回复 |
| `message.ts` | `createAssistantMessage(text, toolCalls)` |
| `index.ts` | `Llm` 接口与统一导出 |

## 接口

```ts
interface Llm {
  provider: string
  model: string
  contextWindow: number
  defaultMaxTokens: number
  retryPolicy?: ResolvedRetryPolicy
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
```

## 约定

- 适配器自己决定何时抛出 `LlmError`，调用方只按 `code` 决定重试、压缩或报错。
- `BlockAssembler` 容忍任意分片方式；流提前关闭且没有终止原因时，按 `STREAM_CLOSED` 处理。
- 工具调用分片按 `index` 合并；缺 id 时补 `call_<index>`，缺参数时补 `{}`。
- `TokenUsage.inputTokens` 与 `cacheReadTokens` 互不重叠。
