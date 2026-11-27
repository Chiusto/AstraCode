# context

请求准备阶段注入的上下文。

| 包 | 职责 |
|---|---|
| [`time-context/`](time-context/README.zh.md) | 每步开始前追加一条带时间的用户消息（默认 10 分钟刷新一次） |

只按需注入的原因：系统提示词参与缓存，写进时间会让前缀每次都变；时间作为一条独立的 `user/message`（`source.kind = "time-context"`）进入历史，既能让模型知道当前时间，又不破坏缓存和回放。

没有移植上游的浏览器时区探测（request-zone），只用进程时区。
