# system-prompt

有序段落拼装：每段有唯一名字与顺序，文本可以是常量，也可以是每次组装时求值的函数。

## 用法

```ts
const prompt = assembleSystemPrompt([
  { name: 'role', order: 10, text: '你是……' },
  { name: 'environment', order: 20, text: () => `工作目录：${config.cwd}` },
])
renderPrompt(prompt) // 段落间空一行
```

## 规则

- `order` 升序；相同 `order` 按名字排序。
- 名字重复直接抛错，避免静默覆盖。
- 每段先求值再 `trim()`，空段丢弃。
- 函数式段落让 `/cd`、`/model` 这类运行时变化立即反映到下一条请求。

系统提示词不写进模型可见历史，而是随 `request/header` 事件记录，仅用于回放与 token 估算，这样每次请求都不会在历史里多一条 `system` 消息。
