"""语言模型封装。

本模块只提供一个基础原语：一次聊天补全（chat completion）调用，它接收
一个消息列表并返回一个字符串。

    lm = LM()                                  # the default model
    text = lm([{"role": "system", "content": "..."},
               {"role": "user", "content": "..."}])

没有工具调用参数，也没有结构化输出参数。这些都需要你在这层调用的基础上
自行构建。

该封装为你做了以下事情：

* 磁盘缓存。每次调用都会以模型、采样设置和确切的消息为键缓存到
  ``.lm_cache/`` 下。重新运行未改动的代码不会产生任何费用。
* 成本账本。每次真正到达提供方的调用都会连同其 token 数和美元成本追加到
  ``.lm_cache/ledger.jsonl``。``uv run python -m harness.llm`` 会打印一份
  花费报告。
* 预算中止。如果设置了 ``ASTRA_BUDGET_USD``，一旦账本总额超过该值，封装就
  抛出 ``BudgetExceeded``，而不是发起调用。
* 截断。如果一次调用因为模型到达 ``max_tokens`` 而停止，就会抛出
  ``OutputTruncated``，而不是返回被截断的文本。该异常携带目前已生成的文本
  （``.text``）以及 token 计数。该调用照常计费并记录到账本，但不会被缓存。
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Sequence

REPO_ROOT = Path(__file__).resolve().parent.parent

Message = dict  # {"role": "system" | "user" | "assistant", "content": str}

# agent 使用的模型。可用环境变量 ASTRA_AGENT_MODEL 覆盖。
DEFAULT_MODELS = {
    "agent": "deepseek-flash",
}

# 调用发往 DeepSeek 的 OpenAI 兼容接口。
# 密钥从环境变量 DEEPSEEK_API_KEY 读取（可写在仓库根目录的 .env 中）。
DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"



# 向接受该参数的模型（GPT-5 和 GPT-6）请求的推理强度（reasoning effort）。
# 可用 ASTRA_REASONING_EFFORT 覆盖。
DEFAULT_REASONING_EFFORT = "low"

# 每 1M token 的美元价格：(输入, 缓存输入, 输出)，以去掉提供方前缀的模型名
# 为键。OpenRouter 会在响应中报告每次调用的确切成本，账本记录的就是该值；
# 本表是响应中没有成本时的回退，并且会在创建 LM 时检查，
# 以便未知模型在发生付费调用之前就失败。数据读取自
# https://openrouter.ai/models，日期为 2026-10-05（与 OpenAI 的列表价
# 相同）。
PRICES = {
    "gpt-4.1": (2.00, 0.50, 8.00),
    "gpt-4.1-mini": (0.40, 0.10, 1.60),
    "gpt-4.1-nano": (0.10, 0.025, 0.40),
    "gpt-4o-mini": (0.15, 0.075, 0.60),
    "gpt-5-mini": (0.25, 0.025, 2.00),
    "gpt-5-nano": (0.05, 0.005, 0.40),
    "gpt-5.4": (2.50, 0.25, 15.00),
    "gpt-5.4-mini": (0.75, 0.075, 4.50),
    "gpt-5.4-nano": (0.20, 0.02, 1.25),
    "gpt-5.6-luna": (0.20, 0.02, 1.20),
    "gpt-5.6-terra": (2.00, 0.20, 12.00),
    "gpt-6-astra": (10.00, 1.00, 50.00),
    "gpt-5.5": (5.00, 0.50, 30.00),
    "gpt-6-luna": (0.10, 0.01, 0.50),
    "gpt-6-sol": (2.00, 0.20, 10.00),
    # DeepSeek-V4.1-Flash-1017，官网高峰时段价（元/百万 token）：
    # 输入缓存未命中 ¥2、缓存命中 ¥0.04、输出 ¥8；空闲时段为其一半。
    # 此处按 1 USD = 7.1 CNY 折算为美元，并采用较保守的高峰价。
    "deepseek-flash": (0.2817, 0.0056, 1.1268),
}

VALID_ROLES = ("system", "user", "assistant")


class BudgetExceeded(RuntimeError):
    """当达到花费上限时抛出，而不会调用提供方。"""


class OutputTruncated(RuntimeError):
    """当模型因为到达 ``max_tokens`` 而停止时抛出。

    ``text`` 是模型在被截断之前写下的内容，它经常是空的：
    推理模型的隐藏推理也计入同一个上限，所以上限可能在写出任何可见文本之前
    就被用尽。``output_tokens`` 是整个输出，``reasoning_tokens`` 是其中
    隐藏的部分（当提供方不报告它时为 0）。用更大的 ``max_tokens``
    再次调用会是一次新的付费调用。
    """

    def __init__(self, text: str, *, model: str, max_tokens: int, output_tokens: int, reasoning_tokens: int = 0):
        self.text = text
        self.model = model
        self.max_tokens = max_tokens
        self.output_tokens = output_tokens
        self.reasoning_tokens = reasoning_tokens
        shown = f"{len(text)} characters of text" if text else "no visible text"
        super().__init__(
            f"{model} stopped at max_tokens={max_tokens} with {shown} "
            f"({output_tokens} output tokens, {reasoning_tokens} of them hidden reasoning). "
            "Ask for a shorter reply, or call again with a larger max_tokens."
        )


def resolve_model(role_or_model: str | None = None) -> str:
    """把角色名映射为模型名。

    ``None`` 表示 "agent"。不是角色的字符串会原样返回，
    因此你也可以直接传入模型名。
    """
    name = role_or_model or "agent"
    if name in DEFAULT_MODELS:
        return os.environ.get(f"ASTRA_{name.upper()}_MODEL", DEFAULT_MODELS[name])
    return name


def _price(model: str) -> tuple[float, float, float]:
    model = model.rsplit("/", 1)[-1]  # "openai/gpt-6-luna" -> "gpt-6-luna"
    best = None
    for prefix, price in PRICES.items():
        if model == prefix or model.startswith(prefix + "-20"):
            if best is None or len(prefix) > len(best[0]):
                best = (prefix, price)
    if best is None:
        raise KeyError(
            f"No price on file for model {model!r}. Add it to PRICES in harness/llm.py."
        )
    return best[1]


def cost_usd(model: str, input_tokens: int, cached_tokens: int, output_tokens: int) -> float:
    p_in, p_cached, p_out = _price(model)
    fresh = max(input_tokens - cached_tokens, 0)
    return (fresh * p_in + cached_tokens * p_cached + output_tokens * p_out) / 1_000_000


def _cache_dir() -> Path:
    return Path(os.environ.get("ASTRA_CACHE_DIR", REPO_ROOT / ".lm_cache"))


def _load_env() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:  # pragma: no cover
        return
    load_dotenv(REPO_ROOT / ".env")


_ledger_lock = threading.Lock()
# 会拒绝 temperature 或 reasoning_effort 参数的模型，这是在首次使用每个模型时
# 从提供方的错误中学到的。
_NO_TEMPERATURE: set[str] = set()
_NO_EFFORT: set[str] = set()


def read_ledger() -> list[dict]:
    path = _cache_dir() / "ledger.jsonl"
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def total_spend() -> float:
    return sum(row.get("cost_usd", 0.0) for row in read_ledger())


def _append_ledger(row: dict) -> None:
    path = _cache_dir() / "ledger.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with _ledger_lock:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")


def _validate_messages(messages: Sequence[Message]) -> None:
    if not isinstance(messages, (list, tuple)) or not messages:
        raise ValueError("messages must be a non-empty list of {'role', 'content'} dicts")
    for m in messages:
        if not isinstance(m, dict) or set(m) != {"role", "content"}:
            raise ValueError(
                f"each message must be a dict with exactly the keys 'role' and 'content', got {m!r}"
            )
        if m["role"] not in VALID_ROLES:
            raise ValueError(f"role must be one of {VALID_ROLES}, got {m['role']!r}")
        if not isinstance(m["content"], str):
            raise ValueError("message content must be a string")


class LM:
    """一个聊天模型：输入消息，输出字符串。

    参数
    ----------
    model:
        一个角色名、一个模型名（如 "deepseek-flash"），
        或者 ``None`` 表示默认角色 "agent"。
    temperature, max_tokens:
        采样设置。它们是缓存键的一部分。推理模型会把 ``max_tokens`` 的一部分
        花在隐藏推理上，所以要把该值设得足够大。
        拒绝 ``temperature`` 的模型会在不带该参数的情况下被调用。
    tag:
        写入成本账本的自由形式标签，用于对花费分组
        （例如用来区分不同用途的调用）。
    cache:
        设为 False 可让该实例绕过磁盘缓存。
    salt:
        混入缓存键的额外字符串。具有不同 salt 的两个实例
        对相同的消息会得到互相独立的采样结果。
    """

    def __init__(
        self,
        model: str | None = None,
        *,
        temperature: float = 0.0,
        # max_tokens: int = 4096,
        max_tokens: int = 16384,
        tag: str | None = None,
        cache: bool = True,
        salt: str = "",
    ) -> None:
        _load_env()
        self.model = resolve_model(model)
        _price(self.model)  # 如果价格未知，现在就失败，而不是等到付费调用之后
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.tag = tag
        self.cache = cache
        self.salt = salt
        # 本实例的累计总计。
        self.calls = 0
        self.cached_calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.cost_usd = 0.0
        self.seconds = 0.0
        self._client = None

    # -- 公开 API ---------------------------------------------------------

    def __call__(self, messages: Sequence[Message]) -> str:
        _validate_messages(messages)
        messages = [{"role": m["role"], "content": m["content"]} for m in messages]
        key = self._key(messages)
        path = _cache_dir() / key[:2] / f"{key}.json"
        self.calls += 1
        if self.cache and path.exists():
            self.cached_calls += 1
            return json.loads(path.read_text(encoding="utf-8"))["text"]

        self._check_budget()
        start = time.time()
        text, usage = self._complete(messages)
        elapsed = time.time() - start
        cost = usage.get("cost")
        if cost is None:
            cost = cost_usd(self.model, usage["input"], usage["cached"], usage["output"])
        self.input_tokens += usage["input"]
        self.output_tokens += usage["output"]
        self.cost_usd += cost
        self.seconds += elapsed
        truncated = usage.get("finish_reason") == "length"
        _append_ledger(
            {
                "ts": round(start, 3),
                "model": self.model,
                "tag": self.tag or os.environ.get("ASTRA_TAG", ""),
                "input_tokens": usage["input"],
                "cached_tokens": usage["cached"],
                "output_tokens": usage["output"],
                "cost_usd": cost,
                "seconds": round(elapsed, 3),
                "finish_reason": usage.get("finish_reason"),
            }
        )
        if truncated:  # 已计费并记录，但从不缓存
            raise OutputTruncated(
                text,
                model=self.model,
                max_tokens=self.max_tokens,
                output_tokens=usage["output"],
                reasoning_tokens=usage.get("reasoning", 0),
            )
        if self.cache and text.strip():  # 空回复不值得记住
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
            tmp.write_text(json.dumps({"text": text, "model": self.model}), encoding="utf-8")
            tmp.replace(path)
        return text

    def usage(self) -> dict:
        """本实例自创建以来的总计。"""
        return {
            "model": self.model,
            "calls": self.calls,
            "cached_calls": self.cached_calls,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": self.cost_usd,
            "seconds": self.seconds,
        }

    # -- 内部实现 ---------------------------------------------------------

    def _key(self, messages: list[Message]) -> str:
        effort = os.environ.get("ASTRA_REASONING_EFFORT", DEFAULT_REASONING_EFFORT)
        blob = json.dumps(
            [self.model, self.temperature, self.max_tokens, effort, self.salt, messages],
            sort_keys=True,
            ensure_ascii=False,
        )
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def _check_budget(self) -> None:
        cap = os.environ.get("ASTRA_BUDGET_USD")
        if not cap:
            return
        spent = total_spend()
        if spent >= float(cap):
            raise BudgetExceeded(
                f"Spent ${spent:.2f} of the ${float(cap):.2f} cap set by ASTRA_BUDGET_USD. "
                "Raise the cap in .env if you mean to continue."
            )

    def _complete(self, messages: list[Message]) -> tuple[str, dict]:
        if self._client is None:
            from openai import OpenAI

            key = os.environ.get("DEEPSEEK_API_KEY")
            if not key:
                raise RuntimeError(
                    "DEEPSEEK_API_KEY is not set. Add it to the .env file at the repo root."
                )
            self._client = OpenAI(
                base_url=DEEPSEEK_BASE_URL,
                api_key=key,
                max_retries=6,
                timeout=120,
                default_headers={"X-Title": "AstraCode"},
            )
        kwargs: dict = {
            "model": self.model,
            "messages": messages,
            "max_tokens": self.max_tokens,
            # OpenRouter 扩展：推理强度，以及要求
            # 响应携带本次调用成本的请求。
            "extra_body": {"usage": {"include": True}},
        }
        if self.model not in _NO_TEMPERATURE:
            kwargs["temperature"] = self.temperature
        effort = os.environ.get("ASTRA_REASONING_EFFORT", DEFAULT_REASONING_EFFORT)
        if effort and self.model not in _NO_EFFORT:
            kwargs["extra_body"]["reasoning"] = {"effort": effort}
        try:
            response = self._client.chat.completions.create(**kwargs)
        except Exception as exc:  # 某些模型会拒绝 temperature 或推理强度
            text = str(exc)
            if "temperature" in text and "temperature" in kwargs:
                _NO_TEMPERATURE.add(self.model)
                kwargs.pop("temperature")
                response = self._client.chat.completions.create(**kwargs)
            elif "reasoning" in text and "reasoning" in kwargs["extra_body"]:
                _NO_EFFORT.add(self.model)
                kwargs["extra_body"].pop("reasoning")
                response = self._client.chat.completions.create(**kwargs)
            else:
                raise
        choice = response.choices[0]
        text = choice.message.content or ""
        u = response.usage
        details = getattr(u, "prompt_tokens_details", None)
        cached = getattr(details, "cached_tokens", 0) or 0
        out_details = getattr(u, "completion_tokens_details", None)
        reasoning = getattr(out_details, "reasoning_tokens", 0) or 0
        usage = {
            "input": u.prompt_tokens,
            "cached": cached,
            "output": u.completion_tokens,
            "reasoning": reasoning,
            "finish_reason": getattr(choice, "finish_reason", None),
        }
        cost = getattr(u, "cost", None)  # OpenRouter 报告的本次调用成本
        if isinstance(cost, (int, float)):
            usage["cost"] = float(cost)
        return text, usage


def spending_report(rows: list[dict] | None = None) -> str:
    rows = read_ledger() if rows is None else rows
    if not rows:
        return "No LLM calls recorded yet."
    by_model: dict[str, dict] = {}
    by_tag: dict[str, dict] = {}
    for row in rows:
        model = row.get("model", "?")
        short = model.split("-20")[0]  # 去掉快照日期
        tag_key = f"{row.get('tag') or '(untagged)'} [{short}]"
        for table, key in ((by_model, model), (by_tag, tag_key)):
            agg = table.setdefault(key, {"calls": 0, "cut": 0, "in": 0, "out": 0, "usd": 0.0, "sec": 0.0})
            agg["calls"] += 1
            agg["cut"] += row.get("finish_reason") == "length"
            agg["in"] += row.get("input_tokens", 0)
            agg["out"] += row.get("output_tokens", 0)
            agg["usd"] += row.get("cost_usd", 0.0)
            agg["sec"] += row.get("seconds", 0.0)
    lines = []
    for title, table in (("By model", by_model), ("By tag and model", by_tag)):
        lines.append(title)
        lines.append(f"  {'name':<72}{'calls':>7}{'cut':>5}{'in tok':>12}{'out tok':>10}{'USD':>9}{'sec':>8}")
        for key, agg in sorted(table.items(), key=lambda kv: -kv[1]["usd"]):
            lines.append(
                f"  {key[-71:]:<72}{agg['calls']:>7}{agg['cut'] or '':>5}{agg['in']:>12}{agg['out']:>10}"
                f"{agg['usd']:>9.3f}{agg['sec']:>8.0f}"
            )
        lines.append("")
    total = sum(r.get("cost_usd", 0.0) for r in rows)
    cut = sum(r.get("finish_reason") == "length" for r in rows)
    lines.append(f"Total: {len(rows)} calls, ${total:.3f}" + (f"; {cut} cut off at max_tokens" if cut else ""))
    return "\n".join(lines)


if __name__ == "__main__":  # uv run python -m harness.llm
    print(spending_report())
