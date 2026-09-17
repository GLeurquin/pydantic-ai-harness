"""Grep previews retain invocation context and distinguish truncation sources."""

import io

import pytest
from pydantic_ai import FunctionToolCallEvent, FunctionToolResultEvent
from pydantic_ai.messages import ToolCallPart, ToolReturnPart
from pydantic_ai_harness.filesystem import FilesSearchedEvent
from rich.console import Console

from pydantic_clai2 import StreamRenderer
from pydantic_clai2.tool_output import FoldedOutputs


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


@pytest.mark.parametrize('tool_truncated', [False, True])
async def test_grep_preview(tool_truncated: bool) -> None:
    output = io.StringIO()
    folds = FoldedOutputs()
    renderer = StreamRenderer(Console(file=output), stop_loading=lambda: None, tool_output_lines=1, folds=folds)
    await renderer.on_stream_event(
        FunctionToolCallEvent(
            part=ToolCallPart(
                tool_name='grep',
                args={'pattern': 'needle', 'path': '/tmp/example'},
                tool_call_id='search',
            )
        )
    )
    assert "grep 'needle' in '/tmp/example'" in output.getvalue()
    result = 'example:1:first\nexample:2:second\nexample:3:third'
    if tool_truncated:
        result += '\n[... truncated at 3 matches]'
    await renderer.on_stream_event(
        FilesSearchedEvent(
            path='/tmp/example',
            root_dir='/tmp',
            pattern='needle',
            search='grep',
            match_count=3,
            truncated=tool_truncated,
            tool_call_id='search',
        )
    )
    await renderer.on_stream_event(
        FunctionToolResultEvent(
            part=ToolReturnPart(
                tool_name='grep',
                content=result,
                tool_call_id='search',
            )
        )
    )
    text = output.getvalue()
    assert 'example:1:first' in text and 'example:2:second' not in text
    assert '... 2 more lines (/expand to show)' in text
    assert ('additional result count unknown' in text) == tool_truncated
    assert '[... truncated' not in text
    assert text.endswith('\n\n')
    output.truncate(0)
    output.seek(0)
    assert folds.expand(Console(file=output, width=200), []) == '3 lines.'
    assert (
        output.getvalue() == "● grep 'needle' in '/tmp/example'\nexample:1:first\nexample:2:second\nexample:3:third\n"
    )


async def test_grep_no_matches() -> None:
    output = io.StringIO()
    renderer = StreamRenderer(Console(file=output), stop_loading=lambda: None)
    await renderer.on_stream_event(
        FunctionToolCallEvent(
            part=ToolCallPart(
                tool_name='grep',
                args={'pattern': 'missing'},
                tool_call_id='search',
            )
        )
    )
    await renderer.on_stream_event(
        FunctionToolResultEvent(
            part=ToolReturnPart(
                tool_name='grep',
                content='',
                tool_call_id='search',
            )
        )
    )
    assert 'No matches.' in output.getvalue()


async def test_abort_forgets_grep_calls_awaiting_results() -> None:
    output = io.StringIO()
    renderer = StreamRenderer(Console(file=output), stop_loading=lambda: None)
    await renderer.on_stream_event(
        FunctionToolCallEvent(part=ToolCallPart(tool_name='grep', args={'pattern': 'x'}, tool_call_id='search'))
    )
    await renderer.on_stream_event(
        FilesSearchedEvent(
            path='.', root_dir='/tmp', pattern='x', search='grep', match_count=1, truncated=True, tool_call_id='search'
        )
    )
    await renderer.abort()
    output.truncate(0)
    output.seek(0)
    await renderer.on_stream_event(
        FunctionToolResultEvent(part=ToolReturnPart(tool_name='grep', content='late', tool_call_id='search'))
    )
    assert 'Results' not in output.getvalue() and 'truncated' not in output.getvalue()
