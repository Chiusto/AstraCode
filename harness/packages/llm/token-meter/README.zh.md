# token-meter

估算“下一次请求会带多少 token”，供压缩判断压力。

## 接口

```ts
const meter = new TokenMeter()
const { totalTokens, nodes } = meter.measure(session, header?)
```

- `header` 缺省时使用 `session.requestHeader()`；`totalTokens` = 系统提示词 + 工具 schema + 所有可见消息。
- `nodes` 按 surface 顺序给出每个节点的估算值，压缩据此选择区间。
- `estimateMessage` / `estimateSystemMessage` / `estimateToolsTokens`（在 `estimate.ts`）也可单独使用。

## 启发式

- 约 4 个字符/token，每条消息固定开销 4，工具 schema 按其 JSON 长度估算。
- 中文约 1–1.5 字/token，会被低估；所以阈值只是“提前量”，真正的兜底是服务端 400 → 压缩 → 重发。
- 这只是估算，不调用 tokenizer，也不需要网络。
