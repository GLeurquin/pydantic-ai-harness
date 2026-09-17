"""Drive `chat` through a prompt-toolkit pipe, optionally from a concurrent script."""

import io
from collections.abc import Callable, Coroutine, Sequence
from pathlib import Path

import anyio
from prompt_toolkit.application import create_app_session
from prompt_toolkit.input import PipeInput, create_pipe_input
from prompt_toolkit.output import DummyOutput
from pydantic_ai import Agent
from pydantic_ai.agent import AbstractAgent
from pydantic_ai.capabilities import AgentCapability
from pydantic_ai.models.test import TestModel
from rich.console import Console

from pydantic_clai2 import chat
from pydantic_clai2.config import Settings
from pydantic_clai2.settings_store import SettingsStore

Script = Callable[[PipeInput], Coroutine[object, object, None]]


class Tty(io.StringIO):
    def isatty(self) -> bool:
        return True


class RecordingOutput(DummyOutput):
    """Keep everything prompt-toolkit renders so tests can read the toolbar."""

    def __init__(self, *, tty: bool = False, watch: str = '') -> None:
        self.written: list[str] = []
        self.stdout = Tty() if tty else None
        self.watch = watch
        self.seen = anyio.Event()
        """Set once `watch` has been rendered, so a script can wait for the toolbar."""

    def write(self, data: str) -> None:
        self.written.append(data)
        if self.watch and self.watch in self.text:
            self.seen.set()

    def write_raw(self, data: str) -> None:
        self.written.append(data)

    @property
    def text(self) -> str:
        return ''.join(self.written)


async def run_chat(
    agent: AbstractAgent[None, object],
    *,
    tmp_path: Path,
    text: str = '',
    script: Script | None = None,
    plugins: Sequence[AgentCapability[None]] = (),
    settings: Settings | None = None,
    width: int = 120,
    terminal: DummyOutput | None = None,
) -> str:
    """Send `text` up front, run `script` alongside the shell, and return the console output."""
    output = io.StringIO()
    with create_pipe_input() as pipe, create_app_session(input=pipe, output=terminal or DummyOutput()):
        pipe.send_text(text)
        async with anyio.create_task_group() as tasks:
            if script is not None:
                tasks.start_soon(script, pipe)
            await chat(
                agent,
                deps=None,
                plugins=plugins,
                settings=settings,
                console=Console(file=output, width=width),
                store=SettingsStore(tmp_path / 'config.db'),
            )
    return output.getvalue()


def blocking_agent(*, started: anyio.Event, release: anyio.Event | None = None) -> Agent[None, str]:
    """An agent whose first tool call blocks until `release` (or cancellation); later calls return at once."""
    agent = Agent(TestModel(custom_output_text='never'))
    calls = 0

    @agent.tool_plain
    async def wait() -> str:
        nonlocal calls
        calls += 1
        if calls == 1:
            started.set()
            if release is None:
                await anyio.sleep_forever()
            else:
                await release.wait()
        return 'ok'

    return agent
