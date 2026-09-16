"""Interactive terminal shell around a capability-independent session."""

import asyncio
from collections.abc import Sequence
from typing import TypeVar

from prompt_toolkit import PromptSession
from prompt_toolkit.history import InMemoryHistory
from pydantic_ai import Agent
from pydantic_ai.agent import AbstractAgent
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.usage import UsageLimits
from pydantic_ai_harness.coder import Coder
from rich.console import Console

from ._branding import print_banner
from ._rendering import StreamRenderer
from ._session import Session
from .commands import Command, Commands, config_command, config_completions, plugins_command
from .config import Settings
from .settings_store import SettingsStore

DepsT = TypeVar('DepsT')
OutputT = TypeVar('OutputT')


def create_agent(model: str) -> Agent[None, str]:
    """Build the default coding agent; custom agents need not use `Coder`."""
    return Agent(model, capabilities=[Coder()])


async def chat(
    agent: AbstractAgent[DepsT, OutputT],
    *,
    deps: DepsT,
    plugins: Sequence[AbstractCapability[DepsT]] = (),
    usage_limits: UsageLimits | None = None,
    console: Console | None = None,
    settings: Settings | None = None,
    store: SettingsStore | None = None,
) -> None:
    """Start an asyncio terminal conversation with a caller-supplied agent.

    Ctrl-C cancels the current turn or clears input; Ctrl-D and `/exit` quit.
    Failed and cancelled turns are not added to the retained history.
    """
    console = console or Console()
    print_banner(console)
    console.print('/new clears history; /exit quits. Ctrl-C interrupts a turn.', style='dim')
    settings = settings or Settings()
    store = store or SettingsStore()
    session = Session(agent, deps=deps, plugins=plugins, usage_limits=usage_limits)
    commands = Commands()
    commands.register(Command(name='help', description='Show commands', handler=commands.help))
    commands.register(
        Command(
            name='new',
            description='Clear conversation history',
            handler=lambda _: session.clear() or 'Conversation cleared.',
        )
    )
    commands.register(Command(name='exit', description='Quit CLAI', handler=lambda _: 'Goodbye.'))
    commands.register(
        Command(
            name='config',
            description='show|get|set|reset settings',
            handler=lambda args: config_command(store, args),
            complete=config_completions,
        )
    )
    commands.register(
        Command(
            name='plugins',
            description='list|add|enable|disable plugins',
            handler=lambda args: plugins_command(store, args),
            complete=lambda args: (
                ('list', 'add', 'enable', 'disable') if len(args) <= 1 else (p.id for p in store.plugins())
            ),
        )
    )
    prompt = PromptSession[str](history=InMemoryHistory(), completer=commands, complete_while_typing=True)
    async with agent:
        while True:
            try:
                text = (await prompt.prompt_async('You > ')).strip()
            except KeyboardInterrupt:
                continue
            except EOFError:
                return
            if text.startswith('/'):
                try:
                    console.print(commands.execute(text), markup=False)
                except ValueError as exc:
                    console.print(str(exc), style='red', markup=False)
                if text == '/exit':
                    return
                continue
            if not text:
                continue
            renderer = StreamRenderer(console, stop_loading=lambda: None, show_thinking=settings.thinking)
            session.on_stream_event = renderer.on_stream_event
            try:
                result = await session.prompt(text)
                if not renderer.rendered_text or not isinstance(result.output, str):
                    console.print(str(result.output), markup=False)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 -- interactive boundary reports plugin/provider failures.
                console.print(f'{type(exc).__name__}: {exc}', style='red', markup=False)
                console.print('Turn not saved. External tool side effects may already have occurred.', style='dim')
            finally:
                renderer.finish()
