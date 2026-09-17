"""One turn without the prompt loop: `clai2 -p`, piped stdin, and `--output-format json`."""

import json
import re
import sys
from collections.abc import Sequence
from typing import Literal, TextIO, TypeVar

from pydantic import JsonValue, TypeAdapter
from pydantic_ai import AgentRunResult
from pydantic_ai.agent import AbstractAgent
from pydantic_ai.capabilities import AgentCapability
from pydantic_ai.messages import ModelMessage, ModelMessagesTypeAdapter
from pydantic_ai.usage import RunUsage, UsageLimits
from rich.console import Console

from . import theme
from ._rendering import StreamRenderer
from ._turn import create_session, model_label, run_prompt, run_turn
from .auth import CodexAuth
from .command_context import saved_model_settings
from .commands import Commands
from .config import PluginSettings, Settings
from .plugin_loader import PluginLoader
from .plugins import SessionEndReason, SessionStart, TurnEnd
from .settings_store import SettingsStore

DepsT = TypeVar('DepsT')
OutputT = TypeVar('OutputT')
OutputFormat = Literal['text', 'json']
_USAGE = TypeAdapter(RunUsage)


def read_prompt(argument: str | None, *, stdin: TextIO) -> str | None:
    """`-p` alone is the prompt; piped stdin alone is the prompt; both together fence stdin below `-p`."""
    piped = '' if stdin.isatty() else stdin.read().strip('\n')
    if not piped.strip():
        return argument
    if argument is None:
        return piped.strip()
    fence = '`' * max(3, max((len(run) for run in re.findall(r'`+', piped)), default=0) + 1)
    return f'{argument}\n\n{fence}\n{piped}\n{fence}'


async def one_shot(
    agent: AbstractAgent[DepsT, OutputT],
    prompt: str,
    *,
    deps: DepsT,
    plugins: Sequence[AgentCapability[DepsT]] = (),
    usage_limits: UsageLimits | None = None,
    settings: Settings | None = None,
    store: SettingsStore | None = None,
    builtin_plugins: Sequence[PluginSettings] = (),
    output_format: OutputFormat = 'text',
    message_history: Sequence[ModelMessage] = (),
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    """Run one turn with the same plugins and rendering as the shell, then return the exit code.

    Progress (thinking, tool output, errors) goes to stderr. Text mode streams the answer to
    stdout on a terminal, or writes the plain answer once when stdout is a pipe. JSON mode
    writes one object with `text`, `usage`, `cost`, and `messages`. Cancellation propagates.
    """
    out = stdout or sys.stdout
    aside = Console(file=stderr or sys.stderr)
    settings = settings or Settings(model=None)
    store = store or SettingsStore()
    session = create_session(
        agent,
        deps=deps,
        plugins=plugins,
        usage_limits=usage_limits,
        settings=settings,
        auth=CodexAuth(aside),
        message_history=message_history,
    )
    if session.model is None and agent.model is None:
        aside.print('No model configured. Pass --model NAME or run: clai2 config set model NAME', style=theme.ERROR)
        return 1
    loader: PluginLoader[DepsT] = PluginLoader(
        store=store,
        console=aside,
        commands=Commands(),
        session_start=lambda: SessionStart(agent=agent, settings=settings),
        builtin=builtin_plugins,
    )
    streamed = output_format == 'text' and out.isatty()

    async def run(text: str) -> TurnEnd:
        session.plugins = (*plugins, *loader.capabilities())
        session.model_settings = saved_model_settings(store, session.model or model_label(agent))
        renderer = StreamRenderer(
            Console(file=out) if streamed else aside,
            aside=aside,
            stop_loading=lambda: None,
            show_thinking=settings.thinking,
            smooth_seconds=settings.smooth_seconds,
            shell_lines=settings.shell_lines,
            grep_lines=settings.grep_lines,
            renderers=loader.renderers(),
        )
        return await run_prompt(session, text, renderer=renderer, console=aside)

    reason: SessionEndReason = 'error'
    try:
        async with agent:
            await loader.load_all()
            ended = await run_turn(prompt, loader=loader, console=aside, run=run)
            if ended.result is not None:
                reason = 'exit'
                if output_format == 'json':
                    out.write(json.dumps(report(ended.result)) + '\n')
                elif not streamed:
                    out.write(str(ended.result.output).rstrip('\n') + '\n')
                out.flush()
    finally:
        await loader.close(reason)
    return 0 if reason == 'exit' else 1


def report(result: AgentRunResult[OutputT]) -> dict[str, JsonValue]:
    """The `--output-format json` payload. `cost` is core's best-effort USD total, null when unpriced."""
    usage = result.usage
    return {
        'text': str(result.output),
        'usage': _USAGE.dump_python(usage, mode='json', exclude={'cost'}),
        'cost': None if usage.cost is None else float(usage.cost),
        'messages': ModelMessagesTypeAdapter.dump_python(result.all_messages(), mode='json'),
    }
