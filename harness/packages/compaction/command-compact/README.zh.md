# command-compact

`/compact` 命令的核心：无参数、手动压缩一次，返回一段文字。

## 接口

```ts
const outcome = await executeCompact(compaction, agent, rawInput, signal)
// { kind: 'success' | 'error', text }
```

- 带参数时返回 `Usage: /compact (no arguments)`。
- 没有可压缩历史 → `No compactable history yet.`
- 成功 → `Compacted N history items (~T tokens).`
- `ManualCompactionError` 按 `code` 转成简短说明（`busy`、`cancelled`、`changed`、`summary`、`commit`、`persistence`）；取消（signal 已中止）也按取消处理。

调用方（CLI）负责把它挂到命令菜单里，并保证调用时 Agent 空闲——压缩本身要求没有未闭合回合。
