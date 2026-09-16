"""Render typed capability events without parsing model-facing tool results."""

from dataclasses import dataclass

from pydantic_ai import AgentStreamEvent
from pydantic_ai_harness.coder import ShellFinishedEvent, ShellOutputEvent, ShellStartedEvent
from pydantic_ai_harness.filesystem import FileChangeRequestEvent, FileEditedEvent, FileWrittenEvent
from rich.console import Console
from termflow.diff import DiffRenderer  # pyright: ignore[reportMissingTypeStubs]


def terminal_text(text: str) -> str:
    """Make untrusted control characters inert before terminal rendering."""
    return ''.join(char if char.isprintable() or char in '\n\t' else f'\\x{ord(char):02x}' for char in text)


@dataclass
class ShellPreview:
    """Count displayed logical lines across output chunks."""

    completed_lines: int = 0
    pending: str = ''
    carriage_return: bool = False

    @property
    def shown(self) -> int:
        """Include a displayed unterminated line."""
        return self.completed_lines


class ToolOutput:
    """Present bounded shell chunks and Termflow-highlighted file diffs."""

    def __init__(self, console: Console, *, shell_lines: int = 20) -> None:
        """Use the conversation's output stream, not global stdout."""
        self.console = console
        self.shell_lines = shell_lines
        self._shells: dict[str | None, ShellPreview] = {}
        self._writes: dict[tuple[str | None, str, str], FileChangeRequestEvent] = {}

    def _shell_chunk(self, event: ShellOutputEvent) -> None:
        preview = self._shells.setdefault(event.tool_call_id, ShellPreview())
        for char in event.text:
            if preview.completed_lines >= self.shell_lines:
                break
            if char == '\n':
                self._shell_line(preview)
                preview.carriage_return = False
            elif char == '\r':
                preview.carriage_return = True
            else:
                if preview.carriage_return:
                    preview.pending = ''
                    preview.carriage_return = False
                preview.pending += char

    def _shell_line(self, preview: ShellPreview) -> None:
        self.console.print(
            terminal_text(preview.pending),
            style='dim',
            markup=False,
            highlight=False,
            overflow='ellipsis',
            no_wrap=True,
        )
        preview.pending = ''
        preview.completed_lines += 1

    def _diff(self, diff: str, *, truncated: bool) -> None:
        safe_diff = terminal_text(diff)
        if safe_diff:
            if self.console.is_terminal:
                self.console.file.write(DiffRenderer().render(safe_diff))
                self.console.file.flush()
            else:
                self.console.print(safe_diff, markup=False, highlight=False)
        if truncated:
            self.console.print('Diff truncated.', style='dim')
        self.console.print()

    def render(self, event: AgentStreamEvent) -> bool:
        """Return whether this event belongs to the specialized tool display."""
        if isinstance(event, ShellStartedEvent):
            self._shells[event.tool_call_id] = ShellPreview()
            command_lines = event.command.splitlines()
            command = command_lines[0] if command_lines else ''
            extra = f' (+{len(command_lines) - 1} command lines)' if len(command_lines) > 1 else ''
            self.console.print(
                f'$ {terminal_text(command)}{extra}',
                style='dim cyan',
                markup=False,
                highlight=False,
                overflow='ellipsis',
                no_wrap=True,
            )
        elif isinstance(event, ShellOutputEvent):
            self._shell_chunk(event)
        elif isinstance(event, ShellFinishedEvent):
            preview = self._shells.pop(event.tool_call_id, ShellPreview())
            if preview.pending and preview.completed_lines < self.shell_lines:
                self._shell_line(preview)
            omitted = max(0, event.total_lines - preview.shown)
            if omitted:
                self.console.print(f'Truncated {omitted} lines', style='dim')
            state = f'exit {event.exit_code}' if event.exit_code is not None else 'running in background'
            self.console.print(f'{state} | PID {event.pid}', style='dim', markup=False, highlight=False)
            self.console.print(
                f'Output: {terminal_text(event.output_path)}', style='dim', markup=False, highlight=False
            )
            self.console.print(
                f'Status: {terminal_text(event.status_path)}', style='dim', markup=False, highlight=False
            )
            if event.truncated and not omitted:
                self.console.print('Output preview truncated; full output is in the command log.', style='dim')
            self.console.print()
        elif isinstance(event, FileChangeRequestEvent):
            if event.operation == 'write':
                self._writes[event.tool_call_id, event.root_dir, event.path] = event
        elif isinstance(event, FileEditedEvent):
            self.console.print(f'Edited {terminal_text(event.path)}', style='cyan', markup=False)
            self._diff(event.diff, truncated=event.truncated)
        elif isinstance(event, FileWrittenEvent):
            self.console.print(f'Wrote {terminal_text(event.path)}', style='cyan', markup=False, highlight=False)
            request = self._writes.pop((event.tool_call_id, event.root_dir, event.path), None)
            if request is not None and not request.cancelled:
                self._diff(request.diff, truncated=request.truncated)
            else:
                self.console.print()
        else:
            return False
        return True
