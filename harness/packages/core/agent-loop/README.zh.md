# agent-loop

一个用户回合的驱动器：调模型、跑工具、按需压缩、处理取消与失败。

## 文件

| 文件 | 内容 |
|---|---|
| `agent.ts` | `runTurn(agent, { text, signal }, options, hooks)` 全部实现 |
| `index.ts` | 公开导出与类型 |

## 选项

```ts
await runTurn(agent, { text, signal }, {
  llm,                        // Llm 适配器
  tools,                      // ToolDefinition[]
  executor,                   // ToolExecutor（通常 NativeToolExecutor）
  systemPrompt: () => string, // 每次请求现取，/cd、/model 立即生效
  selection: { provider, model },
  maxSteps: 24,
  maxTokens, temperature,
  compaction,                 // 可选：压力/溢出压缩
  timeContext: {},            // 可选：每步时间读数；false 关闭
  retry,                      // 可选：覆盖默认 retryRequest
}, hooks)
```

## 一回合做了什么

1. 追加 `user/message` 与 `turn/start`。
2. 每步：压缩检查（失败只提示不中断）→ 时间读数 → `step/start`；记录 `request/header`（相同包络去重）。
3. 流式请求，`BlockAssembler` 收集文本与工具调用；写 `assistant/message`（带用量）。
4. 有工具调用时：写 `tool/call` → 执行 → 按顺序写 `tool/result`（失败内容加 `Error: ` 前缀并带结构化 `error`），进入下一步。
5. 失败处理：上下文溢出先压缩再重发一次；其余按重试策略退避；都不行则抛 `LlmError`，回合以 `error` 结束。
6. 取消时保留已产生的文本（`interrupted: true`），并给未执行的工具调用补合成结果。
7. 以 `turn/end {completed | max-tokens | aborted | error}` 收尾；达到 `maxSteps` 时通过 `hooks.onNotice` 提示。

## Hooks

| 回调 | 时机 |
|---|---|
| `onThinking(turn, step)` | 每次请求前（用于 spinner） |
| `onText` / `onReasoning` | 流式增量 |
| `onToolCall` / `onToolResult` | 工具执行前后 |
| `onNotice` | 压缩失败、步数上限等非致命提示 |

返回 `TurnResult { ok, aborted, steps, seconds, usage }`。`usage` 只统计本回合的模型调用。
