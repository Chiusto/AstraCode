from harness.types import ParsedResponse, ToolCall
import json
import re

"""
Q:工具调用协议需要干什么？
A:告诉模型存在哪些工具以及如何写调用，你的代码必须从回复中解析调用，你决定工具结果如何写入用户或助手消息。
但是这里tool registry应该放在哪里？
"""


class tool_protocol:
    def render_tools(schemas: list[dict]) -> str:
        """
        系统提示文本,描述registry.schemas()中的工具以及如何调用它们
        注意这里要做JSON格式约束，然后回来解析字符串，再真正的执行。
        """
        call_prompt = """
        按照给出的工具信息，选择需要调用的工具，并且构造参数。
        一次回复只能包含一次调用。
        """
        json_format_prompt = """
        输出时只输出一个 JSON 对象：
        1) 调用工具：{"text": "<可留空的简短说明>", "tool_call": {"name": "<工具名>", "arguments": {<参数对象>}}}
        2) 直接回答（不调用工具）：{"text": "<给用户的回答>"}
        """
        return (
            json.dumps(schemas, ensure_ascii=False) + call_prompt + json_format_prompt
        )

    def parse_response(text: str) -> ParsedResponse:
        """
        捕获异常，然后返回的回复解析为error
        """
        raw = tool_protocol.strip_code_fence(text)
        # 本地 DeepSeek 等模型偶尔输出原生工具标记而不是约定 JSON；
        # 当作畸形回复重试，不要把这段标记当成最终答案展示给用户。
        if "｜｜DSML｜｜" in text or "<｜" in text:
            return ParsedResponse(
                text="", error="检测到原生工具调用标记；请按约定只输出 JSON"
            )
        if not raw.startswith("{"):
            return ParsedResponse(text=raw)  # 不是调用 = 纯文本最终回答
        try:
            payload, end = json.JSONDecoder().raw_decode(raw)
        except json.JSONDecodeError as e:
            return ParsedResponse(
                text="", error=f"回复不是合法 JSON（可能被截断）：{e}"
            )
        if raw[end:].strip():
            return ParsedResponse(text="", error="一次回复只能包含一次调用")

        if not isinstance(payload, dict):
            return ParsedResponse(text=raw)

        # 规范格式：format_tool_call 产出的 {"text", "tool_call": {"name", "arguments"}}
        call = payload.get("tool_call")
        if isinstance(call, dict):
            return ParsedResponse(
                text=str(payload.get("text") or "").strip(),
                tool_call=ToolCall(
                    str(call.get("name") or ""), call.get("arguments") or {}
                ),
            )

        # 兼容 render_tools 教给模型的格式：{"name": "<工具>", "args": {...}}
        name = payload.get("name")
        if isinstance(name, str) and name.strip():
            args = payload.get("args", payload.get("arguments"))
            if not isinstance(args, dict):
                return ParsedResponse(text="", error="工具调用的 args 必须是 JSON 对象")
            return ParsedResponse(text="", tool_call=ToolCall(name.strip(), args))

        # 兼容提示里的“直接回答”：{"name": "", "args": ...}
        if name == "":
            args = payload.get("args")
            if isinstance(args, str):
                return ParsedResponse(text=args.strip())
            if isinstance(args, dict):
                text = payload.get("text") or args.get("text") or args.get("answer")
                if isinstance(text, str):
                    return ParsedResponse(text=text.strip())

        return ParsedResponse(text=str(payload.get("text") or "").strip())

    def format_tool_call(text: str, call: ToolCall) -> str:
        """
        把给用户看的 自然语言回复 和 结构化的工具调用
        转为字符串，方便使用前面的parse_response()再解析回ParsedResponse对象
        """
        response = {
            "text": text,
            "tool_call": {
                "name": call.name,
                "arguments": call.args,
            },
        }
        return json.dumps(response, ensure_ascii=False)  # 输出标准JSON

    def strip_code_fence(text: str) -> str:
        # 剥掉 ```json ... ``` 这种围栏
        m = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text.strip(), flags=re.S | re.I)
        return m.group(1).strip() if m else text.strip()


"""
工具调用协议:
1. 获取所有可用工具，生成给lm的提示词
2. 将lm的回复解析为对象
3. 将lm输出进行整理，方便后续保存和继续对话
"""
