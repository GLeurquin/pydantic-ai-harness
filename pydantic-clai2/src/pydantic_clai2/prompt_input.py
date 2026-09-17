"""Key bindings and completion for the prompt editor.

Enter submits. Alt-Enter and Ctrl-J insert a newline. A bracketed paste is
inserted as one block by prompt-toolkit's default binding, so a multi-line
paste is edited before it is submitted.
"""

import re
from collections.abc import Iterable
from pathlib import Path

from prompt_toolkit.completion import CompleteEvent, Completer, Completion, merge_completers
from prompt_toolkit.document import Document
from prompt_toolkit.key_binding import KeyBindings, KeyPressEvent

from ._completion_adapter import PromptCompleter
from .commands import Commands

_TOKEN = re.compile(r'(?<![\w@])@(?:"([^"]*)|(\S*))$')
"""The `@path` or `@"path` token being typed at the cursor."""


def prompt_key_bindings() -> KeyBindings:
    """Bindings layered over the prompt defaults: Enter submits, Alt-Enter and Ctrl-J break the line."""
    bindings = KeyBindings()

    @bindings.add('escape', 'enter')
    @bindings.add('c-j')
    def _newline(event: KeyPressEvent) -> None:
        event.current_buffer.insert_text('\n')

    return bindings


class PathReferenceCompleter(Completer):
    """Complete `@path` tokens against the workspace, for files and directories alike."""

    def __init__(self, *, root: Path) -> None:
        """Relative references resolve against `root`, the launch workspace."""
        self.root = root

    def get_completions(self, document: Document, complete_event: CompleteEvent) -> Iterable[Completion]:
        """Offer the children of the directory the token points into; slash commands are not paths.

        Names with spaces are completed in the `@"..."` form; the closing quote is
        added for files and left open for directories so completion can continue.
        """
        text = document.text_before_cursor
        token = None if text.startswith('/') else _TOKEN.search(text)
        if token is None:
            return
        quoted = token.group(1) is not None
        reference = token.group(1) if quoted else token.group(2)
        path = self.root / Path(reference).expanduser()
        at_directory = reference.endswith('/') or not reference
        directory = path if at_directory else path.parent
        prefix = '' if at_directory else path.name
        try:
            children = sorted(directory.iterdir())
        except OSError:
            return
        for child in children:
            if not child.name.startswith(prefix):
                continue
            suffix = '/' if child.is_dir() else ''
            if quoted or ' ' in child.name:
                head = reference[: len(reference) - len(prefix)]
                closing = '' if suffix else '"'
                yield Completion(
                    f'@"{head}{child.name}{suffix}{closing}',
                    start_position=-len(token.group(0)),
                    display=child.name + suffix,
                )
            else:
                yield Completion(child.name[len(prefix) :] + suffix, display=child.name + suffix)


def prompt_completer(commands: Commands, *, root: Path) -> Completer:
    """One completer for `/commands` and `@path` references."""
    return merge_completers([PromptCompleter(commands), PathReferenceCompleter(root=root)])
