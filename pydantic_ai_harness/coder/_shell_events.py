"""Bounded incremental decoding of an attached command's output log."""

import codecs
from pathlib import Path
from typing import Generic

from pydantic import BaseModel
from pydantic_ai import RunContext
from pydantic_ai.tools import AgentDepsT

from ._events import ShellFinishedEvent, ShellOutputEvent


class CommandStatus(BaseModel):
    pid: int
    exit_code: int | None


class ShellOutput(Generic[AgentDepsT]):
    """Read at most 16 KB per tool call without affecting its returned output."""

    def __init__(self, path: Path, ctx: RunContext[AgentDepsT] | None) -> None:
        self.path = path
        self.ctx = ctx
        self.offset = 0
        self.decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')

    async def emit(self) -> bool:
        if self.ctx is None or self.offset >= 16000 or not self.path.exists():
            return False
        with self.path.open('rb') as source:
            source.seek(self.offset)
            chunk = source.read(min(4096, 16000 - self.offset))
        self.offset += len(chunk)
        if chunk:
            await self.ctx.emit(ShellOutputEvent(text=self.decoder.decode(chunk)))
        return bool(chunk)

    async def drain(self) -> None:
        while await self.emit():
            pass

    async def finish(self, *, pid: int, status_path: Path) -> None:
        if self.ctx is None:
            return
        tail = self.decoder.decode(b'', final=True)
        if tail:
            await self.ctx.emit(ShellOutputEvent(text=tail))
        status = CommandStatus.model_validate_json(status_path.read_text()) if status_path.exists() else None
        await self.ctx.emit(
            ShellFinishedEvent(
                pid=pid,
                output_path=str(self.path),
                status_path=str(status_path),
                exit_code=status.exit_code if status else None,
                truncated=self.path.exists() and self.path.stat().st_size > self.offset,
            )
        )
