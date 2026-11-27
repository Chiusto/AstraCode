# compaction

上下文压缩：把较早的历史摘要成一条 checkpoint，减少下一次请求的体积。所有动作先写事件（`compaction/start|summary|end|prune`）再改 surface，可回放、可审计。

| 包 | 职责 |
|---|---|
| [`compaction/`](compaction/README.zh.md) | 公共契约：`CompactionEngine`、`CompactionResult`、checkpoint 文本、工具调用配对校验、压缩锁、手动压缩错误码 |
| [`compaction-basic/`](compaction-basic/README.zh.md) | 默认引擎：压力阈值、保留尾部比例、摘要请求、溢出恢复 |
| [`compaction-tool-result-pruner/`](compaction-tool-result-pruner/README.zh.md) | 不调用模型的裁剪：把超长工具结果中间段替换为标记 |
| [`command-compact/`](command-compact/README.zh.md) | 交互命令 `/compact` 的实现（无参数、返回一行文本） |

## 一次摘要压缩

1. 估算下一次请求的 token（`token-meter`）。
2. 超过阈值时先裁剪超长工具结果；仍超阈值则选择可压缩区间：
   从尾部累计到保留预算，再向前移动切点，保证工具调用与结果成对。
3. 调模型生成摘要（`summarizeWithLlm`，固定指令），摘要必须比被替换内容更小。
4. 依次写 `compaction/start`（加锁）→ `compaction/summary` → 带 `surfaceOp: {op:'replace'}` 的
   checkpoint `user/message` → `compaction/end`；失败也要写 `compaction/end {error}` 解锁。

## 触发方式

- `pressure`：每步开始前自动检查（`compactIfNeeded`）。
- `context-overflow`：服务端返回上下文溢出 400 后，压缩并原样重发一次。
- `manual`：`/compact`（`compactNow`），要求 Agent 空闲且没有未闭合回合。
