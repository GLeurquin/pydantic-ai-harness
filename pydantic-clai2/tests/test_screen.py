"""`/clear` wipes pixels, `/new` wipes memory, and Ctrl-R digs through input history."""

import io
from pathlib import Path

import pytest
from prompt_toolkit.application import create_app_session
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.output import DummyOutput
from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel
from rich.console import Console

from pydantic_clai2 import chat
from pydantic_clai2._completion_adapter import COMPLETION_STYLE
from pydantic_clai2.commands import set_completions
from pydantic_clai2.input_history import input_history
from pydantic_clai2.screen import clear_screen
from pydantic_clai2.settings_store import SettingsStore


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


def test_clear_screen_on_a_terminal_also_drops_scrollback() -> None:
    output = io.StringIO()
    console = Console(file=output, force_terminal=True)
    assert clear_screen(console).startswith('Screen cleared.')
    assert output.getvalue() == '\x1b[2J\x1b[H\x1b[3J'


def test_clear_screen_writes_nothing_when_redirected() -> None:
    output = io.StringIO()
    clear_screen(Console(file=output))
    assert output.getvalue() == ''


async def test_clear_keeps_the_conversation(tmp_path: Path) -> None:
    output = io.StringIO()
    agent = Agent(TestModel(custom_output_text='Noted.'))
    with create_pipe_input() as pipe, create_app_session(input=pipe, output=DummyOutput()):
        pipe.send_text('remember this\n/clear\n/help\n/exit\n')
        await chat(agent, deps=None, console=Console(file=output), store=SettingsStore(tmp_path / 'config.db'))
    text = output.getvalue()
    assert 'Screen cleared. The conversation is still here' in text
    assert '/new: Start a new conversation; the model forgets everything so far' in text
    assert '/clear: Clear the screen; the conversation is kept' in text


async def test_ctrl_r_recalls_an_earlier_prompt(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / 'config.db')
    history = input_history(store.path.with_name('input-history'))
    history.append_string('/help')
    history.append_string('/config show')
    output = io.StringIO()
    with create_pipe_input() as pipe, create_app_session(input=pipe, output=DummyOutput()):
        pipe.send_text('\x12hel\n\n/exit\n')
        await chat(Agent(TestModel()), deps=None, console=Console(file=output), store=store)
    assert '/help: Show commands' in output.getvalue()


def test_search_prompt_uses_theme_colours() -> None:
    for selector in ('class:prompt.search', 'class:prompt.search.text', 'class:search', 'class:search.current'):
        assert COMPLETION_STYLE.get_attrs_for_style_str(selector).color in ('9B77FF', 'E520E9', '00FFEB')


def test_boolean_settings_complete_true_false() -> None:
    assert list(set_completions(['check_updates', ''])) == ['true', 'false']
    assert list(set_completions(['display.splash', ''])) == ['true', 'false']
    assert list(set_completions(['display.shell_lines', ''])) == []
