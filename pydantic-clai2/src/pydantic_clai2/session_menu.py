"""The `/resume` and `/sessions` menus, plus the session commands the shell registers."""

import asyncio
from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, TypeVar

from termflow.tui import MenuBuilder, MenuItem, TextInputBuilder  # pyright: ignore[reportMissingTypeStubs]
from termflow.tui.menu import Menu, MenuResult  # pyright: ignore[reportMissingTypeStubs]
from termflow.tui.textinput import TextInput  # pyright: ignore[reportMissingTypeStubs]

from ._rendering import markdown_style
from .commands import Command
from .field_menu import TERMINAL, Runners
from .menu_worker import menu_key, run_worker
from .plugin_menu import Redrawable
from .sessions import Sessions, SessionSummary, first_prompt, last_reply

_PICK_HINT = 'Up/Down move - Enter resume - Esc close'
_MANAGE_HINT = 'Up/Down move - Enter resume - R rename - D delete - Esc close'
_LABEL_WIDTH = 48
_PREVIEW_CHARS = 400
_SHORT_ID = 8

ResultT = TypeVar('ResultT')


class Apply(Protocol):
    """Run a `Sessions` coroutine to completion from the menu's thread."""

    def __call__(self, action: Coroutine[object, object, ResultT], /) -> ResultT:
        """Block until `action` has run on the event loop and hand back its result."""
        ...


@dataclass(frozen=True)
class _Rename:
    """What the `r` key hands back to the loop instead of a session id."""

    id: str


class SessionMenu:
    """Rows, details, and key actions over this workspace's saved sessions."""

    def __init__(self, sessions: Sessions, *, manage: bool, apply: Apply) -> None:
        """`manage` adds the rename and delete keys; the plain picker only resumes."""
        self.sessions = sessions
        self.manage = manage
        self.apply = apply
        self._entries: list[SessionSummary] = []

    def items(self) -> list[MenuItem]:
        """Re-read the store; one row per session, ones with nothing to resume shown but not selectable."""
        self._entries = self.apply(self.sessions.listing())
        if not self._entries:
            return [MenuItem('No saved sessions for this directory. Sessions are saved as they run.', disabled=True)]
        rows: list[MenuItem] = []
        for entry in self._entries:
            mark = '*' if entry.id == self.sessions.id else ' '
            label = _clip(entry.label, _LABEL_WIDTH)
            row = f'{mark} {entry.id[:_SHORT_ID]}  {_when(entry.updated_at)}  {label}'
            rows.append(MenuItem(row, value=entry.id, disabled=entry.snapshot is None and not self.manage))
        return rows

    def details(self, item: MenuItem) -> str:
        """The right-hand panel: when, how long, the first prompt, and the last reply."""
        summary = self.summary_for(item.value)
        if summary is None:
            return ''
        lines = [
            summary.label,
            '',
            f'id        {summary.id}' + ('  (active)' if summary.id == self.sessions.id else ''),
            f'started   {_when(summary.started_at)}',
            f'updated   {_when(summary.updated_at)}',
            f'messages  {len(summary.messages)}',
            '',
            'First prompt:',
            _clip(first_prompt(summary.messages) or '(none)', _PREVIEW_CHARS),
            '',
            'Last reply:',
            _clip(last_reply(summary.messages) or '(none)', _PREVIEW_CHARS),
        ]
        return '\n'.join(lines)

    def build(self, initial: int = 0) -> Menu:
        """The session list; `r` and `d` are only bound when managing."""
        builder = (
            MenuBuilder('Sessions')
            .style(markdown_style())
            .items(self.items())
            .initial_index(min(initial, max(len(self._entries) - 1, 0)))
            .preview(self.details)
            .footer_hint(_MANAGE_HINT if self.manage else _PICK_HINT)
            .key_source(menu_key)
        )
        if self.manage:
            builder = builder.on_key('r', self.rename_marker).on_key('d', self.delete)
        return builder.build()

    def rename_marker(self, menu: object, item: MenuItem) -> MenuResult | None:
        """R: hand the session back to the loop tagged for the title editor."""
        summary = self.summary_for(item.value)
        if summary is None:
            return None
        return MenuResult(item=MenuItem(item.label, value=_Rename(summary.id)))

    def delete(self, menu: Redrawable, item: MenuItem) -> None:
        """D: delete immediately and redraw."""
        summary = self.summary_for(item.value)
        if summary is not None:
            self.apply(self.sessions.delete(summary.id))
        menu.replace_items(self.items())

    def build_rename(self, session_id: str) -> TextInput:
        """A typed input for the title; empty clears it."""
        summary = self.summary_for(session_id)
        title = summary.title if summary is not None else None
        return (
            TextInputBuilder(f'Rename session {session_id[:_SHORT_ID]}')
            .style(markdown_style())
            .prompt('Title: ')
            .initial(title or '')
            .placeholder('empty clears the title')
            .footer_hint('Enter save - Esc cancel')
            .key_source(menu_key)
            .build()
        )

    def summary_for(self, session_id: object) -> SessionSummary | None:
        """Look a listed conversation up by id."""
        return next((entry for entry in self._entries if entry.id == session_id), None)

    def index_of(self, session_id: str) -> int:
        """Where a session sits in the list, or 0."""
        return next((index for index, entry in enumerate(self._entries) if entry.id == session_id), 0)


def run_sessions_flow(menu: SessionMenu, runners: Runners = TERMINAL) -> list[str]:
    """Show the list; Enter resumes and closes, `r` edits a title and returns to the list."""
    messages: list[str] = []
    cursor = 0
    while True:
        result = runners.run_list(menu.build(cursor))
        if result.cancelled or result.item is None:
            return messages
        value = result.item.value
        if isinstance(value, _Rename):
            cursor = menu.index_of(value.id)
            typed = runners.run_text(menu.build_rename(value.id))
            if not typed.cancelled and isinstance(typed.value, str):
                messages.append(menu.apply(menu.sessions.rename(value.id, typed.value.strip() or None)))
            continue
        if isinstance(value, str):
            messages.append(menu.apply(menu.sessions.resume(value)))
        return messages


async def open_sessions_menu(
    sessions: Sessions, *, manage: bool, run: Callable[[SessionMenu], list[str]] | None = None
) -> str:
    """Show the menu in a thread; store calls hop back to the event loop, like the plugins menu."""
    loop = asyncio.get_running_loop()

    def apply(action: Coroutine[object, object, ResultT]) -> ResultT:
        return asyncio.run_coroutine_threadsafe(action, loop).result()

    menu = SessionMenu(sessions, manage=manage, apply=apply)
    messages = await run_worker(lambda: (run or run_sessions_flow)(menu))
    return '\n'.join(messages) or 'No changes.'


def session_commands(sessions: Sessions) -> tuple[Command, ...]:
    """`/new`, `/resume`, and `/sessions`, all over one `Sessions`."""
    return (
        Command(name='new', description='Start a new session', handler=lambda _: sessions.new()),
        Command(
            name='resume',
            description='Continue a saved session by id; no arguments opens the picker',
            handler=lambda args: sessions.resume(args[0]) if args else open_sessions_menu(sessions, manage=False),
        ),
        Command(
            name='sessions',
            description='Browse, rename, and delete saved sessions',
            handler=lambda _: open_sessions_menu(sessions, manage=True),
        ),
    )


def _when(moment: datetime) -> str:
    return moment.astimezone().strftime('%Y-%m-%d %H:%M')


def _clip(text: str, width: int) -> str:
    text = ' '.join(text.split())
    return text if len(text) <= width else text[: width - 3] + '...'
