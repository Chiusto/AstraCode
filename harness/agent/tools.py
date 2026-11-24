"""agent 的内置工具：终端、记忆、提问。

``build_tools`` 返回默认工具集；``with_extras`` 在显式工具列表上按配置
补齐 ``ask_user``、``remember``、``recall``。
"""

from __future__ import annotations

from functools import partial
from typing import Any, Callable

from harness import sandbox
from harness.agent.memory import MemoryStore
from harness.types import AgentConfig, ToolSpec


def run_terminal(cmd: str, config: AgentConfig) -> str:
    """在沙箱工作区里执行一条命令。"""
    result = sandbox.run_terminal(
        cmd,
        workspace=config.workspace,
        timeout=config.terminal_timeout,
    )
    shown = (
        f"exit_code: {result.exit_code}\n"
        f"stdout:\n{result.stdout[:4000]}\n"
        f"stderr:\n{result.stderr[:4000]}\n"
        f"reason: {result.reason}"
    )

    if result.rejected or result.timed_out or result.exit_code != 0:
        raise RuntimeError(shown)

    return shown


def remember(fact: str, config: AgentConfig | None = None) -> str:
    """记住一条关于用户的事实。"""
    if config is None or config.memory_dir is None:
        raise RuntimeError("remember needs AgentConfig.memory_dir")
    total = MemoryStore(config.memory_dir).add(fact)
    return f"Stored. Memory now holds {total} fact(s)."


def recall(query: str, config: AgentConfig | None = None) -> str:
    """检索此前记住的事实。"""
    if config is None or config.memory_dir is None:
        raise RuntimeError("recall needs AgentConfig.memory_dir")
    store = MemoryStore(config.memory_dir)
    facts = store.facts()
    if not facts:
        return "No facts are stored yet."
    matches = store.search(query)
    if not matches:
        return f"No stored facts matched {query!r}; the store has {len(facts)} fact(s)."
    return "\n".join(f"- {fact}" for fact in matches)


def ask_user(question: str, config: AgentConfig | None = None) -> str:
    """向用户提出一个澄清问题。"""
    if config is None or config.user is None:
        raise RuntimeError("ask_user needs AgentConfig.user")
    return config.user.ask(question)


_STRING = {"type": "string"}


def _object(properties: dict, required: list[str]) -> dict:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


def _spec(name: str, description: str, parameters: dict, fn: Callable[..., Any], read_only: bool) -> ToolSpec:
    return ToolSpec(
        name=name,
        description=description,
        parameters=parameters,
        fn=fn,
        read_only=read_only,
    )


def _terminal_spec(config: AgentConfig) -> ToolSpec:
    return _spec(
        "run_terminal",
        "Run one shell command in the sandboxed workspace. Use it for exact counts, "
        "filtering and tabulations over files.",
        _object({"cmd": _STRING}, ["cmd"]),
        partial(run_terminal, config=config),
        read_only=False,
    )


def _remember_spec(config: AgentConfig) -> ToolSpec:
    return _spec(
        "remember",
        "Persist one durable fact about the user.",
        _object({"fact": _STRING}, ["fact"]),
        partial(remember, config=config),
        read_only=True,
    )


def _recall_spec(config: AgentConfig) -> ToolSpec:
    return _spec(
        "recall",
        "Search the facts stored with remember.",
        _object({"query": _STRING}, ["query"]),
        partial(recall, config=config),
        read_only=True,
    )


def _ask_user_spec(config: AgentConfig) -> ToolSpec:
    return _spec(
        "ask_user",
        "Ask the human user a clarifying question.",
        _object({"question": _STRING}, ["question"]),
        partial(ask_user, config=config),
        read_only=True,
    )


def build_tools(config: AgentConfig) -> list[ToolSpec]:
    """返回默认工具集；只注册函数，不触碰文件系统。"""
    return [
        _terminal_spec(config),
        _remember_spec(config),
        _recall_spec(config),
        _ask_user_spec(config),
    ]


def with_extras(tools: list[ToolSpec], config: AgentConfig) -> list[ToolSpec]:
    """显式工具列表：原样保留，再按配置追加 ask_user、remember、recall。"""
    specs = list(tools)
    names = {spec.name for spec in specs}

    if config.user is not None:
        specs = [spec for spec in specs if spec.name != "ask_user"]
        specs.append(_ask_user_spec(config))

    if config.memory_dir is not None:
        if "remember" not in names:
            specs.append(_remember_spec(config))
            names.add("remember")
        if "recall" not in names:
            specs.append(_recall_spec(config))
            names.add("recall")

    return specs
