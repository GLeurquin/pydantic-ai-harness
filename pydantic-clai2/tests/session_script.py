"""Drive `StepPersistence` for real through a `Session` so session tests start from what the harness writes."""

import asyncio
from collections.abc import Coroutine, Sequence
from pathlib import Path
from typing import TypeVar

from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage, UserPromptPart
from pydantic_ai.models.test import TestModel
from pydantic_ai_harness.step_persistence import StepPersistence, StepStore

from pydantic_clai2 import Session
from pydantic_clai2.persistence import CWD_KEY

ResultT = TypeVar('ResultT')


def persisted(store: StepStore, workspace: Path) -> StepPersistence[None]:
    """The capability exactly as the `persistence` plugin registers it, over any store."""
    return StepPersistence[None](store=store, metadata={CWD_KEY: str(workspace.resolve())})


async def turns(store: StepStore, workspace: Path, *prompts: str, session: Session[None, str] | None = None) -> str:
    """Run `prompts` as one conversation (a fresh one unless `session` is given); returns its id."""
    session = session or Session(Agent(TestModel()), deps=None, plugins=[persisted(store, workspace)])
    for prompt in prompts:
        await session.prompt(prompt)
    return session.conversation_id


def prompts(messages: Sequence[ModelMessage]) -> list[str]:
    return [
        part.content
        for message in messages
        for part in message.parts
        if isinstance(part, UserPromptPart) and isinstance(part.content, str)
    ]


def apply(action: Coroutine[object, object, ResultT]) -> ResultT:
    """The menu's thread-to-loop bridge, for tests that run the menu without a loop."""
    return asyncio.run(action)
