# llm

模型调用相关：供应商无关的接口与流式组装、DeepSeek 具体适配器、请求失败重试、请求体积估算。

| 包 | 职责 |
|---|---|
| [`llm/`](llm/README.zh.md) | 接口 `Llm`、消息/工具/流事件类型、`BlockAssembler`、`LlmError` 失败分类、重试策略解析 |
| [`llm-deepseek/`](llm-deepseek/README.zh.md) | `api.deepseek.com` 的 chat/completions 流式适配器、SSE 解析、HTTP 错误分类、模型列表 |
| [`llm-retry/`](llm-retry/README.zh.md) | 指数退避重试：写 `llm/retry` 事件 → 等待 → 写 `llm/retry-started` |
| [`token-meter/`](token-meter/README.zh.md) | 启发式 token 估算，给压缩判断压力用 |

## 数据流

1. `agent-loop` 把 `Session.messages` 与工具 schema 交给 `Llm.stream()`。
2. `llm-deepseek` 解析 SSE，把文本、推理、工具调用分片和终止原因作为 `StreamChunk` 逐块产出。
3. `BlockAssembler` 把分片拼成一条完整回复（文本 + 工具调用 + 用量 + 终止原因）。
4. 失败时：适配器抛 `LlmError`（带 `code`，如 `RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED`、`TRANSPORT`）；`llm-retry` 或压缩引擎决定重试。

## 约定

- `TokenUsage` 的 `inputTokens` 是**未命中缓存**的输入，`cacheReadTokens` 单独计数，两者不重叠。
- 重试策略由供应商配置持有（`Llm.retryPolicy`），默认 `normal` 模式只重试瞬时失败。
- `token-meter` 只是估算（约 4 字符/token），中文会被低估；真正的兜底是服务端 400 → 压缩 → 重发。
