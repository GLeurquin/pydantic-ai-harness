"""The prompt's bottom toolbar, separate from conversation output."""

import math
from dataclasses import dataclass

from prompt_toolkit.formatted_text import StyleAndTextTuples
from pydantic_ai import AgentStreamEvent, FunctionToolCallEvent, FunctionToolResultEvent, PartDeltaEvent, PartStartEvent
from pydantic_ai.messages import (
    TextPart,
    TextPartDelta,
    ThinkingPart,
    ThinkingPartDelta,
    ToolCallPart,
    ToolCallPartDelta,
)

from . import theme

_SHADES = (theme.SUGAR, theme.LIGHT_PURPLE, theme.LITHIUM, theme.PURPLE)


@dataclass(kw_only=True)
class Status:
    """Reported context and explicitly approximate live output counts."""

    model: str = 'agent default'
    context_tokens: int | None = None
    output_tokens: int | None = None
    streamed_chars: int = 0
    activity: str = 'ready'
    queued: int = 0

    def observe(self, event: AgentStreamEvent) -> None:
        """Include text, thinking, and streamed tool arguments in the estimate."""
        if isinstance(event, PartStartEvent):
            part = event.part
            if isinstance(part, (TextPart, ThinkingPart)):
                self.streamed_chars += len(part.content)
                self.activity = 'thinking' if isinstance(part, ThinkingPart) else 'responding'
            elif isinstance(part, ToolCallPart):
                self.streamed_chars += len(part.args_as_json_str())
                self.activity = f'tool: {part.tool_name}'
        elif isinstance(event, PartDeltaEvent):
            delta = event.delta
            if isinstance(delta, (TextPartDelta, ThinkingPartDelta)):
                self.streamed_chars += len(delta.content_delta or '')
            elif isinstance(delta, ToolCallPartDelta) and isinstance(delta.args_delta, str):
                self.streamed_chars += len(delta.args_delta)
        elif isinstance(event, FunctionToolCallEvent):
            self.activity = f'running: {event.part.tool_name}'
        elif isinstance(event, FunctionToolResultEvent):
            self.activity = 'working'

    def text(self) -> str:
        """Use no percentage when the model's context capacity is unknown."""
        context = '?' if self.context_tokens is None else f'{self.context_tokens:,}'
        output = f'~{math.ceil(self.streamed_chars / 4):,} streamed tokens'
        if self.output_tokens is not None:
            output = f'{self.output_tokens:,} output tokens'
        text = f'{self.model} | context: {context} tokens | {output} | {self.activity}'
        if self.queued:
            text += f' | {self.queued} queued'
        return text

    def toolbar(self, *, frame: int) -> StyleAndTextTuples:
        """Plain toolbar colour while idle; a moving magenta-to-white highlight while a turn runs."""
        text = self.text()
        if self.activity == 'ready':
            return [('', text)]
        highlight = frame % (len(text) + 12) - 6
        return [(f'fg:{_SHADES[min(abs(index - highlight) // 2, 3)]}', char) for index, char in enumerate(text)]
