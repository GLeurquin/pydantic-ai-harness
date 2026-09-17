"""Route console output above a live prompt, one complete line at a time."""

import asyncio
import sys
import threading
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from prompt_toolkit.application import in_terminal
from prompt_toolkit.output import Output


class PromptOutput:
    """A `sys.stdout` stand-in that writes above the running prompt.

    Rich and Termflow flush after every chunk. Honouring that would erase and redraw the
    prompt beside every partial line of streamed Markdown, so partial lines wait for their
    newline. Lines that arrive while a write is in progress share its redraw, and every
    write happens on the prompt's event loop in order, so output cannot overtake the prompt
    exit. Tools and plugins running in worker threads can print too; their lines hop to
    the loop.
    """

    def __init__(self, output: Output, *, loop: asyncio.AbstractEventLoop) -> None:
        """Write through the same prompt-toolkit output as the prompt so buffering stays consistent."""
        self._output = output
        self._loop = loop
        self._thread = threading.current_thread()
        self._lock = threading.Lock()
        self._partial = ''
        self._ready = ''
        self._writer: asyncio.Task[None] | None = None

    def write(self, text: str) -> int:
        """Buffer until a newline, then schedule the completed lines."""
        with self._lock:
            self._partial += text
            if '\n' not in self._partial:
                return len(text)
            lines, self._partial = self._partial.rsplit('\n', 1)
            self._ready += lines + '\n'
        self._wake()
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
        with self._lock:
            self._ready += self._partial
            self._partial = ''
        self._start_writer()
        if self._writer is not None:
            await self._writer

    def _wake(self) -> None:
        if threading.current_thread() is self._thread:
            self._start_writer()
        else:
            self._loop.call_soon_threadsafe(self._start_writer)

    def _start_writer(self) -> None:
        if self._writer is None and self._ready:
            self._writer = asyncio.ensure_future(self._drain())

    async def _drain(self) -> None:
        try:
            while self._ready:
                async with in_terminal():
                    with self._lock:
                        text, self._ready = self._ready, ''
                    self._output.write_raw(text)
                    self._output.flush()
        finally:
            self._writer = None


@asynccontextmanager
async def output_above_prompt(output: Output) -> AsyncGenerator[None]:
    """Send `sys.stdout` and `sys.stderr` above the prompt while it is on screen."""
    proxy = PromptOutput(output, loop=asyncio.get_running_loop())
    original = sys.stdout, sys.stderr
    sys.stdout = sys.stderr = proxy
    try:
        yield
    finally:
        sys.stdout, sys.stderr = original
        await proxy.aclose()
