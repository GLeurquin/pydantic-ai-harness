"""Keys the prompt handles itself while a turn is running."""

from collections.abc import Callable

from prompt_toolkit import PromptSession
from prompt_toolkit.key_binding import KeyBindings, KeyPressEvent

ESCAPE_FLUSH_SECONDS = 0.1
"""How long a bare ESC byte waits for the rest of a terminal sequence (Vim's `ttimeoutlen`)."""
KEY_SEQUENCE_SECONDS = 0.2
"""How long a matched key waits for a longer binding such as Alt-b (Vim's `timeoutlen`)."""


def bind_prompt_keys(prompt: PromptSession[str], *, cancel: Callable[[], None]) -> None:
    """Make Esc cancel the running turn without breaking Alt-key bindings.

    A bare Esc is only recognised once prompt-toolkit is sure no escape sequence follows and
    no `escape <key>` binding will match. With the defaults that takes 1.5 seconds. Both waits
    are shortened rather than making the binding eager, which would fire on every Alt-key.
    """
    bindings = KeyBindings()

    @bindings.add('escape')
    def _(event: KeyPressEvent) -> None:
        cancel()

    prompt.key_bindings = bindings
    prompt.app.ttimeoutlen = ESCAPE_FLUSH_SECONDS
    prompt.app.timeoutlen = KEY_SEQUENCE_SECONDS
