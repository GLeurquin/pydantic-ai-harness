"""The built-in `diff` plugin: what the agent changed this conversation, shown on `/diff`."""

import difflib
import stat
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from pydantic_ai import RunContext
from pydantic_ai_harness.filesystem import MAX_DIFF_SOURCE_CHARS, FileChangeRequestEvent, FileWrittenEvent
from rich.console import Console
from rich.text import Text

from . import theme
from .commands import Command
from .plugins import DepsT, HistoryClear, PluginHost, TurnEnd
from .tool_output import print_diff, terminal_text

_USAGE = 'Usage: /diff [--stat] [PATH]'
_ABSENT = '/dev/null'
_NO_NEWLINE = '\\ No newline at end of file'


@dataclass(kw_only=True)
class _Snapshot:
    """What was at a path: its text, nothing (`text=None`), or the reason it cannot be diffed."""

    text: str | None = None
    problem: str | None = None


def _snapshot(path: Path) -> _Snapshot:
    """Read `path` with bytes and line endings intact, under the harness's own diff source cap.

    Undecodable bytes survive as surrogates so they never collide with a real
    replacement character. A path that exists but cannot be read is a
    `problem`, not a missing file, so it is never shown as a deletion. Only a
    regular file is opened: a FIFO or device in its place would block.
    """
    try:
        status = path.stat()
        if not stat.S_ISREG(status.st_mode):
            return _Snapshot(problem='not a regular file')
        if status.st_size > MAX_DIFF_SOURCE_CHARS:
            return _Snapshot(problem=f'too large to diff (over {MAX_DIFF_SOURCE_CHARS} bytes)')
        with path.open(encoding='utf-8', errors='surrogateescape', newline='') as file:
            return _Snapshot(text=file.read())
    except (FileNotFoundError, NotADirectoryError):
        return _Snapshot()
    except OSError as exc:
        return _Snapshot(problem=f'cannot read ({exc.strerror or exc})')


def _label(path: Path) -> str:
    """The path as the user would type it, relative to the working directory when inside it, made inert."""
    try:
        return terminal_text(path.relative_to(Path.cwd()).as_posix())
    except ValueError:
        return terminal_text(path.as_posix())


@dataclass(kw_only=True)
class FileDiff:
    """One changed file: the diff from its first-seen content to what is on disk now, or why it has none."""

    label: str
    diff: str = ''
    added: int = 0
    removed: int = 0
    error: str | None = None


def _lines(text: str) -> list[str]:
    """Split on LF only, keeping it, so a CR or a missing final newline stays visible to the diff."""
    lines = text.split('\n')
    last = lines.pop()
    return [f'{line}\n' for line in lines] + ([last] if last else [])


def unified_diff(before: str | None, after: str | None, *, label: str) -> str:
    """Unified diff between two texts; `None` on either side is a missing file, as `git diff` shows it.

    Mirrors the harness filesystem's private diff helper, which is not importable
    from here: a final line without a newline gets git's marker, and an empty
    file appearing or disappearing is the two headers alone.
    """
    if before == after:
        return ''
    prefixed = not Path(label).is_absolute()
    old = _ABSENT if before is None else f'a/{label}' if prefixed else label
    new = _ABSENT if after is None else f'b/{label}' if prefixed else label
    out: list[str] = []
    for index, line in enumerate(
        difflib.unified_diff(_lines(before or ''), _lines(after or ''), old, new, lineterm='')
    ):
        if line.endswith('\n'):
            out.append(line[:-1])
        else:
            out.append(line)
            if index >= 2 and not line.startswith('@@'):
                out.append(_NO_NEWLINE)
    return '\n'.join(out) if out else f'--- {old}\n+++ {new}'


class SessionDiff:
    """An in-memory ledger of the files the agent has changed since the last `/new`.

    The content before the first change is captured when the change is
    announced, before it is applied; the current content is read from disk
    when asked, so a file that has since been put back shows no diff.
    """

    def __init__(self) -> None:
        """Start empty."""
        self._before: dict[Path, _Snapshot] = {}
        self._pending: dict[Path, _Snapshot] = {}

    @property
    def paths(self) -> list[Path]:
        """Every path the agent has written, in first-change order."""
        return list(self._before)

    def announce(self, path: Path) -> None:
        """A change is about to be applied; remember the content it starts from."""
        path = path.resolve()
        if path not in self._before and path not in self._pending:
            self._pending[path] = _snapshot(path)

    def commit(self, path: Path) -> None:
        """A change was applied; the announced content becomes the file's baseline."""
        path = path.resolve()
        if path not in self._before:
            self._before[path] = self._pending.pop(path) if path in self._pending else _snapshot(path)

    def discard_pending(self) -> None:
        """Forget announced changes that were never applied."""
        self._pending.clear()

    def clear(self) -> None:
        """Start over, as `/new` does."""
        self._before.clear()
        self._pending.clear()

    def changes(self, only: Path | None = None) -> Iterator[FileDiff]:
        """Files whose current content differs from their baseline, optionally just `only`."""
        wanted = [only.resolve()] if only is not None else self.paths
        for path in wanted:
            if path not in self._before:
                continue
            label = _label(path)
            before, now = self._before[path], _snapshot(path)
            problem = before.problem or now.problem
            if problem is not None:
                yield FileDiff(label=label, error=problem)
                continue
            diff = unified_diff(before.text, now.text, label=label)
            if not diff:
                continue
            body = diff.splitlines()[2:]
            added = sum(line.startswith('+') for line in body)
            removed = sum(line.startswith('-') for line in body)
            yield FileDiff(label=label, diff=diff, added=added, removed=removed)


def _parse(args: list[str]) -> tuple[bool, Path | None]:
    stat = '--stat' in args
    paths = [arg for arg in args if arg != '--stat']
    if len(paths) > 1 or any(arg.startswith('-') for arg in paths):
        raise ValueError(_USAGE)
    return stat, Path(paths[0]) if paths else None


def _print_stat(console: Console, changes: list[FileDiff]) -> None:
    width = max(len(change.label) for change in changes)
    for change in changes:
        line = Text(f'{change.label.ljust(width)}  ', style=theme.ACCENT)
        line.append(f'+{change.added}', style=theme.DIFF_ADDED)
        line.append(' ')
        line.append(f'-{change.removed}', style=theme.DIFF_REMOVED)
        console.print(line)
    added = sum(change.added for change in changes)
    removed = sum(change.removed for change in changes)
    console.print(f'{len(changes)} files changed, {added} insertions(+), {removed} deletions(-)', style=theme.MUTED)


def print_changes(console: Console, *, ledger: SessionDiff, args: list[str]) -> None:
    """Back `/diff`: every changed file, one file, or the `--stat` summary."""
    stat, only = _parse(args)
    found = list(ledger.changes(only))
    changes = [change for change in found if change.error is None]
    for change in found:
        if change.error is not None:
            console.print(f'{change.label}: {change.error}', style=theme.MUTED, markup=False)
    if not found:
        what = f'No changes to {_label(only)} this conversation.' if only else 'No files changed this conversation.'
        console.print(what, style=theme.MUTED, markup=False)
    elif changes and stat:
        _print_stat(console, changes)
    else:
        for change in changes:
            print_diff(console, change.diff)


def activate(host: PluginHost[DepsT]) -> None:
    """Keep the ledger on this host, so unloading the plugin drops it."""
    ledger = SessionDiff()

    @host.on(FileChangeRequestEvent)
    async def announce(ctx: RunContext[DepsT], event: FileChangeRequestEvent) -> None:
        if event.operation != 'create_directory':
            ledger.announce(Path(event.root_dir) / event.path)

    @host.on(FileWrittenEvent)
    async def commit(ctx: RunContext[DepsT], event: FileWrittenEvent) -> None:
        ledger.commit(Path(event.root_dir) / event.path)

    @host.on('turn_end')
    async def settle(event: TurnEnd) -> None:
        ledger.discard_pending()

    @host.on('history_clear')
    async def reset(event: HistoryClear) -> None:
        ledger.clear()

    def show(args: list[str]) -> str:
        print_changes(host.console, ledger=ledger, args=args)
        return ''

    host.commands.register(
        Command(
            name='diff',
            description='Show what the agent changed this conversation; --stat for a summary',
            handler=show,
            complete=lambda _: ('--stat', *(_label(path) for path in ledger.paths)),
        )
    )
