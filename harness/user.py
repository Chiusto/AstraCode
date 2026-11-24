"""交互层用户界面。

你的 agent 从不读取键盘。当它需要人类时，它会调用
``AgentConfig.user`` 中 ``UserIO`` 对象的三个方法之一；
``ConsoleUser`` 让你自己与你的 agent 对话。
"""

from __future__ import annotations

from typing import Optional

from harness.types import Approval, ToolCall


class UserIO:
    """你的 agent 联系人类的三条途径。"""

    def approve(self, call: ToolCall) -> Approval:
        """询问用户 ``call`` 是否可以执行。用于 confirm 模式。"""
        raise NotImplementedError

    def ask(self, question: str) -> str:
        """把模型的 ask_user 问题交给用户，并返回回答。"""
        raise NotImplementedError

    def pending_message(self) -> Optional[str]:
        """用户趁 agent 工作时发来的一条引导（steering）消息，或
        None。在每次模型调用之前调用它；返回的消息会被
        消费掉（下一次调用会返回 None，除非又来了另一条）。"""
        return None


class ConsoleUser(UserIO):
    """一个真实的人坐在终端前。"""

    def approve(self, call: ToolCall) -> Approval:
        print(f"\nThe agent wants to run {call.name} with {call.args}")
        reply = input("Allow? [y/N, or type a reason to deny] ").strip()
        if reply.lower() in ("y", "yes"):
            return Approval(True)
        return Approval(False, reply if reply.lower() not in ("", "n", "no") else "The user declined this action.")

    def ask(self, question: str) -> str:
        print(f"\nThe agent asks: {question}")
        return input("> ").strip()
