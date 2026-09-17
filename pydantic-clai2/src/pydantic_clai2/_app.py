"""Interactive terminal shell around a capability-independent session."""

from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Generic, TypeVar

from prompt_toolkit import PromptSession
from pydantic_ai import Agent
from pydantic_ai.agent import AbstractAgent
from pydantic_ai.capabilities import AgentCapability
from pydantic_ai.usage import UsageLimits
from rich.console import Console

from . import theme
from ._branding import print_banner
from ._completion_adapter import COMPLETION_STYLE, PromptCompleter
from ._rendering import StreamRenderer
from ._session import Session
from ._turn import create_session, model_label, run_prompt, run_turn
from .auth import CodexAuth
from .command_context import CommandContext, CommandProvider
from .commands import Command, Commands, config_command, config_completions, set_completions
from .config import PluginSettings, Settings
from .customization import customization_guide
from .input_history import input_history
from .interrupts import Interrupts
from .model_menu import open_model_menu
from .plugin_loader import PluginLoader
from .plugin_menu import open_plugins_menu
from .plugins import SessionEndReason, SessionStart, TurnEnd
from .set_menu import open_settings_menu
from .settings_store import SettingsStore
from .status import Status

DepsT = TypeVar('DepsT')
OutputT = TypeVar('OutputT')
_PLUGIN_ACTIONS = ('list', 'add', 'enable', 'disable', 'remove', 'reload')


DEFAULT_PLUGINS: tuple[PluginSettings, ...] = (
    PluginSettings(id='coder', factory='pydantic_ai_harness.coder:Coder', settings={'unrestricted_filesystem': True}),
)
"""Plugins CLAI ships enabled. `/plugins disable coder` turns the coding tools off; `remove` restores this."""


def create_agent(model: str | None = None) -> Agent[None, str]:
    """Build the base CLAI agent. The coding tools come from the built-in `coder` plugin, not from here."""
    return Agent(model, deps_type=type(None), capabilities=[customization_guide()])


async def chat(
    agent: AbstractAgent[DepsT, OutputT],
    *,
    deps: DepsT,
    plugins: Sequence[AgentCapability[DepsT]] = (),
    usage_limits: UsageLimits | None = None,
    console: Console | None = None,
    settings: Settings | None = None,
    store: SettingsStore | None = None,
    builtin_plugins: Sequence[PluginSettings] = (),
) -> None:
    """Start an asyncio terminal conversation with a caller-supplied agent.

    Ctrl-C cancels the current turn or clears input; Ctrl-D and `/exit` quit.
    Failed and cancelled turns are not added to the retained history.
    """
    console = console or Console()
    console.print()
    print_banner(console)
    console.print('/new clears history; /exit quits. Ctrl-C interrupts a turn.', style=theme.MUTED)
    settings = settings or Settings(model=None)
    store = store or SettingsStore()
    auth = CodexAuth(console)
    session = create_session(agent, deps=deps, plugins=plugins, usage_limits=usage_limits, settings=settings, auth=auth)
    if session.model is None and agent.model is None:
        console.print('Choose a model with /set model <Tab>.', style=theme.INFO)

    def apply_setting(key: str, updated: Settings) -> None:
        if key == 'model':
            session.model = updated.model
        elif key == 'run.request_limit':
            session.usage_limits = replace(session.usage_limits or UsageLimits(), request_limit=updated.request_limit)

    context = CommandContext(settings=settings, store=store, clear_history=session.clear, apply_setting=apply_setting)

    commands = Commands()
    commands.register(
        Command(
            name='login',
            description='Connect your ChatGPT/Codex subscription',
            handler=auth.login,
            complete=lambda _: ('openai-codex',),
        )
    )
    commands.register(
        Command(
            name='set',
            description='Change settings; no arguments opens the menu',
            handler=lambda args: context.set_setting(args) if args else open_settings_menu(context),
            complete=set_completions,
        )
    )
    commands.register(
        Command(
            name='model',
            description='Pick a model or edit its settings; no arguments opens the menu',
            handler=lambda args: context.set_setting(['model', *args]) if args else open_model_menu(context),
            complete=lambda args: set_completions(['model', *args]) if len(args) <= 1 else (),
        )
    )
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
    loader: PluginLoader[DepsT] = PluginLoader(
        store=store,
        console=console,
        commands=commands,
        session_start=lambda: SessionStart(agent=agent, settings=context.settings),
        builtin=builtin_plugins,
    )
    commands.register(
        Command(
            name='plugins',
            description='Manage plugins; no arguments opens the menu',
            handler=lambda args: loader.command(args) if args else open_plugins_menu(loader),
            complete=lambda args: _PLUGIN_ACTIONS if len(args) <= 1 else (entry.name for entry in loader.entries()),
        )
    )
    for plugin in plugins:
        if isinstance(plugin, CommandProvider):
            commands.register_many(plugin.get_commands(context))
    status = Status()
    prompt = PromptSession[str](
        history=input_history(store.path.with_name('input-history')),
        completer=PromptCompleter(commands),
        complete_while_typing=True,
        style=COMPLETION_STYLE,
        reserve_space_for_menu=6,
        bottom_toolbar=lambda: status.text(),
    )
    shell = _Shell(
        agent=agent,
        session=session,
        plugins=tuple(plugins),
        loader=loader,
        commands=commands,
        console=console,
        context=context,
        status=status,
        prompt=prompt,
        interrupts=Interrupts(),
    )
    reason: SessionEndReason = 'error'
    try:
        async with agent:
            await loader.load_all()
            reason = await shell.run()
    finally:
        await loader.close(reason)


@dataclass(kw_only=True)
class _Shell(Generic[DepsT, OutputT]):
    """The prompt loop; one turn is one `TurnStart`, one agent run, one `TurnEnd`."""

    agent: AbstractAgent[DepsT, OutputT]
    session: Session[DepsT, OutputT]
    plugins: tuple[AgentCapability[DepsT], ...]
    loader: PluginLoader[DepsT]
    commands: Commands
    console: Console
    context: CommandContext
    status: Status
    prompt: PromptSession[str]
    interrupts: Interrupts

    async def run(self) -> SessionEndReason:
        while True:
            try:
                self.status.model = self.session.model or model_label(self.agent)
                text = (await self.prompt.prompt_async('> ')).strip()
            except KeyboardInterrupt:
                if self.interrupts.press():
                    return 'exit'
                self.console.print('Input cleared. Press Ctrl-C again within 2 seconds to exit.', style=theme.MUTED)
                continue
            except EOFError:
                return 'eof'
            if not text:
                continue
            self.console.print()
            if text.startswith('/'):
                await self.interrupts.run(
                    _execute_command(self.commands, text, console=self.console, status=self.status)
                )
                if text == '/exit' or self.interrupts.exit_requested:
                    return 'exit'
                continue
            if self.session.model is None and self.agent.model is None:
                self.console.print('Choose a model first: /set model <Tab>', style=theme.WARNING)
                continue
            if await self._turn(text):
                return 'exit'

    async def _turn(self, text: str) -> bool:
        await run_turn(text, loader=self.loader, console=self.console, run=self._interruptible_prompt)
        return self.interrupts.exit_requested

    async def _interruptible_prompt(self, text: str) -> TurnEnd:
        """Ctrl-C cancels the run and reports it; the turn counts as cancelled rather than propagating."""
        self.session.plugins = (*self.plugins, *self.loader.capabilities())
        self.session.model_settings = self.context.model_settings(self.session.model or model_label(self.agent))
        settings = self.context.settings
        renderer = StreamRenderer(
            self.console,
            stop_loading=lambda: None,
            show_thinking=settings.thinking,
            smooth_seconds=settings.smooth_seconds,
            shell_lines=settings.shell_lines,
            grep_lines=settings.grep_lines,
            renderers=self.loader.renderers(),
        )
        ended: TurnEnd | None = None

        async def prompt() -> None:
            nonlocal ended
            ended = await run_prompt(self.session, text, renderer=renderer, console=self.console, status=self.status)

        if not await self.interrupts.run(prompt()):
            self.console.print('Turn cancelled. Press Ctrl-C again within 2 seconds to exit.', style=theme.MUTED)
            self.console.print()
        return ended or TurnEnd(text=text, outcome='cancelled')


async def _execute_command(commands: Commands, text: str, *, console: Console, status: Status) -> None:
    try:
        console.print(await commands.execute_async(text), markup=False)
    except Exception as exc:  # noqa: BLE001 -- command failures must not exit the interactive shell.
        console.print(str(exc), style=theme.ERROR, markup=False)
    console.print()
    _reset_status(text, status)


def _reset_status(command: str, status: Status) -> None:
    if command == '/new':
        status.context_tokens = None
        status.output_tokens = None
        status.streamed_chars = 0
