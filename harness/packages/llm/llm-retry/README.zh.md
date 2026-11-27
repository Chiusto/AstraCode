# llm-retry

按供应商策略重试失败的模型请求，重试决定先落盘再等待。

## 接口

```ts
const decision = await retryRequest({ session, provider, policy, turn, step, failure, signal })
// decision → { retryId, retry, delayMs }；不重试时返回 undefined
```

辅助函数：`scheduledRetries(session, provider, policy)`（本步骤已重试次数）、`cancellableDelay(ms, signal)`（可被取消的等待）。

## 规则

- `normal` 模式：只重试 `retryableCodes` 中的错误（默认空回复、限流、5xx、超时、传输），每个步骤最多 `maxRetries` 次。
- `always` 模式：所有失败都重试，直到成功或被取消。
- 延迟 = `min(initial × 2^(retry−1), max) × (1 − jitter + 2 × jitter × random)`；服务端 `Retry-After` 不超过上限时直接采用，超过时 `normal` 模式放弃重试。
- 重试计数在 `step/start` 或 `turn/end` 时清零（`scheduledRetries` 扫描事件得到）。
- 事件顺序：先写 `llm/retry`，等待结束且未取消，再写 `llm/retry-started`；取消发生在等待中则不写第二条。

## 注意

与上游不同，这里没有“下游恢复链”：`agent-loop` 先尝试上下文压缩，再调用本包；`always` 模式也不会先咨询其他恢复策略。
