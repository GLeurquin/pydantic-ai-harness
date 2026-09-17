"""Who has to step aside when a plugin takes the whole terminal mid-run."""

from collections.abc import AsyncGenerator, Generator
from contextlib import asynccontextmanager, contextmanager

from .plugins import FullScreen, bare_screen


class Screen:
    """The shell's `FullScreen`: bound to the live renderer and status row for the length of one prompt.

    Plugin hosts are created once at load time, but what has to stop before a widget can draw
    changes every prompt. Hosts hold `screen.full`; the prompt loop binds what it means.
    """

    def __init__(self) -> None:
        """Start unbound: between prompts nothing is streaming, so taking the screen is free."""
        self._take: FullScreen = bare_screen

    @contextmanager
    def bound(self, take: FullScreen) -> Generator[None]:
        """While active, `full()` defers to `take`; afterwards it is a no-op again."""
        self._take = take
        try:
            yield
        finally:
            self._take = bare_screen

    @asynccontextmanager
    async def full(self) -> AsyncGenerator[None]:
        """Own the terminal until the block exits. Give this to `PluginHost` as its `full_screen`."""
        async with self._take():
            yield
