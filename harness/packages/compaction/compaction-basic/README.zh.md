# compaction-basic

默认压缩引擎：按阈值判断压力，裁剪工具结果，摘要较早历史，并处理服务端确认的上下文溢出。

## 文件

| 文件 | 内容 |
|---|---|
| `config.ts` | `BasicCompactionConfig`、默认值、`resolveCompactSpec` |
| `summarizer.ts` | `COMPACTION_INSTRUCTION`（八段式摘要指令）、`summarizeWithLlm` |
| `region.ts` | `selectCompactableRange`、`compactSurfaceRegion`（一次完整的“加锁→摘要→替换→解锁”） |
| `index.ts` | `BasicCompactionEngine` |

## 默认参数

| 字段 | 默认 | 含义 |
|---|---|---|
| `thresholdRatio` | 0.8 | 达到上下文窗口的 80% 开始压缩 |
| `headroomTokens` | 65536 | 在预算下方再留的余量 |
| `retainRatio` | 0.16 | 保留最近消息的预算比例 |
| `compactionRetries` | 1 | 仍超阈值时的额外摘要次数 |
| `maxOverflowRetries` | 1 | 溢出后的额外重试次数 |

`resolveCompactSpec`：`messageBudget = 窗口 − 输出上限`，`threshold = min(窗口×ratio, messageBudget − headroom)`，`retain = min(retainTokens ?? messageBudget×retainRatio, threshold−1)`。

## 行为

- `compactIfNeeded(agent, 'pressure')`：低于阈值直接返回；否则先做不调模型的工具结果裁剪，再选区间、摘要、替换；每次成功后重新测量。
- 尝试次数用尽仍超阈值时抛错（`agent-loop` 会提示并继续本轮）。
- `'context-overflow'`：跳过阈值与保留尾部，强制压缩一次平衡区间。
- `recoverFromOverflow(agent)`：每个 Agent 单独计数，只在实际缩小了 surface 时返回 `retry`；成功回复后由 `noteAssistantMessage` 清零。
- `compactNow`：手动压缩，要求 Agent 空闲、没有未闭合回合。
- `onCompaction(result, trigger)`：每次成功摘要后回调，供外壳展示。

## 摘要

摘要请求 = 系统提示词 + 工具 schema + 被压缩区间 + 固定的八段指令（主任务、关键技术概念、文件与代码、错误与修复、问题解决、所有用户消息、待办、当前工作）。输出为空、带工具调用或撞上输出上限都算失败，锁会以 `compaction/end {error}` 释放。
