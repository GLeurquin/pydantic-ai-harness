"""The `/set` menu, driven headless with scripted key presses."""

from collections.abc import Iterator
from pathlib import Path

import pytest
from termflow.tui import MenuItem  # pyright: ignore[reportMissingTypeStubs]
from termflow.tui.menu import Menu, MenuResult  # pyright: ignore[reportMissingTypeStubs]
from termflow.tui.textinput import TextInput, TextInputResult  # pyright: ignore[reportMissingTypeStubs]

from pydantic_clai2.command_context import CommandContext
from pydantic_clai2.set_menu import SettingsMenu, open_settings_menu, run_flow, setting_rows
from pydantic_clai2.settings_store import SettingsStore


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


def make_context(tmp_path: Path) -> tuple[CommandContext, list[str]]:
    applied: list[str] = []
    store = SettingsStore(tmp_path / 'config.db')
    context = CommandContext(
        settings=store.load(),
        store=store,
        clear_history=lambda: None,
        apply_setting=lambda key, settings: applied.append(key),
    )
    return context, applied


def pick(value: object) -> MenuResult:
    return MenuResult(item=MenuItem(str(value), value=value))


def typed(text: str) -> TextInputResult:
    return TextInputResult(value=text)


class Script:
    """Feed scripted results to the runners, in order, and remember what was shown."""

    def __init__(self, lists: list[MenuResult], choices: list[MenuResult], texts: list[TextInputResult]) -> None:
        self._lists: Iterator[MenuResult] = iter(lists)
        self._choices: Iterator[MenuResult] = iter(choices)
        self._texts: Iterator[TextInputResult] = iter(texts)
        self.opened: list[str] = []

    def run_list(self, menu: Menu) -> MenuResult:
        self.opened.append('list')
        return next(self._lists)

    def run_choice(self, menu: Menu) -> MenuResult:
        self.opened.append('choice')
        return next(self._choices)

    def run_text(self, widget: TextInput) -> TextInputResult:
        self.opened.append('text')
        return next(self._texts)


def test_rows_details_and_validation(tmp_path: Path) -> None:
    context, _ = make_context(tmp_path)
    menu = SettingsMenu(context)
    keys = [row.key for row in setting_rows()]
    assert keys[:3] == ['model', 'run.request_limit', 'display.thinking']
    items = menu.items()
    assert items[0].label.startswith('model') and 'openai-codex:gpt-6-astra' in items[0].label
    thinking = next(row for row in menu.rows if row.key == 'display.thinking')
    model = menu.rows[0]
    assert thinking.choices == ('true', 'false')
    assert len(model.choices) > 4
    assert 'choices  true, false' in menu.details(items[2])
    assert 'known models' in menu.details(items[0])
    assert 'current  true (default)' in menu.details(items[2])
    assert 'choices' not in menu.details(items[1])
    assert menu.details(MenuItem('stray', value='nope')) == ''
    context.settings = context.settings.model_copy(update={'model': None})
    assert menu.current(model) == '(not set)'
    assert 'current  (not set)' in menu.details(items[0])
    limit = menu.rows[1]
    assert menu.problem(limit, '') is None
    assert menu.problem(limit, '50') is None
    assert menu.problem(limit, '-1') is not None
    assert 'JSON' in (menu.problem(limit, 'not json') or '')
    assert menu.build(99) is not None
    assert menu.build_choices(thinking) is not None
    assert menu.build_choices(model) is not None
    assert menu.build_editor(limit) is not None
    assert menu.reset_marker(object(), items[1]).item is not None


def test_flow_edits_resets_and_reports(tmp_path: Path) -> None:
    context, applied = make_context(tmp_path)
    menu = SettingsMenu(context)
    script = Script(
        lists=[
            pick('display.thinking'),
            pick('run.request_limit'),
            pick('run.request_limit'),
            menu.reset_marker(object(), MenuItem('run.request_limit', value='run.request_limit')),
            menu.reset_marker(object(), MenuItem('ghost', value='ghost')),
            pick('model'),
            pick('model'),
            pick('display.splash'),
            pick('display.splash'),
            pick('unknown-key'),
        ],
        choices=[
            pick('false'),
            pick('Type a value...'),
            pick('Type a value...'),
            pick('Keep current'),
            MenuResult(cancelled=True),
        ],
        texts=[typed('50'), typed('bad'), typed('test'), typed('')],
    )
    messages = run_flow(menu, run_list=script.run_list, run_choice=script.run_choice, run_text=script.run_text)
    assert messages == [
        'Saved display.thinking. Applied.',
        'Saved run.request_limit. Applied.',
        'run.request_limit: Invalid JSON: expected value at line 1 column 1',
        'Reset run.request_limit. Applied.',
        'Saved model. Applied.',
        'Reset model. Applied.',
    ]
    assert not context.settings.thinking
    assert context.settings.request_limit == 10000
    assert context.settings.model == 'openai-codex:gpt-6-astra'
    assert context.store.overrides() == {'display.thinking': False}
    assert applied == ['display.thinking', 'run.request_limit', 'run.request_limit', 'model', 'model']
    assert script.opened.count('choice') == 5


def test_flow_stops_on_cancel(tmp_path: Path) -> None:
    context, _ = make_context(tmp_path)
    script = Script(lists=[MenuResult(cancelled=True)], choices=[], texts=[])
    assert run_flow(SettingsMenu(context), run_list=script.run_list) == []
    script = Script(
        lists=[pick('run.request_limit'), MenuResult(item=None)], choices=[], texts=[TextInputResult(cancelled=True)]
    )
    assert run_flow(SettingsMenu(context), run_list=script.run_list, run_text=script.run_text) == []


async def test_open_menu_runs_in_a_thread(tmp_path: Path) -> None:
    context, _ = make_context(tmp_path)
    assert await open_settings_menu(context, run=lambda menu: []) == 'No changes.'
    assert await open_settings_menu(context, run=lambda menu: [menu.apply(menu.rows[1], '7')]) == (
        'Saved run.request_limit. Applied.'
    )
    assert context.settings.request_limit == 7
