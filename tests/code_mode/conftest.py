"""Fixtures shared by the CodeMode test modules."""

from __future__ import annotations

import asyncio
import sys
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from pydantic_monty._binary import find_monty_binary  # the lookup `AsyncMonty()` uses for local workers

from tests.code_mode import websocket_relay  # pyright: ignore[reportMissingTypeStubs]

_RELAY_SCRIPT = Path(websocket_relay.__file__)


@asynccontextmanager
async def websocket_relay_server(port: int = 0) -> AsyncGenerator[str, None]:
    """Run the protocol relay on a loopback port (ephemeral by default) and yield its URL."""
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        str(_RELAY_SCRIPT),
        '--port',
        str(port),
        '--monty-bin',
        find_monty_binary(),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert process.stdout is not None
    assert process.stderr is not None
    try:
        url_line = await asyncio.wait_for(process.stdout.readline(), timeout=5)
        if not url_line:  # pragma: no cover
            stderr = (await process.stderr.read()).decode()
            pytest.fail(f'WebSocket relay exited before startup: {stderr}')
        yield url_line.decode().strip()
    finally:
        if process.returncode is None:  # pragma: no branch
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except TimeoutError:  # pragma: no cover
            process.kill()
            await process.wait()


@pytest.fixture
async def websocket_relay_url() -> AsyncIterator[str]:
    """Start the protocol relay on an ephemeral loopback port."""
    async with websocket_relay_server() as url:
        yield url
