# core

Agent 运行时：会话日志、Agent 标识、回合循环、工具与执行器、系统提示词组装。

| 包 | 职责 |
|---|---|
| [`session/`](session/README.zh.md) | 只追加的事件日志 + 模型可见 surface（`append` / `replace`）+ 崩溃尾部修复 + JSONL 落盘 |
| [`agent/`](agent/README.zh.md) | `Agent = session + options + status`，`createAgent`、`runExclusive` |
| [`agent-loop/`](agent-loop/README.zh.md) | `runTurn`：回合/步骤边界、工具批处理、重试、压缩、时间上下文、取消 |
| [`tools/`](tools/README.zh.md) | 内置工具（命令、读写文件、列目录）与工具契约 |
| [`tool-executor-native/`](tool-executor-native/README.zh.md) | 原生执行器：参数解析、未知工具、审批、错误转结果 |
| [`system-prompt/`](system-prompt/README.zh.md) | 有序段落的组装与渲染 |

## 一回合的生命周期

```
user/message → turn/start
  → [每步] 压缩检查 → 时间读数 → step/start
      → request/header → 模型流式回复 → assistant/message
      → tool/call → 工具执行 → tool/result
      → step/end
  → turn/end {completed | aborted | max-tokens | error | interrupted}
```

除 `request/header`、`tool/call`、`turn/*`、`step/*` 等日志事件外，带 `surfaceOp` 的事件进入模型可见历史；`replace` 用于压缩后的 checkpoint。

## 约定

- 任何“模型看到的历史”都能由事件日志重放得到，内存里的 `Session` 只是投影。
- 步骤失败或取消时，必须补齐未回答的工具调用，否则下一次请求会因 `tool_calls` 不成对而失败。
- 崩溃后恢复会话时，尾部未闭合的回合由 `session/repair.ts` 补合成事件。
