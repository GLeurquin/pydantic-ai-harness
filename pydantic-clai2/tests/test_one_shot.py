"""Non-interactive one-shot mode: exit codes, stdin handling, output formats, and the CLI wiring."""

import io
import json
import os
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

import anyio
import pytest
from pydantic_ai import Agent, ModelRequestContext, RunContext
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.messages import ModelMessagesTypeAdapter, ModelRequest, ModelResponse, ToolCallPart, UserPromptPart
from pydantic_ai.models.test import TestModel

from pydantic_clai2 import DEFAULT_PLUGINS, one_shot
from pydantic_clai2._cli import run
from pydantic_clai2._one_shot import read_prompt
from pydantic_clai2.config import Settings
from pydantic_clai2.settings_store import SettingsStore


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


class Tty(io.StringIO):
    def isatty(self) -> bool:
        return True


class Pipe(io.StringIO):
    def isatty(self) -> bool:
        return False


RECORDER = """
from pydantic_clai2.plugins import PluginHost, SessionEnd, SessionStart, TurnEnd, TurnStart

def activate(host: PluginHost) -> None:
    @host.on('session_start')
    async def started(event: SessionStart) -> None:
        host.console.print('plugin: session_start')

    @host.on('turn_start')
    async def before(event: TurnStart) -> None:
        host.console.print('plugin: turn_start ' + event.text)

    @host.on('turn_end')
    async def after(event: TurnEnd) -> None:
        host.console.print('plugin: turn_end ' + event.outcome)

    @host.on('session_end')
    async def stopped(event: SessionEnd) -> None:
        host.console.print('plugin: session_end ' + event.reason)
"""


def recorder_store(tmp_path: Path) -> SettingsStore:
    store = SettingsStore(tmp_path / 'config.db')
    store.plugins_dir.mkdir()
    (store.plugins_dir / 'recorder.py').write_text(RECORDER)
    return store


@pytest.mark.parametrize(
    ('argument', 'stdin', 'expected'),
    [
        (None, Tty(), None),
        ('hi', Tty(), 'hi'),
        (None, Pipe('  piped text \n'), 'piped text'),
        (None, Pipe(''), None),
        ('hi', Pipe(' \n'), 'hi'),
        ('summarise', Pipe('\n  def body():\n      pass\n\n'), 'summarise\n\n```\n  def body():\n      pass\n```'),
        ('summarise', Pipe('a ```` b'), 'summarise\n\n`````\na ```` b\n`````'),
    ],
)
def test_read_prompt(argument: str | None, stdin: io.StringIO, expected: str | None) -> None:
    assert read_prompt(argument, stdin=stdin) == expected


async def test_text_to_pipe_streams_progress_to_stderr(tmp_path: Path) -> None:
    stdout, stderr = Pipe(), Pipe()
    code = await one_shot(
        Agent(TestModel(custom_output_text='# Four\n')),
        'what is 2+2',
        deps=None,
        store=recorder_store(tmp_path),
        stdout=stdout,
        stderr=stderr,
    )
    assert code == 0
    assert stdout.getvalue() == '# Four\n'
    progress = stderr.getvalue()
    assert 'Four' in progress
    assert progress.index('plugin: session_start') < progress.index('plugin: turn_start what is 2+2')
    assert progress.index('plugin: turn_end completed') < progress.index('plugin: session_end exit')


async def test_text_to_terminal_streams_answer_to_stdout(tmp_path: Path) -> None:
    stdout, stderr = Tty(), Pipe()
    code = await one_shot(
        Agent(TestModel(custom_output_text='four')),
        'what is 2+2',
        deps=None,
        store=SettingsStore(tmp_path / 'config.db'),
        stdout=stdout,
        stderr=stderr,
    )
    assert code == 0
    assert 'four' in stdout.getvalue()
    assert 'four' not in stderr.getvalue()


async def test_structured_output_is_printed_once(tmp_path: Path) -> None:
    stdout, stderr = Pipe(), Pipe()
    code = await one_shot(
        Agent(TestModel(), output_type=list[int]),
        'numbers',
        deps=None,
        store=SettingsStore(tmp_path / 'config.db'),
        stdout=stdout,
        stderr=stderr,
    )
    assert code == 0
    assert stdout.getvalue() == '[0]\n'
    assert '[0]' in stderr.getvalue()


class Priced(AbstractCapability[None]):
    async def after_model_request(
        self, ctx: RunContext[None], *, request_context: ModelRequestContext, response: ModelResponse
    ) -> ModelResponse:
        response.usage.cost = Decimal('0.25')
        return response


@pytest.mark.parametrize('priced', [False, True])
async def test_json_output_round_trips(tmp_path: Path, priced: bool) -> None:
    stdout, stderr = Pipe(), Pipe()
    history = [ModelRequest(parts=[UserPromptPart('earlier')])]
    code = await one_shot(
        Agent(TestModel(custom_output_text='four'), deps_type=type(None), capabilities=[Priced()] if priced else []),
        'what is 2+2',
        deps=None,
        store=SettingsStore(tmp_path / 'config.db'),
        output_format='json',
        message_history=history,
        stdout=stdout,
        stderr=stderr,
    )
    assert code == 0
    payload = json.loads(stdout.getvalue())
    assert set(payload) == {'text', 'usage', 'cost', 'messages'}
    assert payload['text'] == 'four'
    assert payload['usage']['requests'] == 1
    assert payload['usage']['output_tokens'] > 0
    assert 'cost' not in payload['usage']
    assert payload['cost'] == (0.25 if priced else None)
    messages = ModelMessagesTypeAdapter.validate_python(payload['messages'])
    assert ModelMessagesTypeAdapter.dump_python(messages, mode='json') == payload['messages']
    prompts = [
        part.content
        for message in messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, UserPromptPart)
    ]
    assert prompts == ['earlier', 'what is 2+2']
    assert 'four' in stderr.getvalue()


async def test_builtin_coder_tools_are_available(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    stdout, stderr = Pipe(), Pipe()
    code = await one_shot(
        Agent(TestModel(call_tools=['list_files'])),
        'list',
        deps=None,
        store=SettingsStore(tmp_path / 'config.db'),
        builtin_plugins=DEFAULT_PLUGINS,
        output_format='json',
        stdout=stdout,
        stderr=stderr,
    )
    assert code == 0
    messages = ModelMessagesTypeAdapter.validate_python(json.loads(stdout.getvalue())['messages'])
    calls = [
        part.tool_name
        for message in messages
        if isinstance(message, ModelResponse)
        for part in message.parts
        if isinstance(part, ToolCallPart)
    ]
    assert calls == ['list_files']


class Broken(AbstractCapability[None]):
    async def before_model_request(
        self, ctx: RunContext[None], request_context: ModelRequestContext
    ) -> ModelRequestContext:
        raise ValueError('broken provider')


async def test_failed_turn_exits_one(tmp_path: Path) -> None:
    stdout, stderr = Pipe(), Pipe()
    code = await one_shot(
        Agent(TestModel(), deps_type=type(None), capabilities=[Broken()]),
        'hi',
        deps=None,
        store=recorder_store(tmp_path),
        output_format='json',
        stdout=stdout,
        stderr=stderr,
    )
    assert code == 1
    assert stdout.getvalue() == ''
    assert 'broken provider' in stderr.getvalue()
    assert 'plugin: turn_end failed' in stderr.getvalue()
    assert 'plugin: session_end error' in stderr.getvalue()


async def test_missing_model_exits_one(tmp_path: Path) -> None:
    stdout, stderr = Pipe(), Pipe()
    code = await one_shot(
        Agent(deps_type=type(None)),
        'hi',
        deps=None,
        settings=Settings(model=None),
        store=SettingsStore(tmp_path / 'config.db'),
        stdout=stdout,
        stderr=stderr,
    )
    assert code == 1
    assert 'No model configured' in stderr.getvalue()


async def test_cancellation_propagates_after_turn_end(tmp_path: Path) -> None:
    started = anyio.Event()
    agent = Agent(TestModel(), deps_type=type(None))
    scope = anyio.CancelScope()

    @agent.tool_plain
    async def wait() -> str:
        started.set()
        await anyio.sleep_forever()
        return 'never'  # pragma: no cover

    stdout, stderr = Pipe(), Pipe()

    async def interrupted() -> None:
        with scope:
            await one_shot(agent, 'hi', deps=None, store=recorder_store(tmp_path), stdout=stdout, stderr=stderr)

    async with anyio.create_task_group() as tasks:
        tasks.start_soon(interrupted)
        await started.wait()
        scope.cancel()
    assert scope.cancelled_caught
    assert stdout.getvalue() == ''
    assert 'plugin: turn_end cancelled' in stderr.getvalue()
    assert 'plugin: session_end error' in stderr.getvalue()


def cli(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, *args: str, stdin: io.StringIO) -> None:
    store = SettingsStore(tmp_path / 'config.db')
    store.save_plugin(DEFAULT_PLUGINS[0].model_copy(update={'enabled': False}))
    monkeypatch.setattr(sys, 'argv', ['clai2', '--database', str(store.path), '--model', 'test', *args])
    monkeypatch.setattr(sys, 'stdin', stdin)


def test_cli_prompt_flag(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    cli(monkeypatch, tmp_path, '-p', 'hello', '--output-format', 'json', stdin=Tty())
    with pytest.raises(SystemExit) as exit_info:
        run()
    assert exit_info.value.code == 0
    captured = capsys.readouterr()
    assert 'read_clai_customization_guide' in json.loads(captured.out)['text']
    assert '● read_clai_customization_guide' in captured.err


def test_cli_stdin_prompt(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    cli(monkeypatch, tmp_path, stdin=Pipe('hello\n'))
    with pytest.raises(SystemExit) as exit_info:
        run()
    assert exit_info.value.code == 0
    captured = capsys.readouterr()
    assert captured.out.startswith('{"read_clai_customization_guide"') and captured.out.endswith('"}\n')
    assert 'read_clai_customization_guide' in captured.err


def test_cli_output_format_needs_a_prompt(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cli(monkeypatch, tmp_path, '--output-format', 'json', stdin=Tty())
    with pytest.raises(SystemExit) as exit_info:
        run()
    assert exit_info.value.code == 2


def test_cli_interrupt_exits_130(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    async def interrupted(*args: object, **kwargs: object) -> int:
        raise KeyboardInterrupt

    monkeypatch.setattr('pydantic_clai2._cli.one_shot', interrupted)
    cli(monkeypatch, tmp_path, '-p', 'hello', stdin=Tty())
    with pytest.raises(SystemExit) as exit_info:
        run()
    assert exit_info.value.code == 130


def test_cli_interactive_when_stdin_is_a_terminal(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    launched: list[Settings] = []

    async def chat(*args: object, settings: Settings, **kwargs: object) -> None:
        launched.append(settings)

    monkeypatch.setattr('pydantic_clai2._cli.chat', chat)
    cli(monkeypatch, tmp_path, stdin=Tty())
    run()
    assert [settings.model for settings in launched] == ['test']


def test_cli_pipes_end_to_end(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / 'config.db')
    store.save_plugin(DEFAULT_PLUGINS[0].model_copy(update={'enabled': False}))
    env = dict(os.environ, CLAI_MODEL='test')
    result = subprocess.run(
        [sys.executable, '-m', 'pydantic_clai2', '--database', str(store.path), '-p', 'summarise'],
        input='the body\n',
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.startswith('{"read_clai_customization_guide"')
    assert 'CLAI 2.0' not in result.stderr
