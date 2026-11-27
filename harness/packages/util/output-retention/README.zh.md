# output-retention

有界输出：只回答“保留了什么、省略了多少”，业务措辞由调用方负责。

## 两个保留器

| 类型 | 适用 | 策略 |
|---|---|---|
| `ItemRetainer<T>` | 有序条目（文件路径、grep 命中、来源） | `head`：保留前 `maxItems` 条 |
| `TextRetainer` | 字节流（命令输出、网页正文） | `head` / `tail` / `headTail`，按字节计数 |

```ts
const retainer = new TextRetainer({ kind: 'headTail', headBytes: 32_768, tailBytes: 8_192 })
retainer.push(chunk)            // { kept, truncated }
const { text, truncated, omittedBytes } = retainer.finish()
```

## 保证

- `finish()` 在切点回退到 UTF-8 边界，返回文本不会出现替换字符。
- 后缀只在内存里滚动保留 `tailBytes`，大流不会无限增长。
- `omittedBytes` 按**实际返回**的字节数计算（含边界回退），不虚报。
- `formatRetentionNotice(notice, recovery)` 组合“省略了多少”和调用方给的恢复提示；`truncateWithoutSplittingSurrogatePair` 用于按 UTF-16 长度裁剪时避免半个代理对。

`core/tools` 用它把命令输出裁成 32 KiB 头 + 8 KiB 尾。
