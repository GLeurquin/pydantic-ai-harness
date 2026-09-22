"""Noninteractive execution shared by the one-shot CLI and browser client."""

import os
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager

from anyio import CancelScope
from pydantic_ai.usage import UsageLimits
from rich.console import Console

from ._app import DEFAULT_PLUGINS, create_agent, create_shell
from .config import Settings
from .plugins import SessionEndReason, TurnEnd, TurnStart
from .project_settings import ProjectSettings
from .settings_store import SettingsStore


@asynccontextmanager
async def no_screen() -> AsyncGenerator[None]:
    """Fail before a cooperating plugin can open a terminal widget."""
    raise RuntimeError('User interaction is unavailable in headless mode')
    yield  # pragma: no cover -- async context manager protocol.


@asynccontextmanager
async def headless_session(
    *, settings: Settings, store: SettingsStore, project: ProjectSettings, resume: str | None = None
) -> AsyncGenerator[Callable[[str], Awaitable[str]]]:
    """Own one noninteractive conversation; callers must serialize turns."""
    agent = create_agent()
    if settings.model is None:
        raise ValueError('Choose a model with -m PROVIDER:NAME')
    reason: SessionEndReason = 'error'
    with open(os.devnull, 'w') as sink:
        shell = create_shell(
            agent,
            deps=None,
            plugins=(),
            usage_limits=UsageLimits(request_limit=settings.request_limit),
            console=Console(file=sink, force_terminal=False),
            settings=settings,
            store=store,
            builtin_plugins=DEFAULT_PLUGINS,
            project=project,
            headless=True,
        )

        async def turn(text: str) -> str:
            start = TurnStart(text=text)
            ended = TurnEnd(text=text, outcome='cancelled')
            try:
                ended = await shell.run_turn(start, headless=True)
            finally:
                with CancelScope(shield=True):
                    await shell.loader.fire(ended)
            if ended.outcome != 'completed':
                raise RuntimeError(str(ended.error or start.cancel_reason or 'Turn cancelled by a plugin'))
            assert ended.result is not None
            return str(ended.result.output)

        async with agent:
            with shell.screen.bound(no_screen):  # pragma: no branch -- bound never suppresses exceptions.
                try:
                    # Skip before activation, even when a saved declaration overrides the built-in.
                    for entry in shell.loader.entries():
                        if entry.declaration.enabled and entry.name != 'ask_user':
                            await shell.loader.load(entry.name)
                    if resume is not None:
                        await shell.session.resume(resume)
                    yield turn
                    reason = 'exit'
                finally:
                    with CancelScope(shield=True):  # pragma: no branch -- this scope is never cancelled.
                        await shell.loader.close(reason)


async def run_headless(
    *, text: str, settings: Settings, store: SettingsStore, project: ProjectSettings, resume: str | None = None
) -> int:
    """Print only the final answer; preserve sessions and report failures on stderr."""
    if settings.model is None:
        raise ValueError('Choose a model with -m PROVIDER:NAME')
    try:
        async with headless_session(settings=settings, store=store, project=project, resume=resume) as turn:
            answer = await turn(text)
    except Exception as exc:  # noqa: BLE001 -- CLI boundary, stdout must remain answer-only.
        Console(stderr=True).print(str(exc), markup=False, highlight=False)
        return 1
    print(answer)
    return 0
