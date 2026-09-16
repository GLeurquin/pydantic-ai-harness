"""Native capability events drive terminal-safe specialized output."""

import io

import pytest
from pydantic_ai_harness.coder import ShellFinishedEvent, ShellOutputEvent, ShellStartedEvent
from pydantic_ai_harness.filesystem import FileEditedEvent
from rich.console import Console

from pydantic_clai2 import StreamRenderer


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


async def test_shell_event_display() -> None:
    output = io.StringIO()
    renderer = StreamRenderer(Console(file=output), stop_loading=lambda: None)
    await renderer.on_stream_event(ShellStartedEvent(tool_call_id='1', command='printf hello', pid=12))
    await renderer.on_stream_event(ShellOutputEvent(tool_call_id='1', text='hello\x1b]52;c;payload\x07'))
    await renderer.on_stream_event(
        ShellFinishedEvent(
            tool_call_id='1',
            pid=12,
            output_path='/tmp/output.log',
            status_path='/tmp/status.json',
            exit_code=0,
            truncated=True,
        )
    )
    assert '$ printf hello' in output.getvalue()
    assert 'hello' in output.getvalue()
    assert '\x1b]52;' not in output.getvalue()
    assert 'truncated' in output.getvalue()


@pytest.mark.parametrize('limit', [0, 1, 2])
async def test_shell_line_limit_across_chunks(limit: int) -> None:
    output = io.StringIO()
    renderer = StreamRenderer(Console(file=output), stop_loading=lambda: None, shell_lines=limit)
    for chunk in ('fir', 'st\nsecond', '\nthird\nfourth'):
        await renderer.on_stream_event(ShellOutputEvent(tool_call_id='test', text=chunk))
    await renderer.on_stream_event(
        ShellFinishedEvent(
            tool_call_id='test',
            pid=1,
            output_path='/tmp/out',
            status_path='/tmp/status',
            exit_code=0,
            truncated=False,
            total_lines=4,
        )
    )
    text = output.getvalue()
    assert f'Truncated {4 - limit} lines' in text
    assert ('first' in text) == (limit >= 1)
    assert ('second' in text) == (limit >= 2)
    assert 'third' not in text and 'fourth' not in text


async def test_edit_uses_termflow_diff_renderer() -> None:
    output = io.StringIO()
    renderer = StreamRenderer(Console(file=output, force_terminal=True), stop_loading=lambda: None)
    await renderer.on_stream_event(
        FileEditedEvent(
            path='demo.py',
            root_dir='/tmp',
            content_hash='hash',
            diff='--- a/demo.py\n+++ b/demo.py\n@@ -1 +1 @@\n-old\n+new\n',
            truncated=False,
        )
    )
    text = output.getvalue()
    assert 'Edited' in text and 'demo.py' in text
    assert 'old' in text and 'new' in text
    assert '\x1b[' in text
