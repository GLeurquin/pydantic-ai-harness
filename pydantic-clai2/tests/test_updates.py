"""The daily update check never blocks, never complains, and speaks once."""

import asyncio
import io
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from prompt_toolkit.application import create_app_session
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.output import DummyOutput
from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel
from rich.console import Console

from pydantic_clai2 import chat
from pydantic_clai2.config import Settings
from pydantic_clai2.settings_store import SettingsStore
from pydantic_clai2.updates import STATE_KEY, check_for_update, installed_version

NOW = datetime(2026, 9, 17, 12, 0, tzinfo=UTC)


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


class FakePyPI:
    def __init__(self, latest: str | Exception, *, delay: float = 0) -> None:
        self.latest_version = latest
        self.delay = delay
        self.calls = 0

    async def latest(self, package: str) -> str:
        assert package == 'pydantic-clai2'
        self.calls += 1
        await asyncio.sleep(self.delay)
        if isinstance(self.latest_version, Exception):
            raise self.latest_version
        return self.latest_version


async def run_check(
    store: SettingsStore, source: FakePyPI, *, current: str = '0.1.0', enabled: bool = True, now: datetime = NOW
) -> tuple[str | None, str]:
    output = io.StringIO()
    notice = await check_for_update(
        store=store,
        console=Console(file=output, width=200),
        source=source,
        current=current,
        enabled=enabled,
        now=lambda: now,
    )
    return notice, output.getvalue()


async def test_newer_release_prints_one_muted_line(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / 'config.db')
    source = FakePyPI('0.2.0')
    notice, printed = await run_check(store, source)
    assert notice == 'pydantic-clai2 0.2.0 is available (you have 0.1.0): pip install -U pydantic-clai2'
    assert printed == notice + '\n'
    assert store.state(STATE_KEY) == NOW.isoformat()


@pytest.mark.parametrize('latest', ['0.1.0', '0.1', '0.1.0.0', '0.0.9', '0.2.0rc1', ValueError('down')])
async def test_same_older_unparsable_or_failing_release_is_silent(tmp_path: Path, latest: str | Exception) -> None:
    store = SettingsStore(tmp_path / 'config.db')
    notice, printed = await run_check(store, FakePyPI(latest))
    assert notice is None and printed == ''
    assert store.state(STATE_KEY) == NOW.isoformat()


async def test_trailing_zeros_do_not_count(tmp_path: Path) -> None:
    notice, _ = await run_check(SettingsStore(tmp_path / 'config.db'), FakePyPI('1.0.0'), current='1.0')
    assert notice is None
    notice, _ = await run_check(SettingsStore(tmp_path / 'other.db'), FakePyPI('1.0.1'), current='1')
    assert notice is not None


async def test_dev_install_is_never_nagged(tmp_path: Path) -> None:
    notice, _ = await run_check(SettingsStore(tmp_path / 'config.db'), FakePyPI('9.9.9'), current='0.1.0.dev1')
    assert notice is None


async def test_slow_source_times_out_silently(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr('pydantic_clai2.updates.TIMEOUT_SECONDS', 0.01)
    notice, printed = await run_check(SettingsStore(tmp_path / 'config.db'), FakePyPI('0.2.0', delay=1))
    assert notice is None and printed == ''


async def test_checks_at_most_once_a_day(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / 'config.db')
    source = FakePyPI('0.2.0')
    await run_check(store, source)
    notice, _ = await run_check(store, source, now=NOW + timedelta(hours=23))
    assert notice is None and source.calls == 1
    notice, _ = await run_check(store, source, now=NOW + timedelta(hours=24))
    assert notice is not None and source.calls == 2
    store.save_state(STATE_KEY, 'not a timestamp')
    notice, _ = await run_check(store, source, now=NOW + timedelta(hours=25))
    assert notice is not None and source.calls == 3


async def test_broken_store_is_silent_too(tmp_path: Path) -> None:
    class BrokenStore(SettingsStore):
        def save_state(self, key: str, value: str) -> None:
            raise OSError('disk full')

    source = FakePyPI('0.2.0')
    notice, printed = await run_check(BrokenStore(tmp_path / 'config.db'), source)
    assert notice is None and printed == '' and source.calls == 0


async def test_disabled_setting_skips_everything(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / 'config.db')
    source = FakePyPI('0.2.0')
    notice, printed = await run_check(store, source, enabled=False)
    assert notice is None and printed == '' and source.calls == 0
    assert store.state(STATE_KEY) is None


def test_installed_version_is_the_package_metadata() -> None:
    assert installed_version() == '0.1.0'


class NoticeWatcher(io.StringIO):
    """Flag the moment the update line is written, so the test can quit without a sleep."""

    def __init__(self) -> None:
        super().__init__()
        self.seen = asyncio.Event()

    def write(self, s: str, /) -> int:
        if 'is available' in s:
            self.seen.set()
        return super().write(s)


async def test_chat_mentions_update_after_the_banner(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr('pydantic_clai2._app.PyPI', lambda: FakePyPI('0.2.0'))
    monkeypatch.setattr('pydantic_clai2._app.installed_version', lambda: '0.1.0')
    output = NoticeWatcher()
    with create_pipe_input() as pipe, create_app_session(input=pipe, output=DummyOutput()):
        running = asyncio.create_task(
            chat(
                Agent(TestModel()),
                deps=None,
                console=Console(file=output, width=200),
                store=SettingsStore(tmp_path / 'db'),
            )
        )
        await asyncio.wait_for(output.seen.wait(), 10)
        pipe.send_text('/exit\n')
        await running
    text = output.getvalue()
    assert 'pydantic-clai2 0.2.0 is available (you have 0.1.0): pip install -U pydantic-clai2' in text
    assert text.index('Ctrl-R searches input') < text.index('0.2.0 is available')


async def test_chat_honours_check_updates_setting(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = FakePyPI('0.2.0')
    monkeypatch.setattr('pydantic_clai2._app.PyPI', lambda: source)
    output = io.StringIO()
    store = SettingsStore(tmp_path / 'db')
    with create_pipe_input() as pipe, create_app_session(input=pipe, output=DummyOutput()):
        pipe.send_text('/set check_updates\n/exit\n')
        await chat(
            Agent(TestModel()),
            deps=None,
            console=Console(file=output),
            store=store,
            settings=Settings(model=None, check_updates=False),
        )
    assert source.calls == 0
    assert '\nFalse\n' in output.getvalue()
    assert store.state(STATE_KEY) is None
