"""Taking the whole terminal mid-run: `Screen`, `StatusLine.paused`, and `PluginHost.full_screen`."""

import io
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from prompt_toolkit.application import create_app_session
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.output import DummyOutput
from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel
from rich.console import Console

from pydantic_clai2 import chat
from pydantic_clai2.plugins import PluginHost
from pydantic_clai2.screen import Screen
from pydantic_clai2.settings_store import SettingsStore
from pydantic_clai2.status import Status, StatusLine


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


async def test_screen_is_free_between_prompts_and_bound_during_one() -> None:
    log: list[str] = []
    screen = Screen()

    @asynccontextmanager
    async def take() -> AsyncGenerator[None]:
        log.append('taken')
        yield
        log.append('released')

    async with screen.full():
        log.append('free')
    with screen.bound(take):
        async with screen.full():
            log.append('inside')
    async with screen.full():
        log.append('free again')
    assert log == ['free', 'taken', 'inside', 'released', 'free again']


async def test_host_defaults_to_a_bare_screen() -> None:
    host: PluginHost[None] = PluginHost(name='t', console=Console(file=io.StringIO()), settings={})
    async with host.full_screen():
        pass


async def test_paused_status_line_releases_and_reserves_the_row() -> None:
    output = io.StringIO()
    console = Console(file=output, force_terminal=True, width=80, height=24)
    async with StatusLine(console, Status()) as line:
        reserved = output.getvalue()
        assert '\x1b[1;23r' in reserved and '\x1b[?25l' in reserved
        async with line.paused():
            paused = output.getvalue()[len(reserved) :]
            assert paused.startswith('\x1b7\x1b[r') and paused.endswith('\x1b[?25h')
        resumed = output.getvalue()[len(reserved) + len(paused) :]
        assert '\x1b[1;23r' in resumed and '\x1b[?25l' in resumed
    assert output.getvalue().endswith('\x1b[?25h')


async def test_paused_is_a_no_op_when_the_row_was_never_reserved() -> None:
    output = io.StringIO()
    async with StatusLine(Console(file=output, force_terminal=False), Status()) as line, line.paused():
        pass
    assert output.getvalue() == ''


async def test_plugin_takes_the_screen_from_inside_a_tool(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / 'config.db')
    store.plugins_dir.mkdir()
    (store.plugins_dir / 'taker.py').write_text(
        'from pydantic_ai import RunContext\n'
        'from pydantic_ai.capabilities import AbstractCapability\n'
        'from pydantic_ai.toolsets import FunctionToolset\n'
        'from pydantic_clai2.plugins import PluginHost\n'
        'def activate(host: PluginHost) -> None:\n'
        '    toolset = FunctionToolset()\n'
        '    @toolset.tool\n'
        '    async def take(ctx: RunContext[None]) -> str:\n'
        '        async with host.full_screen():\n'
        "            host.console.print('drawing on a settled screen')\n"
        "        return 'taken'\n"
        '    class Taker(AbstractCapability):\n'
        '        def get_toolset(self):\n'
        '            return toolset\n'
        '    host.add(Taker())\n'
    )
    output = io.StringIO()
    with create_pipe_input() as pipe, create_app_session(input=pipe, output=DummyOutput()):
        pipe.send_text('hello\n/exit\n')
        await chat(
            Agent(TestModel(call_tools=['take'], custom_output_text='done')),
            deps=None,
            console=Console(file=output),
            store=store,
        )
    text = output.getvalue()
    assert text.index('● take') < text.index('drawing on a settled screen') < text.index('done')
