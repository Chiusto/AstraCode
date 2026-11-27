# Astra CLI

终端里的对话式入口：一个能读写文件、跑命令、连续多轮调用工具的 agent 循环，直接跑在这个仓库上。

```text
› 看一下 harness/cli/src 里有哪些文件，说明各自职责

• Listed harness/cli/src
  └ 8 项
• src 目录下共 8 个文件：config 负责配置与 .env，models 管理 models.json，prompt 组装系统提示词……

  用时 2.1s
```

## 与上游的关系

`harness/packages/` 是从 deepseek-harness 的上游 `packages/` 移植的零依赖实现，按上游包名摆放：`llm`、`llm-deepseek`、`llm-retry`、`token-meter`、`session`、`agent`、`agent-loop`、`tools`、`tool-executor-native`、`system-prompt`、`compaction`、`compaction-basic`、`compaction-tool-result-pruner`、`command-compact`、`time-context`、`output-retention`。

`cli/` 只是应用层：

| CLI 文件 | 职责 |
|---|---|
| `index.ts` | 组合根：解析参数，构造适配器、压缩引擎、工具执行器与会话，分派交互/单次模式 |
| `src/config.ts` | `.env` 解析、选项、默认值 |
| `src/models.ts` | `models.json`：别名、地址、密钥引用 |
| `src/prompt.ts` | 系统提示词的段落组装（`assembleSystemPrompt` / `renderPrompt`） |
| `src/repl.ts` | readline 交互、斜杠命令、工具/回复渲染 |
| `src/render.ts` `select.ts` `waiting.ts` `secret.ts` | 纯终端表现层 |

核心逻辑都在 `packages/`：会话日志、轮次循环、重试、压缩、时间上下文。PTC 执行器（`tool-executor-ptc` / `run_code`）未移植，只提供原生工具调用。

## 运行

要求 Node.js ≥ 22.18（直接执行 `.ts`，无需编译）。

```bash
cd harness/cli

node index.ts                 # 交互式对话
node index.ts -p "解释这个仓库的结构"   # 单次问答，回答写到 stdout
node index.ts --session <id>  # 恢复历史会话
```

API Key 从 `AstraCode/.env` 的 `DEEPSEEK_API_KEY` 读取（也接受同名环境变量），无需额外配置。

## 交互命令

提示符下敲 `/` 就会**立刻弹出命令菜单**，不用先记住命令名：输入即筛选（前缀 / 包含 / 模糊三档排序），`↑↓` 选择，`Enter` 确认，`Esc` 取消。选中带参数的命令会继续弹出候选列表，例如 `/model`、`/key`、`/resume`、`/cd`。完整命令仍然可以直接手敲。

| 命令 | 作用 |
|---|---|
| `/help` | 帮助 |
| `/new` | 开新会话，旧会话已自动落盘 |
| `/model` | 弹菜单：切换模型 / 添加 / 删除 / 手动输入 model id |
| `/model remote` | 查询服务端可用模型列表 |
| `/key [别名]` | 设置某个模型的 API Key（不带别名时弹选择） |
| `/cd [dir]` | 切换工作目录（不带参数时弹目录菜单，可逐级向下） |
| `/compact` | 把较早的对话压缩成摘要（手动压缩，自动压缩见下文） |
| `/tools` | 列出工具 |
| `/session` `/sessions` `/resume <id>` | 当前会话 / 历史列表 / 恢复（弹会话选择） |
| `/usage` | 本会话累计 token |
| `/exit` | 退出（等同 Ctrl+D） |

`Esc` 或 `Ctrl+C` 在回答过程中中断本轮（已产生的文本会保留）；提示符下 `Ctrl+C` 有输入时先清空、空行时退出。

## 界面

启动后是照 Codex CLI 0.156 复刻的终端界面：

```text
╭───────────────────────────────────────────────╮
│ >_ Astra CLI (v0.1.0)                         │
│                                               │
│ model:     deepseek-chat   /model to change   │
│ directory: D:\CodeSpace\AstraCode             │
╰───────────────────────────────────────────────╯

  描述一个任务开始，或试试这些命令：

  /model - 切换或添加模型
  /compact - 把较早的对话压缩成摘要
  /resume - 恢复历史会话
  /cd - 切换工作目录
  /help - 查看全部命令

› 问问 Astra，或描述一个任务

  deepseek-chat default · D:\CodeSpace\AstraCode
  ? 查看命令                                                     100% 上下文剩余
```

一轮对话：

```text
› 用 run_terminal 执行 echo hi，然后汇报

• Ran echo hi
  └ exit 0 · hi
    hi
• 已执行 `echo hi`，输出 `hi`，退出码 0。

  用时 1.5s

  deepseek-chat default · D:\CodeSpace\AstraCode
  ? 查看命令                                                     100% 上下文剩余
```

- 启动头是圆角卡片：内容宽 `min(终端−4, 56)`，边框在内容外各留一格；里面依次是 `>_ 标题 (v版本)`、空行、`model:` 与 `directory:` 两行，标签按 `directory:` 的宽度对齐，`/model` 用天蓝色标出。路径过长时中间省略，保持结尾可见。
- 空输入框显示灰色占位符，首个字符落下即消失；光标始终停在占位符之前，`›` 用天蓝色。
- 输入框上方两行是页脚：`模型 default · 目录` 与 `? 快捷键`，右侧按上一次请求的 token 估算剩余上下文（`ASTRA_CONTEXT_WINDOW`）。readline 无法在输入行下方维护常驻页脚，所以这两行放在上方，每次回到提示符时重画。
- 等待模型时显示 `• 思考中 (1s · esc 中断)`，每秒更新计时，首个字到达即清除。
- 模型回复每条以灰色 `•` 开头，续行缩进 2 格；不渲染 Markdown，原样输出。回合结束是一行 `用时 Ns`（token 用量看 `/usage`）。
- 工具调用用 `• 动词 参数` + `└ 结果` 两行结构（动词：Ran / Read / Wrote / Edited / Listed）；`write_file` / `edit_file` 直接渲染红绿 diff（最多 14 行，超出折叠）。
- 普通输出只展示前 4 行，超出折叠为 `… 还有 N 行`，完整内容仍会发给模型。出错用红色 `■`。
- `Esc` 中断本轮，`Ctrl+C` 在空行退出、有输入时先清空当前行。
- 敲 `/` 直接进命令菜单（输入即筛选），`Tab` 仍可补全斜杠命令；上下键翻阅历史，历史跨会话保存在 `sessions/.history`。
- 菜单标题以 `›` 开头、选中项用 `❯` 标出；`Esc` 取消后回到普通输入，不会留下残影；无匹配项时 `Enter` 不确认，退格继续修改。
- 敲 `/` 后输入行本身不动：`› /` 钉在原位并随筛选词就地增长（`› /mo`），菜单只在这行**下方**展开，光标始终回到输入行末尾；`Esc` 收起菜单后只重画输入行，不会把页脚再叠一遍。

## 模型与密钥

模型配置存在 `models.json`（已在 `.gitignore` 中，可放心写密钥）：

```json
{
  "default": "deepseek-chat",
  "models": [
    {
      "alias": "deepseek-chat",
      "model": "deepseek-chat",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "env:DEEPSEEK_API_KEY"
    },
    {
      "alias": "v4-pro",
      "model": "deepseek-v4-pro",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "sk-..."
    }
  ]
}
```

- `apiKey` 写 `env:名称` 表示运行时从环境变量或 `AstraCode/.env` 读取；写 `sk-...` 则直接存明文（文件权限 0600，且不会进版本库）。
- 首次启动会自动生成一份指向 `env:DEEPSEEK_API_KEY` 的默认条目，不需要手写。
- 新增模型直接 `/model add` 走一遍向导；只换密钥用 `/key <别名>`，只改配置直接编辑文件后 `/model` 重新加载即可。
- 切换模型会写回 `default`，下次启动沿用；`-m` 或 `ASTRA_AGENT_MODEL` 优先于它。
- 没配密钥时仍能进交互界面，发消息会被拦下并提示 `/key`；单次模式（`-p`）则直接报错退出。

## 工具与确认

| 工具 | 说明 | 需要确认 |
|---|---|---|
| `run_terminal` | 在工作目录执行 shell 命令（Windows 上优先用 bash），可设 `timeout_ms` | 是 |
| `read_file` | 带行号读取文本文件，支持 `offset` / `limit` | 否 |
| `write_file` | 新建或整体覆盖文件，自动建目录 | 是 |
| `edit_file` | 精确替换片段，多处匹配时会拒绝 | 是 |
| `list_dir` | 列目录，目录优先 | 否 |

交互模式下每次写操作都会询问 `y/N/a`（`a` 表示本会话剩余调用全部允许）。加 `-y` 全部自动执行；`-p` 单次模式因没有交互界面，默认自动执行。

## 选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `-p, --print <text>` | — | 单次问答 |
| `-m, --model <id>` | `models.json` 的 default | 别名或原始 model id |
| `-C, --cwd <dir>` | 当前目录 | 工作目录 |
| `--session <id>` | — | 恢复会话（id 或前缀） |
| `--system <text>` | — | 追加系统提示词 |
| `--max-tokens <n>` | 8192 | 单次回复上限 |
| `--max-steps <n>` | 24 | 单轮工具步数上限 |
| `-y, --yes` | 交互模式关闭 | 自动执行所有工具 |
| `--ask` | — | 强制每次写操作都确认 |
| `--no-color` | 自动检测 | 关闭颜色 |
| `--repl` | — | 强制交互界面（stdin 不是终端时便于测试） |

环境变量：`DEEPSEEK_API_KEY`（可被 `env:` 引用）、`DEEPSEEK_BASE_URL`、`ASTRA_AGENT_MODEL`、`ASTRA_MAX_TOKENS`、`ASTRA_MAX_STEPS`、`ASTRA_TEMPERATURE`、`ASTRA_SESSION_DIR`、`ASTRA_SYSTEM_EXTRA`、`ASTRA_MODELS_FILE`（默认 `cli/models.json`）、`ASTRA_CONTEXT_WINDOW`（默认 131072）、`ASTRA_AUTO_COMPACT`（`0` 关闭自动压缩）、`ASTRA_COMPACT_THRESHOLD`（默认 0.8）、`ASTRA_COMPACT_RETAIN`（默认 0.16）、`ASTRA_COMPACT_HEADROOM`（默认 65536）、`ASTRA_COMPACT_MAX_TOKENS`（摘要请求上限）、`ASTRA_TIME_CONTEXT`（`0` 关闭每步时间提示）。

## 压缩与重试

- 每次请求前测量上一条请求的体积（启发式 chars/4，中文会低估），超过阈值（`min(窗口×0.8, 窗口−输出上限−headroom)`）先裁剪超长工具结果，再摘要较早历史：保留最近约 16% 的消息预算，其余替换为一条 checkpoint 消息。整个过程写在会话日志里（`compaction/start|summary|end`），可回放。
- 服务端返回上下文溢出（HTTP 400 且文案匹配）时，先压缩再原样重发一次；仍失败才报错。
- 传输失败、限流、5xx、超时、空回复按指数退避重试（0.5s 起，上限 10s，最多 5 次；尊重 `Retry-After`），每次重试先写 `llm/retry` 再写 `llm/retry-started`。
- 每步开始前注入一条 `time-context` 用户消息（默认 10 分钟刷新一次），让模型知道当前时间，又不会污染可缓存的系统提示词。

## 会话文件

每次对话写入 `sessions/<时间戳>-<随机>.jsonl`，一行一个事件：`cwd`、`model/selection`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`turn/start|end`、`step/start|end`、`request/header`、`llm/retry`、`compaction/*`。带 `surfaceOp: "append"` 或 `replace` 的事件进入模型可见历史；恢复时按事件重放，若尾部停在未闭合的回合（崩溃、被杀），会补上 `tool/result`、`step/end`、`turn/end {reason: interrupted}` 后再继续。

## 目录

```text
cli/
├── index.ts          # 入口：参数解析 + 组合根 + 单次模式
├── package.json
└── src/
    ├── config.ts     # .env 解析、选项、默认值
    ├── models.ts     # models.json：别名、地址、密钥引用
    ├── prompt.ts     # 系统提示词段落
    ├── render.ts     # 颜色、工具块、用量行
    ├── repl.ts       # readline 交互与斜杠命令
    ├── select.ts     # 菜单选择器
    ├── secret.ts     # 密钥输入（不回显）
    └── waiting.ts    # 等待指示器（圆点 + 计时）
```
