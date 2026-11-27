# agent

Agent 的最小词汇：一个 Agent 拥有一个 Session，记录请求参数和运行状态。

## 文件

| 文件 | 内容 |
|---|---|
| `types.ts` | `Agent { id, session, options, status }`、`AgentOptions { model?, maxTokens?, temperature? }`、`ModelSelection`、`AgentStatus = 'idle' \| 'running'`、`RequestErrorAction` |
| `index.ts` | `createAgent(session, options?)`、`runExclusive(agent, work)` |

## 用法

```ts
const agent = createAgent(session)
await runExclusive(agent, () => runTurn(agent, input, options, hooks))
```

`runExclusive` 在运行时把 `status` 置为 `running`，结束后恢复 `idle`；对已在运行的 Agent 再次调用会直接抛错。手动压缩（`/compact`）要求 Agent 空闲，所以它不包在 `runExclusive` 里。

`AgentOptions` 只覆盖单个 Agent 的请求参数；具体走哪个供应商/模型由组合根传入的 `ModelSelection` 决定。
