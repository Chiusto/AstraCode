"""agent 各层共享的数据类型。

``ToolSpec``、``ToolCall``、``ToolResult``、``AgentConfig``、``AgentResult``
等 dataclass 都带属性；请按原样使用它们（不要重命名字段）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Literal, Optional

Message = dict  # {"role": "system" | "user" | "assistant", "content": str}

# 模型调用采用这种形状：输入一个消息列表，输出回复文本。它背后没有
# 工具调用或结构化输出功能。
LMCallable = Callable[[list[Message]], str]


# ---------------------------------------------------------------- tools ----

Status = Literal["ok", "unknown_tool", "invalid_args", "tool_error", "denied"]


@dataclass
class ToolSpec:
    """注册表为一个工具保存的全部信息。"""

    name: str
    description: str
    parameters: dict  # 描述参数的 JSON Schema 对象
    fn: Callable[..., Any]  # 以 fn(**args) 调用；其返回值会经 str() 转换
    read_only: bool = False


@dataclass
class ToolCall:
    name: str
    args: dict = field(default_factory=dict)


@dataclass
class ToolResult:
    status: Status
    content: str


@dataclass
class ParsedResponse:
    """parse_response 从一条模型回复中提取出的内容。"""

    text: str
    tool_call: Optional[ToolCall] = None
    error: Optional[str] = None


# ---------------------------------------------------------------- agent ----

# 对 agent 的一次调用为什么停止。
#   "done"          模型给出了最终答案
#   "max_turns"     针对这条用户消息的模型调用预算耗尽
#   "token_budget"  针对这条用户消息的 token 预算耗尽
#   "malformed"     连续出现格式错误的回复次数过多
StopReason = Literal["done", "max_turns", "token_budget", "malformed"]


@dataclass
class AgentResult:
    text: str  # 展示给用户的内容
    status: StopReason
    transcript: list[dict]  # 到目前为止整个会话对话记录的副本（见下文）


# 对话记录是一个只追加的事件字典列表。它是日志，而不是模型的上下文：
# 压缩（compaction）只会改变你发送给模型的内容，从不从对话记录中删除
# 事件。事件类型如下：
#
#   {"type": "user",        "content": str}
#   {"type": "assistant",   "content": str}               # 原始模型回复
#   {"type": "tool_call",   "name": str, "args": dict}
#   {"type": "tool_result", "name": str, "status": Status, "content": str}
#
# tool_result 的 "content" 正是你展示给模型的 ToolResult.content。无法解析
# 的回复会产生一个 "assistant" 事件，随后是一个
# {"type": "error", "content": str} 事件，其中保存你发回的
# 消息。你也可以追加其他类型的事件（例如 "compaction"）。


@dataclass
class Approval:
    approved: bool
    reason: str = ""


@dataclass
class AgentConfig:
    """agent 会话的配置。"""

    max_turns: int = 20  # 每条用户消息允许的模型调用次数
    token_budget: int = 400_000  # 每条用户消息允许的 token 数
    context_budget: int = 16_000  # 任意一次 LM 调用的消息中允许的最大 token 数
    memory_dir: Optional[Path] = None  # 持久化记忆（memory）的存放位置
    mode: Literal["confirm", "auto"] = "auto"
    user: Any = None  # 一个 harness.user.UserIO，或 None 表示没有人类
    deny_rules: tuple[str, ...] = ()  # 作用于 run_terminal 命令的正则表达式
    # 用于那些不属于 agent 自身轮次的调用的第二个模型
    # （为压缩生成摘要、工具内部的模型调用）。
    # None 表示“使用 agent 自己的模型”。
    aux_lm: Any = None
    # 终端工作区目录；None 表示使用沙箱（sandbox）默认值。
    workspace: Optional[Path] = None
    # 一条 run_terminal 命令允许运行的秒数；把它传给 sandbox.run_terminal。
    terminal_timeout: float = 10.0

