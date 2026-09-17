"""The `/resume` and `/sessions` menus, driven headless over an in-memory store."""

import asyncio
from collections.abc import Sequence
from pathlib import Path

import pytest
from menu_script import Script, pick, typed
from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel
from pydantic_ai_harness.step_persistence import InMemoryStepStore, RunRecord
from session_script import apply, persisted, turns
from termflow.tui import MenuItem  # pyright: ignore[reportMissingTypeStubs]
from termflow.tui.menu import MenuResult  # pyright: ignore[reportMissingTypeStubs]
from termflow.tui.textinput import TextInputResult  # pyright: ignore[reportMissingTypeStubs]

from pydantic_clai2 import Session
from pydantic_clai2.commands import Commands
from pydantic_clai2.persistence import CWD_KEY
from pydantic_clai2.session_menu import SessionMenu, open_sessions_menu, run_sessions_flow, session_commands
from pydantic_clai2.sessions import Sessions


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


class FakeMenu:
    def __init__(self) -> None:
        self.redraws: list[Sequence[MenuItem]] = []

    def replace_items(self, items: Sequence[MenuItem]) -> None:
        self.redraws.append(items)


async def make_sessions(tmp_path: Path, count: int) -> tuple[Sessions, list[str], InMemoryStepStore]:
    """`count` saved conversations, oldest first, plus the shell's own (unsaved) session over the same store."""
    store = InMemoryStepStore()
    ids = [await turns(store, tmp_path, f'prompt {index}\nsecond line') for index in range(count)]
    session = Session(Agent(TestModel()), deps=None, plugins=[persisted(store, tmp_path)])
    return Sessions(session, store=lambda: store, workspace=tmp_path), ids, store


def test_rows_details_and_keys(tmp_path: Path) -> None:
    sessions, (older, newer), store = asyncio.run(make_sessions(tmp_path, 2))
    asyncio.run(
        store.register_run(RunRecord(run_id='r', conversation_id='empty', metadata={CWD_KEY: sessions.workspace}))
    )
    apply(sessions.resume(newer))
    menu = SessionMenu(sessions, manage=True, apply=apply)
    empty, active, other = menu.items()
    assert active.label.startswith(f'* {newer[:8]}') and active.label.endswith('prompt 1 second line')
    assert empty.label.endswith('(no saved turns)') and not empty.disabled, 'manageable, so it can be deleted'
    assert SessionMenu(sessions, manage=False, apply=apply).items()[0].disabled, 'but not resumable'
    details = menu.details(active)
    assert f'id        {newer}  (active)' in details
    assert 'messages  2' in details and 'First prompt:\nprompt 1 second line' in details and 'Last reply:' in details
    assert menu.details(MenuItem('stray', value=0)) == ''
    assert menu.index_of(other.value) == 2 and menu.index_of('zzz') == 0
    marker = menu.rename_marker(None, active)
    assert marker is not None and marker.item is not None and marker.item.label == active.label
    assert menu.rename_marker(None, MenuItem('stray', value='nope')) is None
    assert menu.build_rename(newer) is not None and menu.build_rename('nope') is not None
    fake = FakeMenu()
    menu.delete(fake, empty)
    assert len(fake.redraws[-1]) == 2
    menu.delete(fake, MenuItem('stray', value='nope'))
    assert len(fake.redraws[-1]) == 2
    menu.delete(fake, active)
    assert len(fake.redraws[-1]) == 1 and sessions.id != newer and fake.redraws[-1][0].value == older
    assert menu.build() is not None and SessionMenu(sessions, manage=False, apply=apply).build(5) is not None


def test_empty_state(tmp_path: Path) -> None:
    sessions, _, _ = asyncio.run(make_sessions(tmp_path, 0))
    menu = SessionMenu(sessions, manage=False, apply=apply)
    items = menu.items()
    assert len(items) == 1 and items[0].disabled and items[0].label.startswith('No saved sessions')
    assert menu.build() is not None


def test_flow_rename_then_resume(tmp_path: Path) -> None:
    sessions, (older, _), _ = asyncio.run(make_sessions(tmp_path, 2))
    menu = SessionMenu(sessions, manage=True, apply=apply)
    assert menu.rename_marker(None, MenuItem('row', value=older)) is None, 'nothing loaded yet'
    marker = menu.rename_marker(None, menu.items()[1])
    assert marker is not None
    script = Script(
        lists=[marker, marker, marker, pick(older)],
        choices=[],
        texts=[typed('  Greeting  '), TextInputResult(cancelled=True), typed('')],
    )
    messages = run_sessions_flow(menu, script.runners)
    assert messages == [
        f'Renamed session {older}.',
        f'Cleared the title of session {older}.',
        f'Resumed session {older} (2 messages): prompt 0 second line',
    ]
    assert script.opened == ['list', 'text', 'list', 'text', 'list', 'text', 'list']
    assert sessions.id == older
    assert run_sessions_flow(menu, Script([MenuResult(cancelled=True)], [], []).runners) == []
    assert run_sessions_flow(menu, Script([pick(0)], [], []).runners) == []


async def test_open_menu_and_commands(tmp_path: Path) -> None:
    sessions, (only,), _ = await make_sessions(tmp_path, 1)
    assert await open_sessions_menu(sessions, manage=False, run=lambda menu: []) == 'No changes.'
    assert await open_sessions_menu(sessions, manage=True, run=lambda menu: ['done']) == 'done'
    commands = Commands()
    commands.register_many(session_commands(sessions))
    new, resume, browse = session_commands(sessions)
    assert await commands.execute_async(f'/resume {only}') == (
        f'Resumed session {only} (2 messages): prompt 0 second line'
    )
    assert (await commands.execute_async('/new')).startswith('Started session ')
    assert new.name == 'new' and resume.name == 'resume' and browse.name == 'sessions'
    opened: list[tuple[bool, int]] = []

    def run(menu: SessionMenu) -> list[str]:
        opened.append((menu.manage, len(menu.items())))
        return [menu.apply(sessions.rename(only, 'From the thread'))]

    assert await open_sessions_menu(sessions, manage=False, run=run) == f'Renamed session {only}.'
    await open_sessions_menu(sessions, manage=True, run=run)
    assert opened == [(False, 1), (True, 1)]
    assert (await sessions.listing())[0].title == 'From the thread', 'the real bridge ran the coroutine on the loop'
