# compaction-tool-result-pruner

不调用模型的裁剪：把过长的工具结果保留头尾，中间替换为固定标记。

## 文件

| 文件 | 内容 |
|---|---|
| `config.ts` | `PRUNE_MARKER`、默认预算（阈值 8192 字符、头 4096、尾 1024）、`codePointLength` |
| `types.ts` | `ToolResultPruneConfig`、`PrunedEntry`、`PruneResult` |
| `index.ts` | `ToolResultPruner` |

## 用法

```ts
const pruner = new ToolResultPruner()          // 或传入 Partial<ResolvedConfig>
pruner.pruneContent(text)                      // 超阈值返回裁剪结果，否则 null
pruner.pruneSession(session, meter)            // 扫描整份会话，落盘替换
```

`pruneSession` 对每个超阈值的工具结果：

1. 追加 `compaction/prune`（记录 shadowed 区间、seqs 与 token 价格）；
2. 追加一条新的 `tool/result`，`surfaceOp: { op: 'replace', startSeq, endSeq }` 替换原结果。

计数以 Unicode 码点为单位，切点不会劈开代理对。`PRUNE_MARKER` 文字是给模型看的：“中间部分已裁剪”。
