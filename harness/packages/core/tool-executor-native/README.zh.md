# tool-executor-native

原生工具执行器：模型给什么就按顺序执行什么，不经过代码生成或沙箱。

## 接口

```ts
const executor = new NativeToolExecutor({
  approve: async (tool, call) => boolean, // 仅 mutating 工具会询问
})
const { results } = await executor.execute({ calls, signal, cwd }, tools)
```

`describe(tools)` 返回发给模型的 schema 与已知工具名。

## 失败如何转成结果

模型不会看到异常，只会看到一条 `tool` 消息：

| 情况 | `content` | `error.code` |
|---|---|---|
| 调用前已被取消 | `The tool call was cancelled before it started.` | `ABORTED_BEFORE_DISPATCH` |
| 未知工具 | `unknown tool "..."` | `UNKNOWN_TOOL` |
| 参数不是 JSON 对象 | 参数错误说明 | `INVALID_TOOL_ARGUMENTS` |
| 用户拒绝 | `The user declined this tool call.` | `APPROVAL_REJECTED` |
| 工具体抛错 | 错误信息（取消时换成取消说明） | `ABORTED` 或错误自身信息 |
| 工具体返回失败但没带 `error` 字段 | 原 `content` | 用 `content` 兜底补充 |

执行严格按模型给出的顺序串行进行；一次调用失败不影响后续调用。
