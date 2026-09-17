"""Drive one tool call through `Agent(capabilities=[...])` and return what the model saw back."""

from collections.abc import AsyncIterator, Sequence

from pydantic_ai import Agent
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.messages import ModelMessage, ModelResponse, RetryPromptPart, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, FunctionModel


async def call_tool(capabilities: Sequence[AbstractCapability[None]], name: str, arguments: dict[str, object]) -> str:
    """Call `name` with `arguments` once, then finish; return the tool result or retry prompt text."""
    calls = 0

    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        nonlocal calls
        calls += 1
        if calls == 1:
            return ModelResponse(parts=[ToolCallPart(name, arguments)])
        return ModelResponse(parts=[TextPart('done')])

    async def stream(messages: list[ModelMessage], info: AgentInfo) -> AsyncIterator[str | dict[int, DeltaToolCall]]:
        for part in respond(messages, info).parts:
            if isinstance(part, ToolCallPart):
                yield {0: DeltaToolCall(name=part.tool_name, json_args=part.args_as_json_str())}
            else:
                assert isinstance(part, TextPart)
                yield part.content

    agent = Agent(FunctionModel(respond, stream_function=stream), deps_type=type(None), capabilities=capabilities)
    result = await agent.run('Use the tool')
    return '\n'.join(
        str(part.content)
        for message in result.all_messages()
        for part in message.parts
        if isinstance(part, (ToolReturnPart, RetryPromptPart))
    )
