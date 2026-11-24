"""把模型与配置接成 agent 会话。"""

from __future__ import annotations

from typing import Any, Optional

from harness.types import AgentConfig, LMCallable, ToolSpec


def run_agent_session(
    lm: LMCallable,
    tools: Optional[list[ToolSpec]],
    config: AgentConfig,
) -> Any:
    """创建一个 agent 会话；``tools=None`` 表示使用默认工具集。"""
    from harness.agent.session import Session

    return Session(lm, tools, config)
