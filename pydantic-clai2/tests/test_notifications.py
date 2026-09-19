"""Native notifications through the public plugin host and loader."""

import asyncio
import io
import json
import os
import sys
from collections.abc import AsyncIterator, Callable, Iterator
from pathlib import Path
from subprocess import DEVNULL, CompletedProcess

import anyio
import pytest
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, DeltaToolCalls, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai_harness.ask_user import AskUser, AskUserRequest, AskUserResponse
from rich.console import Console

from pydantic_clai2 import DEFAULT_PLUGINS, notifications
from pydantic_clai2.commands import Commands
from pydantic_clai2.interrupts import Interrupts
from pydantic_clai2.plugin_loader import PluginLoader
from pydantic_clai2.plugins import SessionStart, TurnEnd, TurnStart
from pydantic_clai2.settings_store import SettingsStore

READINESS_TIMEOUT = 15
SECRET = 'private "text"; $(touch /tmp/clai-notification-injection)\nwith tool output'


class Processes:
    def __init__(self) -> None:
        self.commands: list[list[str]] = []
        self.environments: list[dict[str, str]] = []
        self.exit_code = 0
        self.error: OSError | None = None

    async def __call__(
        self, command: list[str], *, stdin: int, stdout: int, stderr: int, env: dict[str, str], check: bool
    ) -> CompletedProcess[bytes]:
        assert stdin == stdout == stderr == DEVNULL
        assert check is False
        self.commands.append(command)
        self.environments.append(env)
        if self.error is not None:
            raise self.error
        return await anyio.run_process(
            [sys.executable, '-c', 'import sys; sys.exit(int(sys.argv[1]))', str(self.exit_code)],
            stdin=stdin,
            stdout=stdout,
            stderr=stderr,
            check=check,
            env=env,
        )


@pytest.fixture
def processes(monkeypatch: pytest.MonkeyPatch) -> Processes:
    processes = Processes()
    monkeypatch.setattr(notifications, 'run_process', processes)
    monkeypatch.setattr(notifications, 'platform', 'darwin')
    return processes


@pytest.fixture
def loader_factory(tmp_path: Path) -> Iterator[Callable[[], PluginLoader[None]]]:
    store = SettingsStore(tmp_path / 'settings.db')
    output = io.StringIO()

    def create() -> PluginLoader[None]:
        return PluginLoader(
            store=store,
            console=Console(file=output),
            commands=Commands(),
            session_start=lambda: SessionStart(agent=Agent(TestModel()), settings=store.load()),
            builtin=tuple(plugin for plugin in DEFAULT_PLUGINS if plugin.id == 'notifications'),
        )

    yield create
    assert output.getvalue() == ''


async def test_default_delivery_is_private_and_platform_native(
    loader_factory: Callable[[], PluginLoader[None]], processes: Processes, monkeypatch: pytest.MonkeyPatch
) -> None:
    loader = loader_factory()
    await loader.load_all()
    (entry,) = loader.entries()
    assert entry.builtin and entry.state == 'enabled, loaded'
    await loader.fire(TurnStart(text=SECRET))
    await loader.fire(TurnEnd(text=SECRET, outcome='cancelled'))
    assert processes.commands == []
    result = await Agent(TestModel(custom_output_text=SECRET)).run(SECRET)
    await loader.fire(TurnEnd(text=SECRET, outcome='completed', result=result))
    await loader.fire(TurnEnd(text=SECRET, outcome='failed', error=ValueError(SECRET)))
    script = 'on run argv\ndisplay notification (item 1 of argv) with title "CLAI2"\nend run'
    assert processes.commands == [
        ['/usr/bin/osascript', '-e', script, 'Turn completed.'],
        ['/usr/bin/osascript', '-e', script, 'Turn failed. Return to CLAI2 for details.'],
    ]
    monkeypatch.setattr(notifications, 'platform', 'linux')
    await loader.fire(TurnEnd(text=SECRET, outcome='completed'))
    assert processes.commands[-1] == ['/usr/bin/notify-send', '--app-name=CLAI2', '--', 'CLAI2', 'Turn completed.']
    await loader.close('exit')
    assert len(processes.commands) == 3


@pytest.mark.parametrize('platform', ['darwin', 'linux'])
async def test_delivery_ignores_path_and_does_not_inherit_credentials(
    platform: str,
    loader_factory: Callable[[], PluginLoader[None]],
    processes: Processes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(notifications, 'platform', platform)
    monkeypatch.setenv('PATH', '/untrusted/workspace/bin')
    monkeypatch.setenv('OPENAI_API_KEY', 'fake-provider-secret')
    monkeypatch.setenv('LD_PRELOAD', '/untrusted/workspace/payload.so')
    monkeypatch.setenv('DISPLAY', ':42')
    monkeypatch.setenv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/tmp/test-session-bus')
    loader = loader_factory()
    await loader.load_all()
    await loader.fire(TurnEnd(text=SECRET, outcome='completed'))
    assert processes.commands[0][0] == ('/usr/bin/osascript' if platform == 'darwin' else '/usr/bin/notify-send')
    environment = processes.environments[0]
    assert environment['DISPLAY'] == ':42'
    assert environment['DBUS_SESSION_BUS_ADDRESS'] == 'unix:path=/tmp/test-session-bus'
    assert environment.keys() <= {
        'DISPLAY',
        'WAYLAND_DISPLAY',
        'DBUS_SESSION_BUS_ADDRESS',
        'XDG_RUNTIME_DIR',
        'XAUTHORITY',
    }
    assert not {'PATH', 'OPENAI_API_KEY', 'LD_PRELOAD'} & environment.keys()
    await loader.close('exit')


async def test_disable_enable_reload_and_remove_use_the_loader(
    loader_factory: Callable[[], PluginLoader[None]], processes: Processes, monkeypatch: pytest.MonkeyPatch
) -> None:
    loader = loader_factory()
    await loader.load_all()
    assert await loader.command(['disable', 'notifications']) == 'Disabled notifications.'
    await loader.fire(TurnEnd(text=SECRET, outcome='completed'))
    restarted = loader_factory()
    await restarted.load_all()
    await restarted.fire(TurnEnd(text=SECRET, outcome='completed'))
    assert restarted.entries()[0].state == 'disabled'
    assert processes.commands == []
    assert await restarted.command(['enable', 'notifications']) == 'Enabled notifications.'
    await restarted.fire(TurnEnd(text=SECRET, outcome='completed'))
    assert len(processes.commands) == 1
    await restarted.command(['reload', 'notifications'])
    # Reload restores imports; keep native delivery isolated from the desktop.
    monkeypatch.setattr(notifications, 'run_process', processes)
    monkeypatch.setattr(notifications, 'platform', 'darwin')
    await restarted.fire(TurnEnd(text=SECRET, outcome='completed'))
    assert len(processes.commands) == 2
    await restarted.command(['disable', 'notifications'])
    assert 'restored its defaults' in await restarted.command(['remove', 'notifications'])
    await restarted.fire(TurnEnd(text=SECRET, outcome='completed'))
    assert len(processes.commands) == 3
    await restarted.close('exit')


@pytest.mark.parametrize('unavailable', ['available', 'unsupported', 'missing', 'denied', 'nonzero'])
async def test_questions_notify_before_answering_and_delivery_errors_are_harmless(
    unavailable: str,
    loader_factory: Callable[[], PluginLoader[None]],
    processes: Processes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if unavailable == 'unsupported':
        monkeypatch.setattr(notifications, 'platform', 'win32')
    elif unavailable == 'missing':
        processes.error = FileNotFoundError('no notification utility')
    elif unavailable == 'denied':
        processes.error = PermissionError('notification permission denied')
    elif unavailable == 'nonzero':
        processes.exit_code = 1
    loader = loader_factory()
    await loader.load_all()
    answered: list[AskUserRequest] = []

    async def answer(request: AskUserRequest) -> AskUserResponse:
        assert len(processes.commands) == (0 if unavailable == 'unsupported' else 1)
        answered.append(request)
        return AskUserResponse(cancelled=True)

    async def respond(messages: list[ModelMessage], info: AgentInfo) -> AsyncIterator[str | DeltaToolCalls]:
        if len(messages) == 1:
            yield {
                0: DeltaToolCall(
                    name='ask_user_question',
                    json_args=json.dumps(
                        {
                            'questions': [
                                {'header': 'Private', 'question': SECRET, 'options': [{'label': 'A'}, {'label': 'B'}]}
                            ]
                        }
                    ),
                )
            }
        else:
            yield 'done'

    agent = Agent(
        FunctionModel(stream_function=respond),
        deps_type=type(None),
        capabilities=[AskUser(answerer=answer), *loader.capabilities()],
    )
    result = await agent.run(SECRET)
    assert result.output == 'done' and len(answered) == 1
    await loader.fire(TurnEnd(text=SECRET, outcome='failed', error=ValueError(SECRET)))
    if unavailable != 'unsupported':
        assert [command[-1] for command in processes.commands] == [
            'Your input is needed. Return to CLAI2 to answer.',
            'Turn failed. Return to CLAI2 for details.',
        ]
    assert all(SECRET not in argument for command in processes.commands for argument in command)
    await loader.close('exit')


@pytest.mark.skipif(sys.platform == 'win32', reason='POSIX file descriptors and process existence check')
@pytest.mark.parametrize('cancel', [False, True], ids=['timeout', 'outer-cancellation'])
async def test_async_delivery_reaps_the_child_on_timeout_or_cancellation(
    cancel: bool, loader_factory: Callable[[], PluginLoader[None]], monkeypatch: pytest.MonkeyPatch
) -> None:
    read_fd, write_fd = os.pipe()
    scopes: list[anyio.CancelScope] = []
    completed: list[bool] = []
    finished = anyio.Event()
    pid: int | None = None

    async def run_process(
        command: list[str], *, stdin: int, stdout: int, stderr: int, env: dict[str, str], check: bool
    ) -> CompletedProcess[bytes]:
        return await anyio.run_process(
            [
                sys.executable,
                '-c',
                'import os, sys, time; os.write(int(sys.argv[1]), str(os.getpid()).encode()); time.sleep(60)',
                str(write_fd),
            ],
            stdin=stdin,
            stdout=stdout,
            stderr=stderr,
            check=check,
            pass_fds=(write_fd,),
        )

    monkeypatch.setattr(notifications, 'run_process', run_process)
    monkeypatch.setattr(notifications, 'platform', 'linux')
    loader = loader_factory()
    await loader.load_all()

    async def deliver() -> None:
        with anyio.CancelScope() as scope:
            scopes.append(scope)
            await loader.fire(TurnEnd(text=SECRET, outcome='completed'))
            completed.append(True)
        finished.set()

    try:
        with anyio.fail_after(READINESS_TIMEOUT):
            async with anyio.create_task_group() as workers:
                workers.start_soon(deliver)
                await anyio.wait_readable(read_fd)
                pid = int(os.read(read_fd, 100))
                assert completed == []
                if cancel:
                    scopes[0].cancel()
                await finished.wait()
        assert completed == ([] if cancel else [True])
        assert pid is not None
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
    finally:
        os.close(read_fd)
        os.close(write_fd)
        await loader.close('exit')


@pytest.mark.skipif(sys.platform == 'win32', reason='POSIX file descriptors and process existence check')
@pytest.mark.parametrize('through_interrupts', [False, True])
async def test_native_cancellation_reaps_child_and_stays_cancelled(
    through_interrupts: bool, loader_factory: Callable[[], PluginLoader[None]], monkeypatch: pytest.MonkeyPatch
) -> None:
    read_fd, write_fd = os.pipe()

    async def run_process(
        command: list[str], *, stdin: int, stdout: int, stderr: int, env: dict[str, str], check: bool
    ) -> CompletedProcess[bytes]:
        return await anyio.run_process(
            [
                sys.executable,
                '-c',
                'import os, sys, time; os.write(int(sys.argv[1]), str(os.getpid()).encode()); time.sleep(60)',
                str(write_fd),
            ],
            stdin=stdin,
            stdout=stdout,
            stderr=stderr,
            check=check,
            pass_fds=(write_fd,),
        )

    monkeypatch.setattr(notifications, 'run_process', run_process)
    monkeypatch.setattr(notifications, 'platform', 'linux')
    loader = loader_factory()
    await loader.load_all()
    interrupts = Interrupts()
    completed: list[bool] = []

    async def deliver() -> None:
        await loader.fire(TurnEnd(text=SECRET, outcome='completed'))
        completed.append(True)

    async def interruptible() -> None:
        assert not await interrupts.run(deliver())

    task = asyncio.create_task(interruptible() if through_interrupts else deliver())
    try:
        with anyio.fail_after(READINESS_TIMEOUT):
            await anyio.wait_readable(read_fd)
            pid = int(os.read(read_fd, 100))
            if through_interrupts:
                assert interrupts.cancel()
                await task
            else:
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
        assert completed == []
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        os.close(read_fd)
        os.close(write_fd)
        await loader.close('exit')
