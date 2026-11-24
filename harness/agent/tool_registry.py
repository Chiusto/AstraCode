from typing import Any
from harness.types import ToolSpec
from harness.types import ToolResult
import jsonschema
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError


class ToolRegistry:
    def __init__(self, tools: list[ToolSpec] | None = None):
        self.tools: list[ToolSpec] = []
        if tools:
            self.register(tools)

    def register(self, new_tools: list[ToolSpec]):
        self.tools.extend(new_tools)

    def schemas(self) -> list[dict]:
        """获取工具内容"""
        schemas = []
        for tool in self.tools:
            schemas.append(
                {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                }
            )
        return schemas

    def spec(self, name: str) -> ToolSpec | None:
        """按名称取回 ToolSpec；审批策略需要读取它的 read_only。"""
        for tool in self.tools:
            if tool.name == name:
                return tool
        return None

    def validate(self, name: str, args: dict) -> ToolResult | None:
        """
        Q:这里如何根据工具的schema去检查args？
        A:根据参数去执行一遍工具，并且进行异常捕获，如果报错，则返回返回`unknown_tool`或`invalid_args`结果
        修正：这里不执行工具，是根据参数schema检查args
        """
        # 找到工具
        tool = None
        for t in self.tools:
            if t.name == name:
                tool = t
                break
        if tool is None:
            return ToolResult(status="unknown_tool", content=f"unknown tool:{name}")

        # 检查args
        json_schema = tool.parameters
        validator = Draft202012Validator(json_schema)
        try:
            validator.validate(args)
        except ValidationError as e:
            return ToolResult(
                status="invalid_args",
                content=f"tool parameters:{json_schema},current args:{args},exception:{e.message}",
            )
        except Exception as e:
            return ToolResult(status="tool_error", content=f"{type(e).__name__}: {e}")
        return None

    def execute(self, name: str, args: dict) -> ToolResult:
        """
        先验证，再运行工具
        这里和验证函数都返回ToolResult，但是这里需要运行，然后返回运行的结果。
        再捕获一下异常吧
        """
        # 先验证工具
        err = self.validate(name, args)
        if err is not None:
            # 这里未通过校验，我就直接返回校验传回的结果了
            return err

        # 找出工具中需要执行的函数
        for t in self.tools:
            if t.name == name:
                fn = t.fn

        # 执行工具
        try:
            execute_result = fn(**args)
        except Exception as e:
            return ToolResult(status="tool_error", content=f"{type(e).__name__}: {e}")
        return ToolResult(status="ok", content=str(execute_result))


def tool_registry(tools: list[ToolSpec]) -> Any:
    """
    思路：
    需要自己写一个类，维护已注册的工具，所以这里返回Any;
    types.py下看看工具有哪些属性，其中fn是真正的执行体
    Q：工具中心这个类如何进行设计？它需要什么？
    A：初步设想：直接传入list[ToolSpec]，然后构建对象内部的方法。但是这样的话，tool_registry方法太简单了？
    有没有可能需要对list[ToolSpec]进行重构，然后得到一个对象？

    Q：如何把工具注册到class的内部？
    A：init函数传入tools参数，类的函数内部进行注册。
    """
    registry = ToolRegistry(tools)
    return registry


def main():
    TOOLS: list[ToolSpec] = [
        ToolSpec(
            name="add",
            description="Add two integers.",
            parameters={
                "type": "object",
                "properties": {
                    "a": {"type": "integer"},
                    "b": {"type": "integer"},
                },
                "required": ["a", "b"],
            },
            fn="add",
            read_only=True,
        ),
        ToolSpec(
            name="echo",
            description="Echo the input text back.",
            parameters={
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
            fn="echo",
            read_only=True,
        ),
        ToolSpec(
            name="now",
            description="Return current timestamp.",
            parameters={"type": "object", "properties": {}},
            fn="now",
            read_only=True,
        ),
        ToolSpec(
            name="delete_file",
            description="Delete a file at the given path.",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            fn="delete_file",
            read_only=False,  # 有副作用
        ),
    ]
    registry = tool_registry(TOOLS)
    print("========output========")
    # print(registry.schemas())
    print(registry.validate("delete_file", {"path": "/tmp/a.txt"}))


if __name__ == "__main__":
    main()

"""
uv run -m harness.agent.tool_registry
"""
