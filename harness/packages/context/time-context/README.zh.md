# time-context

每步开始前，把当前时间作为一条独立的用户消息注入历史。

## 文件

| 文件 | 内容 |
|---|---|
| `timestamp.ts` | `createTimestampFormatter`、`formatTimestamp`（`2026-11-27T09:30:00+08:00[Asia/Shanghai]`） |
| `index.ts` | `injectTimeContext`、`timeContextState`、`renderText`、`formatDuration` |

## 用法

```ts
injectTimeContext(agent, turn, step, { refreshIntervalMs: 600_000 })
```

- 注入内容：`Time sampled while preparing turn T, step S: <时间戳>` + `Elapsed since the preceding model-visible message|step context: 1h 2m 3s.`
- 消息标记为 `source.kind = 'time-context'`，压缩时可以和普通用户消息一起被摘要。
- 默认 600000 ms 内不重复注入；`refreshIntervalMs: 0` 表示每步都注入。
- 状态由会话事件折叠得到：`turn/start` 清空本轮注入时间，`user/message` 记录最后一条消息时间。

## 与上游的差异

没有移植浏览器时区探测（request-zone）：只使用进程时区或配置里的 `timeZone`，文案里也没有浏览器那一行。
