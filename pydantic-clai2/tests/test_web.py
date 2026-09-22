"""Browser entry point and shared noninteractive conversation behavior."""

from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path

import anyio
import pytest
from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel
from pydantic_ai_harness.step_persistence.conversations import SqliteConversationStore

from pydantic_clai2 import _cli, headless, web
from pydantic_clai2.config import Settings
from pydantic_clai2.project_settings import ProjectSettings
from pydantic_clai2.settings_store import SettingsStore


async def test_browser_conversation_persists_followups(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    model = TestModel(call_tools=[], custom_output_text='browser answer')
    agent = Agent(model)
    monkeypatch.setattr(headless, 'create_agent', lambda: agent)
    saved = SqliteConversationStore(database=tmp_path / 'sessions.db')
    with agent.override(model=model):
        async with headless.headless_session(
            settings=Settings(model='test'), store=SettingsStore(tmp_path / 'config.db'), project=ProjectSettings()
        ) as turn:
            assert await turn('first question') == 'browser answer'
            entries = await saved.listing()
            first = await saved.get(conversation_id=entries[0].id)
            assert await turn('follow up') == 'browser answer'
            second = await saved.get(conversation_id=entries[0].id)
    assert len(second.messages) > len(first.messages)
    assert len(await saved.listing()) == 1


async def test_browser_requires_model(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match='Choose a model'):
        async with headless.headless_session(
            settings=Settings(model=None), store=SettingsStore(tmp_path / 'config.db'), project=ProjectSettings()
        ):
            pytest.fail('Missing model accepted')


async def test_browser_lifecycle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    started = anyio.Event()
    closed: list[str] = []

    @asynccontextmanager
    async def session(
        *, settings: Settings, store: SettingsStore, project: ProjectSettings, resume: str | None
    ) -> AsyncGenerator[Callable[[str], Awaitable[str]]]:
        assert resume == 'saved'

        async def turn(text: str) -> str:
            return text

        try:
            yield turn
        finally:
            closed.append('session')

    @asynccontextmanager
    async def serve_chat(callback: Callable[[str], Awaitable[str]], *, port: int) -> AsyncGenerator[str]:
        assert port == 8765
        assert await callback('hello') == 'hello'
        try:
            yield 'http://127.0.0.1:8765/#token'
        finally:
            closed.append('server')

    async def wait() -> None:
        started.set()
        await anyio.sleep_forever()

    monkeypatch.setattr(web, 'headless_session', session)
    monkeypatch.setattr(web, 'serve_chat', serve_chat)
    monkeypatch.setattr(web, 'sleep_forever', wait)

    async def run() -> None:
        await web.run_web(
            settings=Settings(),
            store=SettingsStore(tmp_path / 'config.db'),
            project=ProjectSettings(),
            resume='saved',
            port=8765,
        )

    async with anyio.create_task_group() as tasks:
        tasks.start_soon(run)
        await started.wait()
        tasks.cancel_scope.cancel()
    assert closed == ['server', 'session']
    assert 'http://127.0.0.1:8765/#token' in capsys.readouterr().out


@pytest.mark.parametrize(
    'args',
    [
        ['--web', '-p', 'hello'],
        ['--web', 'config'],
        ['--web', 'plugins'],
        ['--web', '--resume'],
        ['--port', '1234'],
        ['--web', '--port', '-1'],
        ['--web', '--port', '65536'],
    ],
)
def test_invalid_web_options(monkeypatch: pytest.MonkeyPatch, args: list[str]) -> None:
    monkeypatch.setattr('sys.argv', ['clai2', *args])
    with pytest.raises(SystemExit) as error:
        _cli.run()
    assert error.value.code == 2


@pytest.mark.parametrize('port', [None, '8765'])
def test_cli_web(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, port: str | None) -> None:
    store = SettingsStore(tmp_path / 'config.db')
    args = ['clai2', '--web', '--database', str(store.path), '-m', 'test', '--resume', 'saved']
    if port is not None:
        args += ['--port', port]
    monkeypatch.setattr('sys.argv', args)
    called: list[bool] = []

    async def run_web(
        *, settings: Settings, store: SettingsStore, project: ProjectSettings, resume: str | None, port: int
    ) -> None:
        assert settings.model == 'test'
        assert resume == 'saved'
        assert port in (0, 8765)
        called.append(True)

    monkeypatch.setattr(_cli, 'run_web', run_web)
    _cli.run()
    assert called == [True]
