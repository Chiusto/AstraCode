# tools

内置工具集、工具契约和有界输出。

## 文件

| 文件 | 内容 |
|---|---|
| `contracts.ts` | `ToolDefinition`、`ToolResult`、`ToolContext`、`ToolExecutor`、`ToolExecutionResult`、错误码（`ABORTED`、`ABORTED_BEFORE_DISPATCH`、`APPROVAL_REJECTED`）、`ToolNotFoundError` |
| `index.ts` | `createTools()` 与五个工具的实现、`toolSchemas()` |
| `presentation.ts` | `retainText()` 与 `TERMINAL_OUTPUT_BYTES`：命令输出按 32 KiB 头 + 8 KiB 尾保留并附省略说明 |

## 工具

| 名称 | 参数 | 需确认 |
|---|---|---|
| `run_terminal` | `command`（必填）、`cwd`、`timeout_ms`（默认 120000，上限 600000） | 是 |
| `read_file` | `path`（必填）、`offset`（1 起）、`limit`（默认 2000 行） | 否 |
| `write_file` | `path`、`content` | 是 |
| `edit_file` | `path`、`old_string`、`new_string`、`replace_all` | 是 |
| `list_dir` | `path`（缺省为会话 cwd） | 否 |

工具只返回纯文本（`content`）、一行摘要（`summary`）、成功/失败标记，以及可选的 `diff`（供终端渲染）。文件工具限制单文件 2 MB；命令在 Windows 上优先用 Git Bash，保证与 Linux 方言一致。

“需确认”由执行器的 `approve` 回调决定，工具本身不询问。
