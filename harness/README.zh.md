---
description: "harness 工作区索引：packages 为从上游移植的零依赖实现，cli 为可直接运行的终端对话入口。"
kind: "workspace-index"
---
# harness

```
harness/
├── packages/   从 deepseek-harness 移植的零依赖实现（llm / core / compaction / context / util）
└── cli/        终端外壳：参数、渲染、斜杠命令（组合根 + UI）
```

| 目录                                     | 内容                                                                                     | 能否直接运行        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------- |
| [`packages/`](packages/README.zh.md)     | `llm/*`、`core/*`、`compaction/*`、`context/time-context`、`util/output-retention`        | 作为库被 `cli` 引用 |
| [`cli/`](cli/README.zh.md)                | 组合根（会话、模型注册表、压缩引擎、工具执行器）+ readline 交互界面                       | 能：`node harness/cli/index.ts` |

## 快速开始

```bash
node harness/cli/index.ts                     # 交互式对话
node harness/cli/index.ts -p "解释 packages/core 的职责"   # 单次问答
node harness/cli/index.ts --session <id>      # 恢复会话
```

要求 Node ≥ 22.18（直接执行 `.ts`，无需编译，也没有 `node_modules`）；API Key 读 `AstraCode/.env` 的 `DEEPSEEK_API_KEY`。命令、工具、会话恢复等细节见 [cli/README.zh.md](cli/README.zh.md)。

## 包结构

| 组 | 包 |
|---|---|
| `llm/` | `llm`（接口、组装、失败分类、重试策略）、`llm-deepseek`（chat/completions 流式适配器）、`llm-retry`（退避与 `llm/retry` 事件）、`token-meter`（启发式 token 估算） |
| `core/` | `session`（事件日志 + surface + 崩溃修复）、`agent`、`agent-loop`（轮次/步骤循环）、`tools`、`tool-executor-native`、`system-prompt` |
| `compaction/` | `compaction`（契约与配对校验）、`compaction-basic`（压力/溢出压缩）、`compaction-tool-result-pruner`、`command-compact`（`/compact`） |
| `context/` | `time-context`（每步时间读数） |
| `util/` | `output-retention`（有界输出裁剪） |

## 相对上游的改动

- 移除 cordis：服务注册、`ctx.*` 注入改为构造参数与普通函数；`agent-loop` 不搬队列与流帧，`runTurn` 一次跑完一个用户回合。
- 消息保持 chat-completions 的扁平结构（`content` 字符串），不搬上游内容块；因此 `system/message` 也不搬，系统提示词记录在 `request/header` 事件里。
- 未移植 PTC（`tool-executor-ptc` / `run_code`）、`scope`、`fork`、`modelPolicies`、request-zone 等。
- 目录与包名沿用上游 `packages/` 的摆放方式，相对导入按本地层级显式写 `.ts`。
