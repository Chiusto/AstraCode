"""token 计数器。

每一个预算（循环的 token 预算、agent 的上下文预算、
搜索工具的结果预算）都用这两个函数来度量。它们是一种确定性
（deterministic）的近似（每 token 4 个字符），而不是提供方的
tokenizer，因此不访问网络，数字也稳定可复现。
"""

from __future__ import annotations

import math
from typing import Sequence

CHARS_PER_TOKEN = 4
MESSAGE_OVERHEAD = 4  # 每条消息因其角色和框架而计入的 token 数


def count_tokens(text: str) -> int:
    """一个字符串中的 token 数。"""
    return math.ceil(len(text) / CHARS_PER_TOKEN)


def count_message_tokens(messages: Sequence[dict]) -> int:
    """一个 {"role", "content"} 消息列表中的 token 数，即发送给 LM 的形式。"""
    return sum(count_tokens(m["content"]) + MESSAGE_OVERHEAD for m in messages)
