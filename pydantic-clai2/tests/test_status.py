"""Toolbar accounting without provider calls."""

from prompt_toolkit.formatted_text import fragment_list_to_text
from pydantic_ai import FunctionToolCallEvent, FunctionToolResultEvent, PartDeltaEvent, PartStartEvent
from pydantic_ai.messages import NativeToolCallPart, TextPart, ToolCallPart, ToolCallPartDelta, ToolReturnPart

from pydantic_clai2 import theme
from pydantic_clai2.status import Status


def test_estimate_includes_tool_argument_deltas() -> None:
    status = Status(model='test')
    status.observe(PartStartEvent(index=0, part=TextPart(content='abcd')))
    status.observe(PartDeltaEvent(index=1, delta=ToolCallPartDelta(args_delta='12345678')))
    assert '~3 streamed tokens' in status.text()
    assert 'context: ?' in status.text()
    status.context_tokens = 1000
    status.output_tokens = 20
    assert 'context: 1,000 tokens' in status.text()
    assert '20 output tokens' in status.text()


def test_tool_status_transitions() -> None:
    status = Status()
    status.observe(PartStartEvent(index=0, part=NativeToolCallPart('web_search', {})))
    call = ToolCallPart('shell', {})
    status.observe(PartStartEvent(index=0, part=call))
    assert status.activity == 'tool: shell'
    status.observe(PartDeltaEvent(index=0, delta=ToolCallPartDelta(args_delta={})))
    status.observe(FunctionToolCallEvent(part=call))
    assert status.activity == 'running: shell'
    status.observe(FunctionToolResultEvent(part=ToolReturnPart('shell', 'done')))
    assert status.activity == 'working'


def test_queue_count_only_when_waiting() -> None:
    status = Status(model='test')
    assert 'queued' not in status.text()
    status.queued = 2
    assert status.text().endswith('| ready | 2 queued')


def test_toolbar_replaces_control_characters() -> None:
    status = Status(model='te\x1bst')
    status.observe(PartStartEvent(index=0, part=ToolCallPart('shell\x1b]52;c;evil\x07\n', {})))
    running = fragment_list_to_text(status.toolbar(frame=0))
    assert 'tool: shell?]52;c;evil??' in running
    status.activity = 'ready'
    idle = fragment_list_to_text(status.toolbar(frame=0))
    assert idle.startswith('te?st |')
    assert all(char.isprintable() for char in running + idle)


def test_toolbar_shimmers_only_while_running() -> None:
    status = Status(model='test')
    idle = status.toolbar(frame=3)
    assert idle == [('', status.text())]
    status.activity = 'responding'
    first = status.toolbar(frame=0)
    later = status.toolbar(frame=10)
    assert fragment_list_to_text(first) == fragment_list_to_text(later) == status.text()
    assert first != later
    assert {fragment[0] for fragment in first} <= {
        f'fg:{color}' for color in (theme.SUGAR, theme.LIGHT_PURPLE, theme.LITHIUM, theme.PURPLE)
    }
    assert first[0][0] == f'fg:{theme.PURPLE}'
    assert status.toolbar(frame=6)[0][0] == f'fg:{theme.SUGAR}'
