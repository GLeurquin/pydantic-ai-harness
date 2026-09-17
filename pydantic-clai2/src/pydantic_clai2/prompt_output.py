"""Route console output above a live prompt, one complete line at a time."""

import asyncio
import sys
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from prompt_toolkit.application import in_terminal
from prompt_toolkit.output import Output


class PromptOutput:
    """A `sys.stdout` stand-in that writes above the running prompt.

    Rich and Termflow flush after every chunk. Honouring that would erase and redraw the
    prompt beside every partial line of streamed Markdown, so partial lines wait for their
    newline. Lines that arrive while a write is in progress share its redraw, and every
    write happens on the event loop in order, so output cannot overtake the prompt exit.
    """

    def __init__(self, output: Output) -> None:
        """Write through the same prompt-toolkit output as the prompt so buffering stays consistent."""
        self._output = output
        self._partial = ''
        self._ready = ''
        self._writer: asyncio.Task[None] | None = None

    def write(self, text: str) -> int:
        """Buffer until a newline, then schedule the completed lines."""
        self._partial += text
        if '\n' in self._partial:
            lines, self._partial = self._partial.rsplit('\n', 1)
            self._schedule(lines + '\n')
        return len(text)

    def flush(self) -> None:
        """Partial lines stay buffered; the prompt is only redrawn after complete lines."""

    def isatty(self) -> bool:
        """Let Rich keep terminal rendering while output is proxied."""
        stdout = self._output.stdout
        return stdout is not None and stdout.isatty()

    @property
    def encoding(self) -> str:
        """Report the terminal's encoding, as Rich asks the file for it."""
        return self._output.encoding()

    async def aclose(self) -> None:
        """Write whatever is still pending before the prompt reclaims the terminal."""
        if self._partial:
            self._schedule(self._partial)
            self._partial = ''
        if self._writer is not None:
            await self._writer

    def _schedule(self, text: str) -> None:
        self._ready += text
        if self._writer is None:
            self._writer = asyncio.ensure_future(self._drain())

    async def _drain(self) -> None:
        try:
            while self._ready:
                async with in_terminal():
                    text, self._ready = self._ready, ''
                    self._output.write_raw(text)
                    self._output.flush()
        finally:
            self._writer = None


@asynccontextmanager
async def output_above_prompt(output: Output) -> AsyncGenerator[None]:
    """Send `sys.stdout` and `sys.stderr` above the prompt while it is on screen."""
    proxy = PromptOutput(output)
    original = sys.stdout, sys.stderr
    sys.stdout = sys.stderr = proxy
    try:
        yield
    finally:
        sys.stdout, sys.stderr = original
        await proxy.aclose()
