"""Render typed capability events without parsing model-facing tool results."""

from pydantic_ai import AgentStreamEvent
from pydantic_ai_harness.coder import ShellFinishedEvent, ShellOutputEvent, ShellStartedEvent
from pydantic_ai_harness.filesystem import FileEditedEvent, FileWrittenEvent
from rich.console import Console
from termflow.diff import DiffRenderer  # pyright: ignore[reportMissingTypeStubs]


def terminal_text(text: str) -> str:
    """Make untrusted control characters inert before terminal rendering."""
    return ''.join(char if char.isprintable() or char in '\n\t' else f'\\x{ord(char):02x}' for char in text)


class ToolOutput:
    """Present bounded shell chunks and Termflow-highlighted file diffs."""

    def __init__(self, console: Console) -> None:
        """Use the conversation's output stream, not global stdout."""
        self.console = console

    def render(self, event: AgentStreamEvent) -> bool:
        """Return whether this event belongs to the specialized tool display."""
        if isinstance(event, ShellStartedEvent):
            self.console.print(f'$ {terminal_text(event.command)}', style='cyan', markup=False, highlight=False)
        elif isinstance(event, ShellOutputEvent):
            self.console.print(terminal_text(event.text), end='', markup=False, highlight=False)
        elif isinstance(event, ShellFinishedEvent):
            self.console.print()
            state = f'exit {event.exit_code}' if event.exit_code is not None else 'running in background'
            self.console.print(f'{state} | PID {event.pid}', style='dim', markup=False)
            self.console.print(f'Output: {terminal_text(event.output_path)}', style='dim', markup=False)
            self.console.print(f'Status: {terminal_text(event.status_path)}', style='dim', markup=False)
            if event.truncated:
                self.console.print('Output preview truncated; full output is in the command log.', style='dim')
            self.console.print()
        elif isinstance(event, FileEditedEvent):
            self.console.print(f'Edited {terminal_text(event.path)}', style='cyan', markup=False)
            diff = terminal_text(event.diff)
            if self.console.is_terminal:
                self.console.file.write(DiffRenderer().render(diff))
                self.console.file.flush()
            else:
                self.console.print(diff, markup=False, highlight=False)
            if event.truncated:
                self.console.print('Diff truncated.', style='dim')
            self.console.print()
        elif isinstance(event, FileWrittenEvent):
            self.console.print(f'Wrote {terminal_text(event.path)}\n', style='cyan', markup=False)
        else:
            return False
        return True
