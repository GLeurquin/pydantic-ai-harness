"""Incremental Markdown rendering for native Pydantic AI events."""

from collections.abc import Callable

from pydantic_ai import (
    AgentStreamEvent,
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    PartDeltaEvent,
    PartEndEvent,
    PartStartEvent,
    TextPart,
    TextPartDelta,
    ThinkingPart,
    ThinkingPartDelta,
)
from rich.console import Console
from termflow import Parser, Renderer  # pyright: ignore[reportMissingTypeStubs]
from termflow.render.style import RenderFeatures  # pyright: ignore[reportMissingTypeStubs]


class StreamRenderer:
    """Render text and thinking separately, flushing Markdown at part boundaries."""

    def __init__(self, console: Console, *, stop_loading: Callable[[], None], show_thinking: bool = True) -> None:
        self.console = console
        self.show_thinking = show_thinking
        self.stop_loading = stop_loading
        self._parser: Parser | None = None
        self._renderer: Renderer | None = None
        self._buffer = ''
        self._index: int | None = None
        self.rendered_text = False

    async def on_stream_event(self, event: AgentStreamEvent) -> None:
        """Bind this callback to `Session.on_stream_event`."""
        if isinstance(event, PartStartEvent) and isinstance(event.part, (TextPart, ThinkingPart)):
            self.finish()
            self.stop_loading()
            thinking = isinstance(event.part, ThinkingPart)
            if thinking and not self.show_thinking:
                return
            self.console.print('Thinking' if thinking else 'CLAI', style='dim cyan' if thinking else 'bold magenta')
            self._index = event.index
            self._parser = Parser()
            self._renderer = Renderer(
                output=self.console.file,  # pyright: ignore[reportArgumentType]
                width=self.console.width,
                dim=thinking,
                features=RenderFeatures(clipboard=False, hyperlinks=False, images=False),
            )
            self._feed(event.part.content)
            if not thinking:
                self.rendered_text = True
        elif isinstance(event, PartDeltaEvent) and event.index == self._index:
            if isinstance(event.delta, TextPartDelta):
                self._feed(event.delta.content_delta)
            elif isinstance(event.delta, ThinkingPartDelta):
                self._feed(event.delta.content_delta or '')
        elif isinstance(event, PartEndEvent) and event.index == self._index:
            self.finish()
        elif isinstance(event, (FunctionToolCallEvent, FunctionToolResultEvent)):
            self.finish()
            self.stop_loading()
            self.console.print(
                f'{"Tool" if isinstance(event, FunctionToolCallEvent) else "Finished"}: {event.part.tool_name}',
                style='dim',
                markup=False,
            )

    def _feed(self, content: str) -> None:
        self._buffer += content
        while '\n' in self._buffer:
            line, self._buffer = self._buffer.split('\n', 1)
            self._line(line)

    def _line(self, line: str) -> None:
        if self._parser is not None and self._renderer is not None:
            self._renderer.render_all(self._parser.parse_line(line))

    def finish(self) -> None:
        """Flush incomplete lines and Markdown structures, including on failure."""
        if self._buffer:
            self._line(self._buffer)
        if self._parser is not None and self._renderer is not None:
            self._renderer.render_all(self._parser.finalize())
        self._buffer = ''
        self._parser = None
        self._renderer = None
        self._index = None
        self.console.file.flush()
