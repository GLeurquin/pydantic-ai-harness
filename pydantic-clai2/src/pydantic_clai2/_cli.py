"""CLI settings resolution and application startup, interactive or one-shot."""

import argparse
import asyncio
import os
import sys
from pathlib import Path

from pydantic_ai.usage import UsageLimits

from ._app import DEFAULT_PLUGINS, chat, create_agent
from ._one_shot import one_shot, read_prompt
from .commands import config_command, plugins_command
from .config import resolve_settings
from .settings_store import SettingsStore


def run() -> None:
    """Parse explicit overrides without replacing persisted preferences."""
    parser = argparse.ArgumentParser(description='CLAI 2.0: streaming Pydantic AI terminal')
    parser.add_argument('--model', help='Provider-qualified model name')
    parser.add_argument('--request-limit', type=int)
    parser.add_argument('--database', type=Path, help='Settings database location')
    parser.add_argument('-p', '--prompt', help='Run one turn and exit; piped stdin is appended as context')
    parser.add_argument('--output-format', choices=('text', 'json'), help='One-shot output: text (default) or json')
    parser.add_argument('command', nargs='?', choices=('config', 'plugins'))
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    try:
        store = SettingsStore(args.database)
        if args.command:
            handler = config_command if args.command == 'config' else plugins_command
            print(handler(store, args.arguments))
            return
        overrides = store.overrides()
        if model := args.model or os.getenv('CLAI_MODEL'):
            overrides['model'] = model
        if args.request_limit is not None:
            overrides['run.request_limit'] = args.request_limit
        settings = resolve_settings(overrides)
        usage_limits = UsageLimits(request_limit=settings.request_limit)
        prompt = read_prompt(args.prompt, stdin=sys.stdin)
        if prompt is None:
            if args.output_format is not None:
                parser.error('--output-format needs -p/--prompt or a prompt on stdin')
            asyncio.run(
                chat(
                    create_agent(),
                    deps=None,
                    usage_limits=usage_limits,
                    settings=settings,
                    store=store,
                    builtin_plugins=DEFAULT_PLUGINS,
                )
            )
            return
        try:
            code = asyncio.run(
                one_shot(
                    create_agent(),
                    prompt,
                    deps=None,
                    usage_limits=usage_limits,
                    settings=settings,
                    store=store,
                    builtin_plugins=DEFAULT_PLUGINS,
                    output_format=args.output_format or 'text',
                )
            )
        except KeyboardInterrupt:
            code = 130
        sys.exit(code)
    except (ValueError, TypeError, ImportError, AttributeError) as exc:
        parser.error(str(exc))
    except KeyboardInterrupt:
        pass
