"""在终端里与 agent 对话。

    python -m harness.chat [--mode confirm|auto] [--memory-dir DIR] [--out DIR]

用 ``harness.adapters.run_agent_session`` 构建会话，运行默认工具集。
你就是用户：confirm 模式下会要求你批准工具调用，``ask_user`` 的问题也交给你。
输入 ``exit`` 或按 Ctrl-D 退出。

对话结束时保存到 ``runs/chat-<timestamp>.json``（或 ``--out`` 下）。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # 使得从任何目录都能导入 `harness.adapters`

from harness.llm import LM
from harness.types import AgentConfig
from harness.user import ConsoleUser


def main() -> None:
    parser = argparse.ArgumentParser(description="Chat with the agent.")
    parser.add_argument("--mode", choices=["confirm", "auto"], default="confirm")
    parser.add_argument("--memory-dir", type=Path, default=Path(".lm_cache/chat_memory"))
    parser.add_argument("--out", type=Path, default=Path("runs"), help="where to save the conversation")
    args = parser.parse_args()

    from harness import adapters  # 你的接线（wiring）

    config = AgentConfig(
        mode=args.mode,
        user=ConsoleUser(),
        memory_dir=args.memory_dir,
        aux_lm=LM(tag="chat/aux"),
    )
    lm = LM(tag="chat")
    session = adapters.run_agent_session(lm, None, config)
    print(f"Agent ({args.mode} mode, memory in {args.memory_dir}). Type exit to leave.")
    started = time.strftime("%Y%m%d-%H%M%S")
    turns: list[dict] = []
    while True:
        try:
            message = input("\nyou> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if message.lower() in ("exit", "quit"):
            break
        if not message:
            continue
        result = session.send(message)
        note = "" if result.status == "done" else f" [stopped: {result.status}]"
        print(f"\nagent{note}> {result.text}")
        turns.append({"user": message, "agent": result.text, "status": result.status})

    if turns:
        args.out.mkdir(parents=True, exist_ok=True)
        path = args.out / f"chat-{started}.json"
        record = {
            "started": started,
            "mode": args.mode,
            "model": lm.model,
            "turns": turns,
            "transcript": session.transcript,
            "usage": {"agent": lm.usage(), "aux": config.aux_lm.usage()},
        }
        path.write_text(json.dumps(record, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        print(f"Saved this conversation to {path}")


if __name__ == "__main__":
    main()
