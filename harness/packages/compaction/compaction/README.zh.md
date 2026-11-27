# compaction

压缩的公共契约：引擎接口、结果类型、checkpoint 文本、配对校验、压缩锁与手动压缩错误。

## 文件

| 文件 | 内容 |
|---|---|
| `types.ts` | `CompactionResult`、`CompactionTrigger = 'pressure' \| 'context-overflow'` |
| `checkpoint.ts` | `CHECKPOINT_PREAMBLE`、`<compacted-summary>` 标签、`frameSummary()`、`isCheckpointMessage()`、`compactCheckpointSource()` |
| `tool-pairing.ts` | `toolPairingBalancedBefore/After`：切点两侧的助手工具调用与结果是否成对 |
| `index.ts` | `CompactionEngine` 接口、`ManualCompactionError`（`busy`/`cancelled`/`changed`/`summary`/`commit`/`persistence`）、`activeCompactionStart`、`assertNoActiveCompaction` |

## 引擎接口

```ts
interface CompactionEngine {
  compactIfNeeded(agent, trigger, signal): Promise<CompactionResult | null>
  compactRegion(start, end, agent, signal?): Promise<CompactionResult>
  compactNow(agent, signal): Promise<CompactionResult | null> // /compact
  noteAssistantMessage?(agent): void
}
```

`CompactionResult.shadowedRange` 是 **surface 位置**，不是 seq 区间：先前的替换会把高 seq 的 checkpoint 放在旧位置上，所以 `start` 可能大于 `end`。`shadowedSeqs` 才是被替换节点的 seq 列表。

## 配对校验

压缩切点如果落在一次工具调用中间，模型会收到“有 `tool_calls` 却没有结果”的历史并报错。两个函数沿 surface 维护配对余额（缓存按 `replaceGeneration` 失效），把切点向前/向后挪到合法位置。

## 锁

`compaction/start` 到配对的 `compaction/end` 是全局压缩锁；`assertNoActiveCompaction` 在第二次压缩并发时抛出 `ManualCompactionError('busy')`。
