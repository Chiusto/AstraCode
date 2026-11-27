# session

会话的唯一真相：只追加的事件日志，加上一份“模型可见”的 surface 投影，以及 JSONL 落盘与恢复。

## 文件

| 文件 | 内容 |
|---|---|
| `types.ts` | `SessionEventMap`（全部事件类型与字段）、`SessionEvent`、`surfaceOp`、`surfaceMessageOf`、`RequestHeader`、`TurnEndReason`、`MessageSource` |
| `surface.ts` | `SessionSurface`：按 `seq` 顺序维护可见节点；`append` 追加，`{op:'replace'}` 用新事件替换一段旧节点并递增 `replaceGeneration` |
| `repair.ts` | 崩溃修复：`ToolCallRecovery`（跟踪未回答的工具调用）、`openTurnClosers` / `interruptedTurnClosers`（补齐 `tool/result`、`step/end`、`turn/end`） |
| `index.ts` | `Session` 与 `createSession` / `listSessions` / `resumeSession` |

## 用法

```ts
const session = createSession(dir, { alias: 'deepseek-chat', cwd })
session.append('user/message', { message, source: { kind: 'user' } }, { surfaceOp: 'append' })
session.messages          // 模型可见消息（按 surface 顺序）
session.usage()           // 累计 token（含压缩摘要）
session.requestHeader()   // 最近一次请求包络，供 token 估算与压缩使用
session.openTurn()        // 尾部未闭合的回合号，没有则 null
```

`resumeSession(dir, idOrPrefix, fallbackCwd)` 重放 JSONL，并在返回前补齐尾部未闭合的回合。旧格式（非事件日志）会话只出现在 `listSessions` 里（`legacy: true`），不能恢复。

## 约定

- 事件 `seq` 从 0 连续递增；`time` 为 epoch 毫秒。
- `surfaceOp: 'append'` 才进入模型历史；日志事件（`request/header`、`tool/call`、`turn/*` 等）只做审计与回放。
- 写盘失败被吞掉——磁盘问题不能让对话崩溃；内存状态仍然正确。
