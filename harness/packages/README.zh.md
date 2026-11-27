# packages

从 deepseek-harness 移植的零依赖 TypeScript 实现，按上游 `packages/` 的包名摆放。没有 `node_modules`，Node ≥ 22.18 直接执行 `.ts`；包之间用显式相对路径导入（带 `.ts` 后缀）。cordis 服务层没有搬，服务注入改为构造参数或普通函数。

## 分组

| 分组 | 内容 |
|---|---|
| [`llm/`](llm/README.zh.md) | 供应商无关的模型接口、DeepSeek 适配器、重试策略、token 估算 |
| [`core/`](core/README.zh.md) | 会话事件日志、Agent、回合循环、工具与执行器、系统提示词 |
| [`compaction/`](compaction/README.zh.md) | 上下文压缩的契约、摘要引擎、工具结果裁剪、`/compact` 命令 |
| [`context/`](context/README.zh.md) | 每步注入的时间上下文 |
| [`util/`](util/README.zh.md) | 有界输出裁剪（工具结果、命令输出） |

## 依赖方向

```
util/output-retention ← core/tools
llm/llm ← llm/llm-deepseek, llm/llm-retry, llm/token-meter, compaction-basic, agent-loop
core/session ← core/agent, core/agent-loop, token-meter, llm-retry, compaction/*
core/agent ← core/agent-loop, compaction/*
core/tools ← core/tool-executor-native, agent-loop
compaction/compaction ← compaction-basic, command-compact
context/time-context ← agent-loop
```

`core/agent-loop` 处在最上层：它把会话、模型、工具、压缩和时间上下文串成一个回合。

## 组合方式

`harness/cli/index.ts` 是唯一的组合根：构造 `DeepSeekAdapter`、`TokenMeter`、`ToolResultPruner`、`BasicCompactionEngine`、`NativeToolExecutor` 和 `Session`，再交给 `runTurn`。包本身不读环境变量，也不写终端。

## 每个包的约定

- `src/index.ts` 是该包的公开入口，其余文件是内部实现（需要测试或复用时可单独导入）。
- 会话可见的变化都先写成 `Session` 事件（可回放的 JSONL），再改内存状态。
- 面向模型的文案（错误提示、压缩摘要指令、崩溃恢复说明）保持与上游一致的英文措辞。
