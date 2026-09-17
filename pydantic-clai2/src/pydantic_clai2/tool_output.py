"""Render typed capability events without parsing model-facing tool results."""

import re
from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass, field

from pydantic import BaseModel
from pydantic_ai import AgentStreamEvent, FunctionToolCallEvent
from pydantic_ai_harness.filesystem import FileChangeRequestEvent, FileEditedEvent, FileWrittenEvent
from pydantic_ai_harness.shell import CommandFinishedEvent, CommandOutputEvent, CommandStartedEvent
from rich.ansi import AnsiDecoder
from rich.console import Console
from rich.text import Text
from termflow.diff import DiffRenderer, DiffTheme  # pyright: ignore[reportMissingTypeStubs]

from . import theme


def terminal_text(text: str) -> str:
    """Make untrusted control characters inert before terminal rendering."""
    return ''.join(char if char.isprintable() or char in '\n\t' else f'\\x{ord(char):02x}' for char in text)


_SGR = re.compile(r'(\x1b\[[0-9;]*m)')


def shell_text(text: str, decoder: AnsiDecoder) -> Text:
    """Decode SGR styles only; keep other terminal controls inert."""
    parts = _SGR.split(text)
    safe = ''.join(part if index % 2 else terminal_text(part) for index, part in enumerate(parts))
    return decoder.decode_line(safe)


class DisplayArguments(BaseModel):
    """Optional display fields for file and shell tools."""

    path: str | None = None
    command: str | None = None
    offset: int = 0
    limit: int | None = None
    glob: str | None = None
    recursive: bool = True


@dataclass(kw_only=True, frozen=True)
class FoldedOutput:
    """A tool result the transcript showed only the head of."""

    label: str
    lines: tuple[Text, ...]


class FoldedOutputs:
    """The last few folded outputs, newest first, kept across turns for `/expand`."""

    def __init__(self, *, keep: int = 10) -> None:
        """Remember at most `keep` outputs; older ones are forgotten."""
        self._kept: deque[FoldedOutput] = deque(maxlen=keep)

    def __len__(self) -> int:
        """How many outputs `/expand` can show."""
        return len(self._kept)

    def keep(self, output: FoldedOutput) -> None:
        """Make `output` the one `/expand` shows next."""
        self._kept.appendleft(output)

    def expand(self, console: Console, args: list[str]) -> str:
        """The `/expand [N]` handler: reprint the N-th most recent folded output in full."""
        if len(args) > 1 or (args and not args[0].isdigit()):
            raise ValueError('Usage: /expand [N] shows the N-th most recent folded output (default 1).')
        if not self._kept:
            return 'Nothing to expand: no tool output has been folded yet.'
        position = int(args[0]) if args else 1
        if not 1 <= position <= len(self._kept):
            return f'Only {len(self._kept)} folded output(s) are kept; use /expand 1 to /expand {len(self._kept)}.'
        output = self._kept[position - 1]
        console.print(Text(f'● {output.label}', style=theme.MUTED), overflow='ellipsis', no_wrap=True)
        for line in output.lines:
            print_output_line(console, line)
        return f'{len(output.lines)} lines.'


def print_output_line(console: Console, line: Text) -> None:
    """One muted row of tool output, clipped to the terminal width."""
    console.print(line, style=theme.MUTED, markup=False, highlight=False, overflow='ellipsis', no_wrap=True)


def summary(argument: str) -> str:
    """The first line of a command or path, noting how many more lines it has."""
    lines = argument.splitlines()
    text = lines[0] if lines else ''
    if len(lines) > 1:
        text += f' (+{len(lines) - 1} command lines)'
    return terminal_text(text)


class Folder:
    """Show the first `lines` rows of a tool result and keep the rest for `/expand`."""

    def __init__(self, console: Console, *, lines: int = 20, folds: FoldedOutputs | None = None) -> None:
        """`lines` is the visible head; 0 shows everything."""
        self.console = console
        self.lines = lines
        self.folds = FoldedOutputs() if folds is None else folds

    def visible(self, index: int) -> bool:
        """Whether the zero-based row `index` belongs to the visible head."""
        return self.lines == 0 or index < self.lines

    def fold(self, *, label: str, lines: Sequence[Text]) -> None:
        """After the head was printed: add the trailer and keep the whole output if any row was hidden."""
        hidden = len(lines) - self.lines if self.lines else 0
        if hidden <= 0:
            return
        self.folds.keep(FoldedOutput(label=label, lines=tuple(lines)))
        self.console.print(f'... {hidden} more lines (/expand to show)', style=theme.MUTED)

    def show(self, *, label: str, lines: Sequence[Text]) -> None:
        """Print the visible head of a complete result, then fold the rest."""
        for index, line in enumerate(lines):
            if not self.visible(index):
                break
            print_output_line(self.console, line)
        self.fold(label=label, lines=lines)


@dataclass
class ShellPreview:
    """Collect logical lines across output chunks; the visible head is printed as it completes."""

    label: str = 'shell'
    lines: list[Text] = field(default_factory=list[Text])
    pending: str = ''
    carriage_return: bool = False
    decoder: AnsiDecoder = field(default_factory=AnsiDecoder)


class ToolOutput:
    """Present folded shell output and Termflow-highlighted file diffs."""

    def __init__(self, console: Console, *, lines: int = 20, folds: FoldedOutputs | None = None) -> None:
        """Use the conversation's output stream, not global stdout."""
        self.console = console
        self.folder = Folder(console, lines=lines, folds=folds)
        self._shells: dict[str | None, ShellPreview] = {}
        self._headers: set[tuple[str | None, str]] = set()
        self._writes: dict[tuple[str | None, str, str], FileChangeRequestEvent] = {}

    def _header(self, name: str, argument: str) -> None:
        text = Text(f'● {name} ', style=theme.MUTED)
        text.append(summary(argument), style=theme.ACCENT)
        self.console.print(text, overflow='ellipsis', no_wrap=True)
        self.console.print()

    def render_call(self, event: FunctionToolCallEvent) -> bool:
        """Show arguments once, before execution, including for failed calls."""
        name = event.part.tool_name
        if name not in ('shell', 'write_file', 'edit_file', 'read_file', 'list_files'):
            return False
        try:
            args = DisplayArguments.model_validate_json(event.part.args_as_json_str())
        except ValueError:
            return False
        if name in ('read_file', 'list_files'):
            return self._inspection_header(name, args)
        argument = args.command if name == 'shell' else args.path
        if argument is None:
            return False
        self._header(name, argument)
        self._headers.add((event.part.tool_call_id, name))
        return True

    def _inspection_header(self, name: str, args: DisplayArguments) -> bool:
        if name == 'read_file':
            if args.path is None:
                return False
            limit = min(args.limit, 2000) if args.limit is not None else 2000
            details = f'offset={args.offset} limit={limit} lines'
            if args.limit is not None and args.limit > 2000:
                details += f' (requested {args.limit})'
            path = args.path
        else:
            path = args.path or '.'
            limit = args.limit if args.limit is not None else 200
            details = f'recursive={str(args.recursive).lower()} limit={limit}'
            if args.glob is not None:
                details += f' glob={args.glob!r}'
        self._header(name, f'{path!r} {details}')
        return True

    def _shell_chunk(self, event: CommandOutputEvent) -> None:
        preview = self._shells.setdefault(event.tool_call_id, ShellPreview())
        for char in event.text:
            if char == '\n':
                self._shell_line(preview)
                preview.carriage_return = False
            elif char == '\r':
                preview.carriage_return = True
            else:
                if preview.carriage_return:
                    shell_text(preview.pending, preview.decoder)
                    preview.pending = ''
                    preview.carriage_return = False
                preview.pending += char

    def _shell_line(self, preview: ShellPreview) -> None:
        line = shell_text(preview.pending, preview.decoder)
        preview.pending = ''
        if self.folder.visible(len(preview.lines)):
            print_output_line(self.console, line)
        preview.lines.append(line)

    def _diff(self, diff: str, *, truncated: bool) -> None:
        safe_diff = terminal_text(diff)
        if safe_diff:
            if self.console.is_terminal:
                self.console.file.write(
                    DiffRenderer(
                        theme=DiffTheme(
                            addition=theme.DIFF_ADDITION,
                            deletion=theme.DIFF_DELETION,
                            marker_brighten=2.0,
                        )
                    ).render(safe_diff)
                )
                self.console.file.flush()
            else:
                self.console.print(safe_diff, markup=False, highlight=False)
        if truncated:
            self.console.print('Diff truncated.', style=theme.MUTED)
        self.console.print()

    def _shell_finished(self, event: CommandFinishedEvent) -> None:
        preview = self._shells.pop(event.tool_call_id, ShellPreview())
        if preview.pending:
            self._shell_line(preview)
        self.folder.fold(label=preview.label, lines=preview.lines)
        if event.truncated:
            beyond = event.total_lines - len(preview.lines) if event.total_lines is not None else 0
            rest = f'{beyond} more lines are' if beyond > 0 else 'the rest is'
            self.console.print(
                f'Output truncated by the event budget; {rest} only in the command log.', style=theme.MUTED
            )
        state = f'exit {event.exit_code}' if event.exit_code is not None else 'running in background'
        self.console.print(f'{state} | PID {event.pid}', style=theme.MUTED, markup=False, highlight=False)
        self.console.print(
            f'Output: {terminal_text(event.output_path)}', style=theme.MUTED, markup=False, highlight=False
        )
        self.console.print(
            f'Status: {terminal_text(event.status_path)}', style=theme.MUTED, markup=False, highlight=False
        )
        self.console.print()

    def abort(self) -> None:
        """Release pending events when a run ends without tool results."""
        self._writes.clear()
        self._headers.clear()
        self._shells.clear()

    def discard_call(self, tool_call_id: str) -> None:
        """Release proposed diffs after a tool result, including refusals and retries."""
        self._writes = {key: value for key, value in self._writes.items() if key[0] != tool_call_id}

    def render(self, event: AgentStreamEvent) -> bool:
        """Return whether this event belongs to the specialized tool display."""
        if isinstance(event, CommandStartedEvent):
            self._shells[event.tool_call_id] = ShellPreview(label=f'shell {summary(event.command)}')
            key = (event.tool_call_id, 'shell')
            if key not in self._headers:
                self._header('shell', event.command)
            self._headers.discard(key)
        elif isinstance(event, CommandOutputEvent):
            self._shell_chunk(event)
        elif isinstance(event, CommandFinishedEvent):
            self._shell_finished(event)
        elif isinstance(event, FileChangeRequestEvent):
            if event.operation == 'write':
                self._writes[event.tool_call_id, event.root_dir, event.path] = event
        elif isinstance(event, FileEditedEvent):
            key = (event.tool_call_id, 'edit_file')
            if key not in self._headers:
                self._header('edit_file', event.path)
            self._headers.discard(key)
            self._diff(event.diff, truncated=event.truncated)
        elif isinstance(event, FileWrittenEvent):
            key = (event.tool_call_id, 'write_file')
            if key not in self._headers:
                self._header('write_file', event.path)
            self._headers.discard(key)
            request = self._writes.pop((event.tool_call_id, event.root_dir, event.path), None)
            if request is not None and not request.cancelled:
                self._diff(request.diff, truncated=request.truncated)
            else:
                self.console.print()
        else:
            return False
        return True
