"""Bridge Termflow completion declarations to the current prompt widget."""

from collections.abc import Iterable

from prompt_toolkit.completion import CompleteEvent, Completer, Completion
from prompt_toolkit.document import Document
from termflow.tui.completion import CompleteEvent as TermflowEvent  # pyright: ignore[reportMissingTypeStubs]
from termflow.tui.completion import Document as TermflowDocument  # pyright: ignore[reportMissingTypeStubs]

from .commands import Commands


class PromptCompleter(Completer):
    """Keep prompt-toolkit types out of the command and plugin interfaces."""

    def __init__(self, commands: Commands) -> None:
        """Adapt a conversation-local Termflow registry."""
        self.commands = commands

    def get_completions(self, document: Document, complete_event: CompleteEvent) -> Iterable[Completion]:
        """Translate only at the current line editor boundary."""
        for item in self.commands.get_completions(
            TermflowDocument(document.text, document.cursor_position),
            TermflowEvent(complete_event.text_inserted, complete_event.completion_requested),
        ):
            yield Completion(
                item.text, start_position=item.start_position, display=item.display, display_meta=item.display_meta
            )
