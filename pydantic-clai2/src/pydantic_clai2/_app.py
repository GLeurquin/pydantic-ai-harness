"""Interactive terminal shell around a capability-independent session."""

import asyncio
import itertools
from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from typing import Generic, TypeVar

import anyio
from anyio.abc import TaskGroup
from prompt_toolkit import PromptSession
from prompt_toolkit.document import Document
from pydantic_ai import Agent, AgentStreamEvent
from pydantic_ai.agent import AbstractAgent
from pydantic_ai.capabilities import AgentCapability
from pydantic_ai.messages import ModelResponse
from pydantic_ai.models import Model
from pydantic_ai.usage import UsageLimits
from rich.console import Console

from . import openrouter, theme, vllm
from ._branding import print_banner
from ._completion_adapter import COMPLETION_STYLE, PromptCompleter
from ._rendering import StreamRenderer
from ._session import Session
from .auth import CodexAuth
from .command_context import CommandContext, CommandProvider
from .commands import Command, Commands, config_command, config_completions, set_completions
from .config import PluginSettings, Settings
from .customization import customization_guide
from .input_history import input_history
from .interrupts import Interrupts
from .model_menu import open_model_menu
from .plugin_loader import PluginError, PluginLoader
from .plugin_menu import open_plugins_menu
from .plugins import Renderer, SessionEndReason, SessionStart, TurnEnd, TurnStart
from .prompt_keys import bind_prompt_keys
from .prompt_output import output_above_prompt
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

    The prompt stays open while a turn streams: Esc cancels the turn, Enter queues the
    next prompt, Ctrl-C cancels or clears input, and Ctrl-D and `/exit` quit.
    Failed and cancelled turns are not added to the retained history.
    """
    console = console or Console()
    console.print()
    print_banner(console)
    console.print(
        '/new clears history; /exit quits. Esc cancels a turn; Enter during a turn queues the next prompt.',
        style=theme.MUTED,
    )
    settings = settings or Settings(model=None)
    store = store or SettingsStore()
    session = Session(agent, deps=deps, plugins=plugins, usage_limits=usage_limits)
    session.model = settings.model
    auth = CodexAuth(console)

    async def resolve_model(name: str) -> Model | str:
        if name.startswith('openrouter:'):
            return await asyncio.to_thread(openrouter.model, name)
        if name.startswith('vllm:'):
            return await asyncio.to_thread(vllm.model, name)
        return auth.model(name) if name.startswith('openai-codex:') else name

    session.resolve_model = resolve_model
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
    frames = itertools.count()
    prompt = PromptSession[str](
        history=input_history(store.path.with_name('input-history')),
        completer=PromptCompleter(commands),
        complete_while_typing=True,
        style=COMPLETION_STYLE,
        reserve_space_for_menu=6,
        bottom_toolbar=lambda: status.toolbar(frame=next(frames)),
        refresh_interval=0.1,
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
    bind_prompt_keys(prompt, cancel=shell.cancel_turn)
    reason: SessionEndReason = 'error'
    try:
        async with agent:
            await loader.load_all()
            reason = await shell.run()
    finally:
        await loader.close(reason)


class _TurnEnded(Exception):
    """Ends the prompt when a turn finishes with input waiting, so the loop can run it."""


@dataclass(kw_only=True)
class _Pending:
    """One submitted line waiting for its turn."""

    text: str
    deferred: bool
    """Submitted while a turn was running; echoed again when it finally starts."""


@dataclass(kw_only=True)
class _Turn:
    """The running agent turn: cancel its scope from a key, wait on `done` before quitting."""

    text: str
    scope: anyio.CancelScope = field(default_factory=anyio.CancelScope)
    done: anyio.Event = field(default_factory=anyio.Event)


@dataclass(kw_only=True)
class _Shell(Generic[DepsT, OutputT]):
    """The prompt loop; one turn is one `TurnStart`, one agent run, one `TurnEnd`.

    The prompt stays open while a turn runs as a sibling task. Input submitted meanwhile
    waits in `queue`; commands and turns only ever start from `_drain`, between turns.
    """

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
    queue: deque[_Pending] = field(default_factory=deque[_Pending])
    _active: _Turn | None = None
    _draft: Document = field(default_factory=Document)

    async def run(self) -> SessionEndReason:
        reason: SessionEndReason = 'error'
        async with anyio.create_task_group() as tasks:
            reason = await self._loop(tasks)
        return reason

    async def _loop(self, tasks: TaskGroup) -> SessionEndReason:
        while True:
            reason = await self._drain(tasks)
            if reason is not None:
                return reason
            self.status.model = self.session.model or _model_label(self.agent)
            self.prompt.app.erase_when_done = False
            try:
                async with output_above_prompt(self.prompt.output):
                    text = await self.prompt.prompt_async('> ', default=self._draft)
            except _TurnEnded:
                continue
            except KeyboardInterrupt:
                self._draft = Document()
                if self.interrupts.press():
                    await self._stop_turn()
                    return 'exit'
                if self._active is None:
                    self.console.print('Input cleared. Press Ctrl-C again within 2 seconds to exit.', style=theme.MUTED)
                self.cancel_turn()
                continue
            except EOFError:
                await self._stop_turn()
                return 'eof'
            self._draft = Document()
            self.submit(text)

    def submit(self, text: str) -> None:
        """The one place typed input enters. Steering would route it into the running turn from here."""
        text = text.strip()
        if not text:
            return
        running = self._active is not None
        self.queue.append(_Pending(text=text, deferred=running))
        if running:
            self.status.queued = len(self.queue)
            self.console.print(f'Queued until this turn ends ({len(self.queue)} waiting).', style=theme.MUTED)

    def cancel_turn(self) -> None:
        """Cancel the running turn, if any. Typed input is kept."""
        if self._active is not None:
            self._active.scope.cancel()

    async def _stop_turn(self) -> None:
        """Cancel the running turn and wait for its cleanup and `turn_end` before quitting."""
        turn = self._active
        if turn is not None:
            turn.scope.cancel()
            await turn.done.wait()

    async def _drain(self, tasks: TaskGroup) -> SessionEndReason | None:
        """Run queued commands and start the next turn. Only ever runs between turns."""
        while self._active is None and self.queue:
            pending = self.queue.popleft()
            self.status.queued = len(self.queue)
            if pending.deferred:
                self.console.print(f'> {pending.text}', style=theme.MUTED, markup=False, highlight=False)
            self.console.print()
            if pending.text.startswith('/'):
                await self.interrupts.run(
                    _execute_command(self.commands, pending.text, console=self.console, status=self.status)
                )
                if pending.text == '/exit' or self.interrupts.exit_requested:
                    return 'exit'
            elif self.session.model is None and self.agent.model is None:
                self.console.print('Choose a model first: /set model <Tab>', style=theme.WARNING)
            else:
                self._active = _Turn(text=pending.text)
                tasks.start_soon(self._run_turn, self._active)
        return None

    async def _run_turn(self, turn: _Turn) -> None:
        try:
            await self._turn(turn)
        finally:
            self._active = None
            turn.done.set()
            self._resume_loop()

    def _resume_loop(self) -> None:
        """End the prompt so the loop can run queued input; the draft comes back on the next prompt."""
        app = self.prompt.app
        if not self.queue or not app.is_running or app.is_done:
            return
        buffer = self.prompt.default_buffer
        self._draft = Document(buffer.text, buffer.cursor_position)
        app.erase_when_done = True
        app.exit(exception=_TurnEnded())

    async def _turn(self, turn: _Turn) -> None:
        start = TurnStart(text=turn.text)
        try:
            await self.loader.fire(start)
        except PluginError as exc:
            self.console.print(str(exc), style=theme.ERROR, markup=False)
            self.console.print()
            await self.loader.fire(TurnEnd(text=start.text, outcome='failed', error=exc))
            return
        if start.cancelled:
            self.console.print(
                f'Turn cancelled by a plugin: {start.cancel_reason or "no reason given"}', style=theme.WARNING
            )
            self.console.print()
            await self.loader.fire(TurnEnd(text=start.text, outcome='cancelled'))
            return
        self.session.plugins = (*self.plugins, *self.loader.capabilities())
        self.session.model_settings = self.context.model_settings(self.session.model or _model_label(self.agent))
        ended: TurnEnd | None = None
        with turn.scope:
            ended = await _run_prompt(
                self.session,
                start.text,
                console=self.console,
                settings=self.context.settings,
                status=self.status,
                renderers=self.loader.renderers(),
            )
        if ended is None:
            self.console.print('Turn cancelled.', style=theme.MUTED)
            self.console.print()
            ended = TurnEnd(text=start.text, outcome='cancelled')
        await self.loader.fire(ended)


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


def _model_label(agent: AbstractAgent[DepsT, OutputT]) -> str:
    model = agent.model
    if isinstance(model, str):  # pragma: no cover -- concrete Agent resolves string models before chat.
        return model
    return model.model_name if model else 'agent default'


async def _run_prompt(
    session: Session[DepsT, OutputT],
    text: str,
    *,
    console: Console,
    settings: Settings,
    status: Status,
    renderers: Sequence[Renderer[AgentStreamEvent]] = (),
) -> TurnEnd:
    renderer = StreamRenderer(
        console,
        stop_loading=lambda: None,
        show_thinking=settings.thinking,
        smooth_seconds=settings.smooth_seconds,
        shell_lines=settings.shell_lines,
        grep_lines=settings.grep_lines,
        renderers=renderers,
    )
    status.streamed_chars = 0
    status.output_tokens = None
    status.activity = 'waiting'

    async def observe(event: AgentStreamEvent) -> None:
        status.observe(event)
        await renderer.on_stream_event(event)

    def context_usage(tokens: int) -> None:
        status.context_tokens = tokens

    session.on_context_usage = context_usage
    session.on_stream_event = observe
    try:
        result = await session.prompt(text)
        await renderer.finish()
        status.output_tokens = result.usage.output_tokens
        for message in reversed(result.all_messages()):  # pragma: no branch -- successful runs contain a response.
            if isinstance(message, ModelResponse):
                status.context_tokens = message.usage.total_tokens or None
                break
        if not renderer.rendered_text or not isinstance(result.output, str):
            console.print(str(result.output), markup=False)
            console.print()
        return TurnEnd(text=text, outcome='completed', result=result)
    except asyncio.CancelledError:
        # The turn's scope is still cancelled here; shield the abort so its checkpoint completes.
        with anyio.CancelScope(shield=True):
            await renderer.abort()
        raise
    except Exception as exc:  # noqa: BLE001 -- interactive boundary reports plugin/provider failures.
        await renderer.finish()
        console.print(f'{type(exc).__name__}: {exc}', style=theme.ERROR, markup=False)
        console.print('Turn not saved. External tool side effects may already have occurred.', style=theme.MUTED)
        console.print()
        return TurnEnd(text=text, outcome='failed', error=exc)
    finally:
        status.activity = 'ready'
        session.on_context_usage = None
        await renderer.finish()
