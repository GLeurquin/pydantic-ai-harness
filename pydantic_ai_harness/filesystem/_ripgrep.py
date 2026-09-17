"""Run ripgrep and split its NUL-delimited output into records.

`rg` is invoked with `--null`, so every file path it prints ends in a NUL byte
and cannot be confused with the `:`/`-` separators of the match text that
follows it. Records are streamed and the process is stopped once the caller's
limit is reached, so a search over a large tree does not buffer everything
before the cap applies.
"""

from __future__ import annotations

import subprocess
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import anyio
import anyio.abc
from pydantic_ai.exceptions import ModelRetry

_SEPARATOR = b'--\n'
"""What `rg` prints between non-adjacent context groups; carries no path and is dropped."""


@dataclass(kw_only=True, frozen=True)
class Record:
    """One line of ripgrep output: the file it refers to, and the rest of the line."""

    path: str
    """The path as `rg` printed it, relative to the directory it was run in."""
    text: str
    """Empty for a file listing; otherwise `<line>:<text>` for a match or `<line>-<text>` for context."""


async def run_ripgrep(
    arguments: Sequence[str], *, cwd: Path, limit: int, listing: bool = False
) -> tuple[list[Record], bool]:
    """Run `rg --null` with `arguments` in `cwd`; return up to `limit` records and whether more were cut.

    `listing` reads `--files` output, where each record is a bare path. Raises
    `ModelRetry` when `rg` is not installed or reports an error (an invalid
    pattern, say), so the model can correct the call or use another tool.
    """
    records: list[Record] = []
    truncated = False
    stderr = bytearray()
    terminator = b'\0' if listing else b'\n'

    async def read_stderr(stream: anyio.abc.ByteReceiveStream) -> None:
        async for chunk in stream:
            stderr.extend(chunk)

    try:
        async with await anyio.open_process(
            ['rg', '--null', '--color=never', *arguments], cwd=cwd, stderr=subprocess.PIPE
        ) as process:
            assert process.stdout is not None
            assert process.stderr is not None
            async with anyio.create_task_group() as tasks:
                tasks.start_soon(read_stderr, process.stderr)
                pending = b''
                async for chunk in process.stdout:
                    pending += chunk
                    while not truncated and (end := pending.find(terminator)) >= 0:
                        line, pending = pending[: end + 1], pending[end + 1 :]
                        if line == _SEPARATOR:
                            continue
                        if len(records) >= limit:
                            truncated = True
                        else:
                            records.append(_record(line, listing=listing))
                    if truncated:
                        process.terminate()
                        break
            await process.wait()
    except FileNotFoundError as exc:
        raise ModelRetry('ripgrep (rg) is not installed. Install it, or use the pure-Python search tools.') from exc
    if not truncated and process.returncode not in (0, 1):
        detail = stderr.decode('utf-8', errors='replace').strip()
        raise ModelRetry(f'ripgrep failed: {detail or f"exit code {process.returncode}"}')
    return records, truncated


def _record(line: bytes, *, listing: bool) -> Record:
    if listing:
        return Record(path=line[:-1].decode('utf-8', errors='replace'), text='')
    path, _, text = line.rstrip(b'\n').partition(b'\0')
    return Record(path=path.decode('utf-8', errors='replace'), text=text.decode('utf-8', errors='replace'))
