"""The `/set` full-screen menu: pick a setting, edit it, come back to the list."""

import asyncio
import json
from collections.abc import Callable
from dataclasses import dataclass

from pydantic import JsonValue, ValidationError
from pydantic_ai.models import known_model_names
from termflow.tui import MenuBuilder, MenuItem, TextInputBuilder  # pyright: ignore[reportMissingTypeStubs]
from termflow.tui.menu import Menu, MenuResult  # pyright: ignore[reportMissingTypeStubs]
from termflow.tui.textinput import TextInput, TextInputResult  # pyright: ignore[reportMissingTypeStubs]

from ._rendering import markdown_style
from .command_context import CommandContext
from .config import SETTING_FIELDS, Settings

_CUSTOM = 'Type a value...'
_CANCEL = 'Keep current'
_LIST_HINT = 'type to filter - Enter edit - R reset - Esc close'


@dataclass(frozen=True)
class _Reset:
    """What the `r` key hands back to the loop instead of a row."""

    key: str


@dataclass(frozen=True, kw_only=True)
class SettingRow:
    """One setting as the menu sees it."""

    key: str
    field: str
    description: str
    default: JsonValue
    choices: tuple[str, ...]


def setting_rows() -> list[SettingRow]:
    """Every `/set` key with its description, default, and fixed choices if it has any."""
    rows: list[SettingRow] = []
    for key, field in SETTING_FIELDS.items():
        info = Settings.model_fields[field]
        if info.annotation is bool:
            choices: tuple[str, ...] = ('true', 'false')
        elif key == 'model':
            choices = tuple(known_model_names())
        else:
            choices = ()
        rows.append(
            SettingRow(key=key, field=field, description=info.description or '', default=info.default, choices=choices)
        )
    return rows


def _shown(value: JsonValue) -> str:
    if value is None:
        return '(not set)'
    return value if isinstance(value, str) else json.dumps(value)


class SettingsMenu:
    """Rows, details, editors, and the saves behind them."""

    def __init__(self, context: CommandContext) -> None:
        """Edits go through `context`, the same path as `/set KEY VALUE`."""
        self._context = context
        self.rows = setting_rows()

    def current(self, row: SettingRow) -> str:
        """The active value as the user would type it."""
        return _shown(self._context.settings.model_dump()[row.field])

    def items(self) -> list[MenuItem]:
        """One row per setting with its current value."""
        return [MenuItem(f'{row.key:<24} {self.current(row)}', value=row.key) for row in self.rows]

    def details(self, item: MenuItem) -> str:
        """The right-hand panel: current value, default, choices, description."""
        row = self._row(item)
        if row is None:
            return ''
        current = self.current(row)
        default = _shown(row.default)
        lines = [
            row.key,
            '',
            f'current  {current}' + (' (default)' if current == default else ''),
            f'default  {default}',
        ]
        if row.choices and len(row.choices) <= 4:
            lines.append(f'choices  {", ".join(row.choices)}')
        elif row.choices:
            lines.append(f'choices  {len(row.choices)} known models; Enter opens a searchable list')
        lines += ['', row.description]
        return '\n'.join(lines)

    def build(self, initial: int = 0) -> Menu:
        """The settings list. `r` returns a reset marker instead of a row."""
        return (
            MenuBuilder('Settings')
            .style(markdown_style())
            .items(self.items())
            .searchable()
            .initial_index(min(initial, len(self.rows) - 1))
            .preview(self.details)
            .on_key('r', self.reset_marker)
            .footer_hint(_LIST_HINT)
            .build()
        )

    def reset_marker(self, menu: object, item: MenuItem) -> MenuResult:
        """R: hand the row back to the loop tagged for reset."""
        return MenuResult(item=MenuItem(item.label, value=_Reset(str(item.value))))

    def build_choices(self, row: SettingRow) -> Menu:
        """A picker for settings with a fixed set of values, plus typing your own."""
        current = self.current(row)
        items = [
            MenuItem(f'{choice}{" (current)" if choice == current else ""}', value=choice) for choice in row.choices
        ]
        items += [MenuItem(_CUSTOM, value=_CUSTOM), MenuItem(_CANCEL, value=_CANCEL)]
        initial = row.choices.index(current) if current in row.choices else 0
        return (
            MenuBuilder(f'Choose {row.key}')
            .style(markdown_style())
            .items(items)
            .searchable(len(row.choices) > 4)
            .initial_index(initial)
            .footer_hint('Enter select - Esc keep current')
            .build()
        )

    def build_editor(self, row: SettingRow) -> TextInput:
        """A typed input that validates as you go; empty resets."""
        return (
            TextInputBuilder(f'New value for {row.key}')
            .style(markdown_style())
            .prompt('Value: ')
            .placeholder(f'current: {self.current(row)} (empty resets)')
            .validator(lambda text: self.problem(row, text))
            .footer_hint('Enter save - Esc cancel')
            .build()
        )

    def problem(self, row: SettingRow, text: str) -> str | None:
        """Why `text` is not a valid value for the row, or `None` if it is."""
        if not text.strip():
            return None
        try:
            self._context.validate(row.key, text.strip())
        except ValidationError as exc:
            return exc.errors()[0]['msg']
        return None

    def apply(self, row: SettingRow, raw: str) -> str:
        """Save and apply, or reset on empty input. Returns the message to show."""
        raw = raw.strip()
        if not raw:
            return self._context.reset_setting(row.key)
        try:
            return self._context.set_setting([row.key, raw])
        except ValidationError as exc:
            return f'{row.key}: {exc.errors()[0]["msg"]}'

    def reset(self, row: SettingRow) -> str:
        """Forget the override and apply the default."""
        return self._context.reset_setting(row.key)

    def row_for(self, key: object) -> SettingRow | None:
        """Look a row up by its `/set` key."""
        return next((row for row in self.rows if row.key == key), None)

    def _row(self, item: MenuItem) -> SettingRow | None:
        return self.row_for(item.value)


ListRunner = Callable[[Menu], MenuResult]
TextRunner = Callable[[TextInput], TextInputResult]


def _run_menu(menu: Menu) -> MenuResult:  # pragma: no cover -- needs a real terminal.
    return menu.run()


def _run_text(widget: TextInput) -> TextInputResult:  # pragma: no cover -- needs a real terminal.
    return widget.run()


def run_flow(
    menu: SettingsMenu,
    *,
    run_list: ListRunner = _run_menu,
    run_choice: ListRunner = _run_menu,
    run_text: TextRunner = _run_text,
) -> list[str]:
    """List, edit, back to the list, until Esc. Runners are injectable for tests."""
    messages: list[str] = []
    cursor = 0
    while True:
        result = run_list(menu.build(cursor))
        if result.cancelled or result.item is None:
            return messages
        value = result.item.value
        if isinstance(value, _Reset):
            row = menu.row_for(value.key)
            if row is not None:
                messages.append(menu.reset(row))
            continue
        row = menu.row_for(value)
        if row is None:
            return messages
        cursor = menu.rows.index(row)
        message = _edit(menu, row, run_choice=run_choice, run_text=run_text)
        if message is not None:
            messages.append(message)


def _edit(menu: SettingsMenu, row: SettingRow, *, run_choice: ListRunner, run_text: TextRunner) -> str | None:
    if row.choices:
        pick = run_choice(menu.build_choices(row))
        if pick.cancelled or pick.item is None or pick.item.value == _CANCEL:
            return None
        if isinstance(pick.item.value, str) and pick.item.value != _CUSTOM:
            return menu.apply(row, pick.item.value)
    typed = run_text(menu.build_editor(row))
    if typed.cancelled or not isinstance(typed.value, str):
        return None
    return menu.apply(row, typed.value)


async def open_settings_menu(context: CommandContext, *, run: Callable[[SettingsMenu], list[str]] | None = None) -> str:
    """Show the menu in a thread; edits save and apply as they happen."""
    messages = await asyncio.to_thread(run or run_flow, SettingsMenu(context))
    return '\n'.join(messages) or 'No changes.'
