"""
持久化记忆、JSON格式备份
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path

MEMORY_FILENAME = "memory.json"

# 预编译一个正则表达式，用于匹配“由小写英文字母和数字组成的连续词元（词项）”。
_TERM_RE = re.compile(r"[a-z0-9]+")

# 只保留内容词，避免 "the/user/work" 这类词让无关事实也命中 recall。
_STOPWORDS = frozenset("""
    a an the is are was were be been being of to in on at for with and or but
    nor not no i me my mine we our us you your yours he she it its they them
    their this that these those what which who whom whose when where why how
    do does did done have has had can could should would will shall may might
    must about from as by into over under again further then once here there
    all any both each few more most other some such only own same so than too
    very just also user users work works working
    """.split())


def _terms(text: str) -> list[str]:
    """
    将输入文本清洗并切分为“有效词元列表”——先统一转小写、按字母数字提取词项，再过滤掉停用词。
    假设传入文本：
    "The users are working on 2 new models!"
    转小写并提取词元：['the', 'users', 'are', 'working', 'on', '2', 'new', 'models']
    过滤 _STOPWORDS（假设 the、users、are、working、on 都在停用词表中）：
    最终返回：['2', 'new', 'models']。
    """
    return [t for t in _TERM_RE.findall(text.lower()) if t not in _STOPWORDS]


class MemoryStore:
    def __init__(self, directory: Path | str):
        self.directory = Path(directory)
        self.path = self.directory / MEMORY_FILENAME

    def facts(self) -> list[str]:
        """
        从 self.path 指向的 JSON 文件中安全地读取并提取“事实条目列表（list[str]）”，
        同时兼容两种不同的 JSON 数据结构。
        """
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []  # 一旦出错，直接返回空列表 []
        items = payload.get("facts", []) if isinstance(payload, dict) else payload
        if not isinstance(items, list):
            return []  # 如果最终 items 不是 list,则返回 []
        facts = []
        # 兼容两种元素格式，抽取字符串事实
        for item in items:
            if isinstance(item, str):
                facts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("fact"), str):
                facts.append(item["fact"])
        return facts

    def add(self, fact: str) -> int:
        """清洗并添加一条新事实到持久化存储中，去重后写回文件，并返回更新后的事实总数"""
        fact = fact.strip()
        facts = self.facts()
        # 非空校验与精确去重后保存
        if fact and fact not in facts:
            facts.append(fact)
            self._save(facts)
        return len(facts)

    def search(self, query: str) -> list[str]:
        """基于关键词重叠度对已存储的事实进行检索与排序，返回与 query 相关的事实列表。"""
        wanted = set(_terms(query))
        if not wanted:
            return []
        scored = []
        for fact in self.facts():
            overlap = len(wanted & set(_terms(fact)))
            if overlap:
                scored.append((overlap, fact))
        scored.sort(key=lambda item: item[0], reverse=True)
        return [fact for _, fact in scored]

    def _save(self, facts: list[str]) -> None:
        """将 facts 列表以“原子替换（Atomic Replace）”的方式安全持久化写入磁盘"""
        # 确保目标目录存在
        self.directory.mkdir(parents=True, exist_ok=True)
        # 在同一目录下创建临时文件
        fd, tmp = tempfile.mkstemp(prefix=".memory-", suffix=".tmp", dir=self.directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump({"facts": facts}, handle, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
