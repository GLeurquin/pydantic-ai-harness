"""The prompt stays open during a turn: queued input, Esc, and output above the prompt."""

import sys
from pathlib import Path

import anyio
import pytest
from chat_driver import RecordingOutput, blocking_agent, run_chat
from prompt_toolkit import PromptSession
from prompt_toolkit.application import create_app_session
from prompt_toolkit.input import PipeInput, create_pipe_input
from prompt_toolkit.keys import Keys
from prompt_toolkit.output import DummyOutput
from pydantic_ai import RunContext
from pydantic_ai.capabilities import AbstractCapability

from pydantic_clai2.prompt_keys import ESCAPE_FLUSH_SECONDS, KEY_SEQUENCE_SECONDS, bind_prompt_keys
from pydantic_clai2.prompt_output import PromptOutput, output_above_prompt


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


class Prompts(AbstractCapability[None]):
    def __init__(self) -> None:
        self.seen: list[str] = []

    async def before_run(self, ctx: RunContext[None]) -> None:
        self.seen.append(str(ctx.prompt))


async def test_input_during_a_turn_is_queued_and_runs_after(tmp_path: Path) -> None:
    started = anyio.Event()
    release = anyio.Event()
    prompts = Prompts()
    terminal = RecordingOutput(watch='3 queued')

    async def type_ahead(pipe: PipeInput) -> None:
        await started.wait()
        pipe.send_text('\n')
        pipe.send_text('second\n')
        pipe.send_text('/new\n')
        pipe.send_text('/exit\n')
        await terminal.seen.wait()
        release.set()

    output = await run_chat(
        blocking_agent(started=started, release=release),
        tmp_path=tmp_path,
        text='first\n',
        script=type_ahead,
        plugins=[prompts],
        terminal=terminal,
    )
    assert prompts.seen == ['first', 'second']
    first = output.index('Queued until this turn ends (1 waiting).')
    third = output.index('Queued until this turn ends (3 waiting).')
    echo = output.index('> second')
    assert first < third < echo < output.index('Conversation cleared.') < output.index('Goodbye.')
    assert output.count('never') == 2
    assert '3 queued' in terminal.text


async def test_escape_cancels_the_turn_and_keeps_the_draft(tmp_path: Path) -> None:
    started = anyio.Event()
    prompts = Prompts()

    async def press_escape(pipe: PipeInput) -> None:
        await started.wait()
        # A key after ESC resolves it as a bare Escape without waiting for the sequence timeout.
        pipe.send_text('\x1bx')
        pipe.send_text(' is kept\n/exit\n')

    output = await run_chat(
        blocking_agent(started=started), tmp_path=tmp_path, text='run\n', script=press_escape, plugins=[prompts]
    )
    assert 'Turn cancelled.' in output
    assert prompts.seen == ['run', 'x is kept']
    assert output.count('never') == 1


async def test_escape_at_idle_does_nothing(tmp_path: Path) -> None:
    output = await run_chat(blocking_agent(started=anyio.Event()), tmp_path=tmp_path, text='\x1bx\x03/exit\n')
    assert 'Turn cancelled' not in output
    assert 'Input cleared' in output


def test_escape_binding_and_short_timeouts() -> None:
    with create_pipe_input() as pipe, create_app_session(input=pipe, output=DummyOutput()):
        prompt = PromptSession[str]()
        bind_prompt_keys(prompt, cancel=lambda: None)
        assert prompt.app.ttimeoutlen == ESCAPE_FLUSH_SECONDS
        assert prompt.app.timeoutlen == KEY_SEQUENCE_SECONDS
        assert ESCAPE_FLUSH_SECONDS + KEY_SEQUENCE_SECONDS < 0.5
        assert prompt.key_bindings is not None
        assert prompt.key_bindings.get_bindings_for_keys((Keys.Escape,))


async def test_prompt_output_writes_whole_lines_above_the_prompt() -> None:
    terminal = RecordingOutput(tty=True)
    with create_pipe_input() as pipe, create_app_session(input=pipe, output=terminal):
        async with anyio.create_task_group() as tasks:
            prompt = PromptSession[str]()
            proxy = PromptOutput(prompt.output)
            assert proxy.isatty()
            assert proxy.encoding == 'utf-8'
            proxy.write('partial')
            proxy.flush()
            assert terminal.written == []
            tasks.start_soon(prompt.prompt_async, '> ')
            proxy.write(' line\nsecond\ntail')
            proxy.write(' end')
            await proxy.aclose()
            assert 'partial line\nsecond\ntail end' in terminal.text
            pipe.send_text('\n')


async def test_output_above_prompt_patches_and_restores_streams() -> None:
    terminal = RecordingOutput()
    original = sys.stdout, sys.stderr
    async with output_above_prompt(terminal):
        print('hello')
        print('partial', end='', file=sys.stderr)
        assert sys.stdout is sys.stderr
        assert not sys.stdout.isatty()
    assert (sys.stdout, sys.stderr) == original
    assert terminal.text == 'hello\npartial'
