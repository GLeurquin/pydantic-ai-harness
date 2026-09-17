"""One turn, shared by the prompt loop and one-shot mode: session setup, host hooks, the streamed run."""

import asyncio
import contextlib
from collections.abc import Awaitable, Callable, Sequence
from typing import TypeVar

from pydantic_ai import AgentStreamEvent
from pydantic_ai.agent import AbstractAgent
from pydantic_ai.capabilities import AgentCapability
from pydantic_ai.messages import ModelMessage, ModelResponse
from pydantic_ai.models import Model
from pydantic_ai.usage import UsageLimits
from rich.console import Console

from . import openrouter, theme, vllm
from ._rendering import StreamRenderer
from ._session import Session
from .auth import CodexAuth
from .config import Settings
from .plugin_loader import PluginError, PluginLoader
from .plugins import TurnEnd, TurnStart
from .status import Status, StatusLine

DepsT = TypeVar('DepsT')
OutputT = TypeVar('OutputT')


def create_session(
    agent: AbstractAgent[DepsT, OutputT],
    *,
    deps: DepsT,
    plugins: Sequence[AgentCapability[DepsT]],
    usage_limits: UsageLimits | None,
    settings: Settings,
    auth: CodexAuth,
    message_history: Sequence[ModelMessage] = (),
) -> Session[DepsT, OutputT]:
    """A session whose model name resolves through the connected providers (Codex, OpenRouter, vLLM)."""
    session = Session(agent, deps=deps, plugins=plugins, usage_limits=usage_limits, message_history=message_history)
    session.model = settings.model

    async def resolve_model(name: str) -> Model | str:
        if name.startswith('openrouter:'):
            return await asyncio.to_thread(openrouter.model, name)
        if name.startswith('vllm:'):
            return await asyncio.to_thread(vllm.model, name)
        return auth.model(name) if name.startswith('openai-codex:') else name

    session.resolve_model = resolve_model
    return session


def model_label(agent: AbstractAgent[DepsT, OutputT]) -> str:
    """The agent's own model name, for settings lookup and the status row."""
    model = agent.model
    if isinstance(model, str):  # pragma: no cover -- concrete Agent resolves string models before chat.
        return model
    return model.model_name if model else 'agent default'


async def run_turn(
    text: str,
    *,
    loader: PluginLoader[DepsT],
    console: Console,
    run: Callable[[str], Awaitable[TurnEnd]],
) -> TurnEnd:
    """Bracket `run` with `turn_start` (fails closed) and `turn_end`, including on cancellation."""
    start = TurnStart(text=text)
    try:
        await loader.fire(start)
    except PluginError as exc:
        console.print(str(exc), style=theme.ERROR, markup=False)
        console.print()
        ended = TurnEnd(text=start.text, outcome='failed', error=exc)
    else:
        if start.cancelled:
            reason = start.cancel_reason or 'no reason given'
            console.print(f'Turn cancelled by a plugin: {reason}', style=theme.WARNING)
            console.print()
            ended = TurnEnd(text=start.text, outcome='cancelled')
        else:
            try:
                ended = await run(start.text)
            except asyncio.CancelledError:
                await loader.fire(TurnEnd(text=start.text, outcome='cancelled'))
                raise
    await loader.fire(ended)
    return ended


async def run_prompt(
    session: Session[DepsT, OutputT],
    text: str,
    *,
    renderer: StreamRenderer,
    console: Console,
    status: Status | None = None,
) -> TurnEnd:
    """Stream one prompt through `renderer`; errors go to `console`. `status` drives the footer, when there is one."""
    session.on_context_usage = None
    if status is not None:
        status.streamed_chars = 0
        status.output_tokens = None
        status.activity = 'waiting'

        def context_usage(tokens: int) -> None:
            status.context_tokens = tokens

        session.on_context_usage = context_usage

    async def observe(event: AgentStreamEvent) -> None:
        if status is not None:
            status.observe(event)
        await renderer.on_stream_event(event)

    session.on_stream_event = observe
    footer = StatusLine(console, status) if status is not None else contextlib.nullcontext()
    try:
        async with footer:
            result = await session.prompt(text)
            await renderer.finish()
        if status is not None:
            status.output_tokens = result.usage.output_tokens
            for message in reversed(result.all_messages()):  # pragma: no branch -- successful runs contain a response.
                if isinstance(message, ModelResponse):
                    status.context_tokens = message.usage.total_tokens or None
                    break
        if not renderer.rendered_text or not isinstance(result.output, str):
            renderer.console.print(str(result.output), markup=False)
            renderer.console.print()
        return TurnEnd(text=text, outcome='completed', result=result)
    except asyncio.CancelledError:
        await renderer.abort()
        raise
    except Exception as exc:  # noqa: BLE001 -- the shell reports plugin/provider failures instead of dying.
        await renderer.finish()
        console.print(f'{type(exc).__name__}: {exc}', style=theme.ERROR, markup=False)
        console.print('Turn not saved. External tool side effects may already have occurred.', style=theme.MUTED)
        console.print()
        return TurnEnd(text=text, outcome='failed', error=exc)
    finally:
        if status is not None:
            status.activity = 'ready'
        session.on_context_usage = None
        await renderer.finish()
