"""Exercise the real Termflow drainer without timing-based assertions."""

import asyncio
import io

import pytest
from pydantic_ai import PartStartEvent, TextPart
from rich.console import Console

from pydantic_clai2 import StreamRenderer


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


async def test_burst_is_queued_then_drained() -> None:
    output = io.StringIO()
    renderer = StreamRenderer(Console(file=output), stop_loading=lambda: None)
    await renderer.on_stream_event(PartStartEvent(index=0, part=TextPart(content='Burst of text\n')))
    assert 'Burst of text' not in output.getvalue()
    await renderer.finish()
    assert 'Burst of text' in output.getvalue()
    before = output.getvalue()
    await renderer.finish()
    assert output.getvalue() == before


async def test_abort_discards_pending_output() -> None:
    output = io.StringIO()
    renderer = StreamRenderer(Console(file=output), stop_loading=lambda: None)
    await renderer.on_stream_event(PartStartEvent(index=0, part=TextPart(content='Discard this\n')))
    await renderer.abort()
    await renderer.finish()
    assert 'Discard this' not in output.getvalue()


async def test_cancel_during_drain_stops_writer() -> None:
    writing = asyncio.Event()

    class ObservedOutput(io.StringIO):
        def write(self, text: str) -> int:
            if 'x' in text:
                writing.set()
            return super().write(text)

    output = ObservedOutput()
    renderer = StreamRenderer(Console(file=output, width=20000), stop_loading=lambda: None)
    await renderer.on_stream_event(PartStartEvent(index=0, part=TextPart(content='x' * 10000 + '\n')))
    task = asyncio.create_task(renderer.finish())
    await writing.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await renderer.abort()
    assert output.getvalue().count('x') < 10000
