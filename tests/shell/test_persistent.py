"""The opt-in `shell` tool: commands that outlive the run, with a bounded foreground wait."""

import json
import os
import shlex
import sys
from collections.abc import Callable, Sequence
from pathlib import Path

import anyio
import pytest
from anyio.abc import SocketAttribute, SocketStream
from anyio.to_thread import run_sync
from pydantic_ai import Agent, RunContext
from pydantic_ai.capabilities import AbstractCapability, on_event
from pydantic_ai.models.test import TestModel

from pydantic_ai_harness.shell import (
    MAX_FOREGROUND_WAIT,
    RUN_SCOPED_TOOL_NAMES,
    SHELL_TOOL_NAMES,
    CommandFinishedEvent,
    CommandOutputEvent,
    CommandStartedEvent,
    Shell,
)

from .._tool_calls import call_tool

pytestmark = pytest.mark.anyio

posix_only = pytest.mark.skipif(os.name == 'nt', reason='POSIX process groups')


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


async def shell(
    cwd: Path,
    arguments: dict[str, object],
    *,
    capabilities: Sequence[AbstractCapability[None]] = (),
    **settings: object,
) -> str:
    capability = Shell[None](cwd=cwd, denied_commands=[], allow_interactive=True, tools=['shell'], **settings)  # pyright: ignore[reportArgumentType]
    return await call_tool([capability, *capabilities], 'shell', arguments)


class Recorder(AbstractCapability[None]):
    def __init__(self) -> None:
        self.events: list[CommandStartedEvent | CommandOutputEvent | CommandFinishedEvent] = []

    @on_event(CommandStartedEvent, CommandOutputEvent, CommandFinishedEvent)
    async def observe(
        self, ctx: RunContext[None], event: CommandStartedEvent | CommandOutputEvent | CommandFinishedEvent
    ) -> None:
        self.events.append(event)

    @property
    def output(self) -> str:
        return ''.join(event.text for event in self.events if isinstance(event, CommandOutputEvent))

    @property
    def finished(self) -> CommandFinishedEvent:
        last = self.events[-1]
        assert isinstance(last, CommandFinishedEvent)
        return last


class TestToolSelection:
    async def test_default_tools_are_run_scoped(self, tmp_path: Path) -> None:
        model = TestModel(call_tools=[])
        await Agent(model, capabilities=[Shell(cwd=tmp_path)]).run('Inspect tools')
        assert model.last_model_request_parameters is not None
        names = [tool.name for tool in model.last_model_request_parameters.function_tools]
        assert names == list(RUN_SCOPED_TOOL_NAMES)

    async def test_selected_tools(self, tmp_path: Path) -> None:
        model = TestModel(call_tools=[])
        await Agent(model, capabilities=[Shell(cwd=tmp_path, tools=['shell', 'run_command'])]).run('Inspect tools')
        assert model.last_model_request_parameters is not None
        names = [tool.name for tool in model.last_model_request_parameters.function_tools]
        assert names == ['run_command', 'shell']
        assert set(SHELL_TOOL_NAMES) == {*RUN_SCOPED_TOOL_NAMES, 'shell'}

    def test_unknown_tool_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match='Unknown shell tools: bogus'):
            Shell(cwd=tmp_path, tools=['bogus']).get_toolset()

    def test_default_timeout_bounded_for_shell(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match='default_timeout must be at most 270'):
            Shell(cwd=tmp_path, tools=['shell'], default_timeout=MAX_FOREGROUND_WAIT + 1).get_toolset()
        Shell(cwd=tmp_path, default_timeout=MAX_FOREGROUND_WAIT + 1).get_toolset()


class TestShellTool:
    async def test_foreground(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv('OPENAI_API_KEY', 'do-not-expose')
        output = await shell(tmp_path, {'command': 'mkdir child; printf hello; exit 7'})
        assert 'hello' in output and '"exit_code": 7' in output
        assert (tmp_path / 'child').is_dir()
        output = await shell(
            tmp_path, {'command': 'printf "${OPENAI_API_KEY-unset}"'}, denied_env_patterns=['OPENAI_*']
        )
        assert 'unset' in output and 'do-not-expose' not in output

    async def test_events(self, tmp_path: Path) -> None:
        recorder = Recorder()
        result = await shell(tmp_path, {'command': 'printf hello'}, capabilities=[recorder])
        assert 'hello' in result
        started = recorder.events[0]
        assert isinstance(started, CommandStartedEvent)
        assert started.command == 'printf hello'
        assert recorder.output == 'hello'
        assert recorder.finished.total_lines == 1
        assert recorder.finished.exit_code == 0
        assert not recorder.finished.truncated

    async def test_partial_utf8_is_decoded_across_chunks(self, tmp_path: Path) -> None:
        recorder = Recorder()
        await shell(tmp_path, {'command': "printf '\\342\\202'"}, capabilities=[recorder])
        assert recorder.output == '\ufffd'

    async def test_large_sparse_log_is_not_scanned(self, tmp_path: Path) -> None:
        recorder = Recorder()
        script = 'import os; os.ftruncate(1, 1 << 32)'
        command = f'{shlex.quote(sys.executable)} -c {shlex.quote(script)}'
        await shell(tmp_path, {'command': command}, capabilities=[recorder])
        assert recorder.finished.total_lines is None
        assert recorder.finished.truncated

    @posix_only
    async def test_output_arrives_before_command_exit(self, tmp_path: Path) -> None:
        release = tmp_path / 'release.pipe'
        os.mkfifo(release)
        recorder = Recorder()

        class Releaser(AbstractCapability[None]):
            @on_event(CommandOutputEvent)
            async def output(self, ctx: RunContext[None], event: CommandOutputEvent) -> None:
                if 'ready' in event.text:
                    await run_sync(release.write_text, 'continue\n')

        result = await shell(
            tmp_path,
            {'command': 'printf ready; read reply < release.pipe; printf done', 'timeout': 5},
            capabilities=[Releaser(), recorder],
        )
        assert 'readydone' in result
        assert recorder.finished.exit_code == 0

    @pytest.mark.parametrize('timeout', [0, 271])
    async def test_timeout_validation(self, tmp_path: Path, timeout: int) -> None:
        assert 'timeout must' in await shell(tmp_path, {'command': 'echo hi', 'timeout': timeout})

    async def test_policy_applies(self, tmp_path: Path) -> None:
        assert 'NUL' in await shell(tmp_path, {'command': 'echo \0'})
        capability = Shell[None](cwd=tmp_path, allowed_commands=['echo'], tools=['shell'])
        assert 'not in the allowed list' in await call_tool([capability], 'shell', {'command': 'printf hi'})

    async def test_missing_working_directory(self, tmp_path: Path) -> None:
        assert 'no longer exists' in await shell(tmp_path / 'absent', {'command': 'echo hi'})

    async def test_supervisor_failure(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv('PYTHONHOME', str(tmp_path / 'missing-python'))
        assert 'Shell supervisor exited' in await shell(tmp_path, {'command': 'echo hi'})


@posix_only
class TestLifecycle:
    @pytest.mark.parametrize('mode', ['foreground', 'background'])
    async def test_process_survives_run(self, tmp_path: Path, mode: str) -> None:
        connected = anyio.Event()
        release = anyio.Event()
        completed = anyio.Event()
        status: Path | None = None
        listener = await anyio.create_tcp_listener(local_host='127.0.0.1')
        port = listener.extra(SocketAttribute.local_address)[1]

        async def serve(stream: SocketStream) -> None:
            async with stream:
                assert await stream.receive() == b'ready'
                connected.set()
                await release.wait()
                await stream.send(b'finish')
                assert await stream.receive() == b'done'
                completed.set()

        script = (
            f'import socket; s=socket.create_connection(("127.0.0.1", {port})); '
            's.sendall(b"ready"); s.recv(100); s.sendall(b"done"); s.close(); print("completed")'
        )
        async with listener, anyio.create_task_group() as group:
            group.start_soon(listener.serve, serve)
            command = f'{shlex.quote(sys.executable)} -c {shlex.quote(script)}'
            output = await shell(tmp_path, {'command': command, 'mode': mode, 'timeout': 0.01})
            pid = int(output.split('PID: ')[1].split()[0])
            status = Path(output.split('Status: ')[1].splitlines()[0])
            try:
                with anyio.fail_after(10):
                    await connected.wait()
                    # The Agent.run above has returned; the command still waits on our event.
                    os.kill(pid, 0)
                    state = json.loads(status.read_text())
                    assert state['exit_code'] is None
                    release.set()
                    await completed.wait()
            finally:
                release.set()
                group.cancel_scope.cancel()
        assert status is not None
        # Inspect completion using the same tool the agent has.
        script = (
            'import json, pathlib, time; '
            f'p=pathlib.Path({str(status)!r}); '
            '\nwhile json.loads(p.read_text())["exit_code"] is None: time.sleep(0.01)'
            '\nprint(p.read_text())'
        )
        result = await shell(tmp_path, {'command': f'{shlex.quote(sys.executable)} -c {shlex.quote(script)}'})
        assert '"exit_code": 0' in result
        assert status.with_name('output.log').read_text() == 'completed\n'

    async def test_cancelled_finalization_terminates_process(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        entered = anyio.Event()
        pids: list[int] = []

        async def blocked_count(function: Callable[[Path], int | None], path: Path) -> int | None:
            status = path.with_name('status.json')
            with anyio.fail_after(10):
                while not status.exists():
                    await anyio.sleep(0.01)
            pids.append(json.loads(status.read_text())['pid'])
            entered.set()
            await anyio.sleep_forever()

        monkeypatch.setattr('pydantic_ai_harness.shell._persistent.run_sync', blocked_count)

        async def run() -> None:
            await shell(tmp_path, {'command': 'sleep 60', 'mode': 'background'})

        async with anyio.create_task_group() as group:
            group.start_soon(run)
            with anyio.fail_after(10):
                await entered.wait()
            group.cancel_scope.cancel()
        with pytest.raises(ProcessLookupError):
            os.kill(pids[0], 0)

    async def test_cancelled_foreground_terminates_process(self, tmp_path: Path) -> None:
        connected = anyio.Event()
        listener = await anyio.create_tcp_listener(local_host='127.0.0.1')
        port = listener.extra(SocketAttribute.local_address)[1]
        pid_file = tmp_path / 'pid'

        async def serve(stream: SocketStream) -> None:
            async with stream:
                assert await stream.receive() == b'ready'
                connected.set()
                await anyio.sleep_forever()

        script = (
            'import os, pathlib, socket; '
            f'pathlib.Path({str(pid_file)!r}).write_text(str(os.getpgrp())); '
            f's=socket.create_connection(("127.0.0.1", {port})); s.sendall(b"ready"); s.recv(1)'
        )

        async def run() -> None:
            await shell(tmp_path, {'command': f'{shlex.quote(sys.executable)} -c {shlex.quote(script)}'})

        async with listener, anyio.create_task_group() as group:
            group.start_soon(listener.serve, serve)
            group.start_soon(run)
            with anyio.fail_after(10):
                await connected.wait()
            group.cancel_scope.cancel()
        pid = int(pid_file.read_text())
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
