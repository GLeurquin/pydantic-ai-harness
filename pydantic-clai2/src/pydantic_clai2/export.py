"""Write the current conversation to disk as Markdown or JSON. Nothing leaves the machine."""

import json
import textwrap
from collections.abc import Sequence
from datetime import datetime
from pathlib import Path

from pydantic_ai.messages import (
    BaseToolCallPart,
    BaseToolReturnPart,
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelResponse,
    RetryPromptPart,
    TextContent,
    TextPart,
    UserContent,
    UserPromptPart,
)

SUMMARY_WIDTH = 120
"""Longest one-line tool result summary in a Markdown export."""


def export_session(
    args: list[str], *, messages: Sequence[ModelMessage], model: str, workspace: Path, now: datetime
) -> str:
    """Handle `/export [PATH] [--force]`: `.json` writes core's message format, anything else Markdown."""
    force = '--force' in args
    positional = [arg for arg in args if arg != '--force']
    if len(positional) > 1:
        raise ValueError('Usage: /export [PATH] [--force]')
    if not messages:
        raise ValueError('Nothing to export yet.')
    name = positional[0] if positional else f'clai-session-{now:%Y%m%d-%H%M%S}.md'
    path = workspace / Path(name).expanduser()
    render = to_json if path.suffix == '.json' else to_markdown
    text = render(messages, model=model, now=now)
    try:
        with path.open('w' if force else 'x', encoding='utf-8') as file:
            file.write(text)
    except FileExistsError:
        raise ValueError(f'{path} exists. Add --force to overwrite it.') from None
    return f'Exported {len(messages)} messages to {path}'


def to_json(messages: Sequence[ModelMessage], *, model: str, now: datetime) -> str:
    """A header plus the messages exactly as `ModelMessagesTypeAdapter` serializes them."""
    payload = {
        'model': model,
        'exported_at': now.isoformat(),
        'messages': ModelMessagesTypeAdapter.dump_python(list(messages), mode='json'),
    }
    return json.dumps(payload, indent=2) + '\n'


def to_markdown(messages: Sequence[ModelMessage], *, model: str, now: datetime) -> str:
    """Prompts, answers, and every tool call (native ones too) with a one-line result; thinking and instructions are left out."""
    results = _tool_results(messages)
    stamps: list[datetime] = []
    body: list[str] = []
    for message in messages:
        if isinstance(message, ModelResponse):
            stamps.append(message.timestamp)
        for part in message.parts:
            if isinstance(part, UserPromptPart):
                stamps.append(part.timestamp)
                body.extend(['', '## User', '', _user_text(part)])
            elif isinstance(part, TextPart):
                body.extend(['', '## Assistant', '', part.content])
            elif isinstance(part, BaseToolCallPart):
                summary = results.get(part.tool_call_id, 'no result recorded')
                body.extend(['', f'- `{part.tool_name}({part.args_as_json_str()})`: {summary}'])
    header = [
        '# CLAI session',
        '',
        f'- Model: `{model}`',
        f'- Started: {min(stamps).isoformat() if stamps else "unknown"}',
        f'- Last message: {max(stamps).isoformat() if stamps else "unknown"}',
        f'- Exported: {now.isoformat()}',
    ]
    return '\n'.join(header + body) + '\n'


def _tool_results(messages: Sequence[ModelMessage]) -> dict[str, str]:
    results: dict[str, str] = {}
    for message in messages:
        for part in message.parts:
            if isinstance(part, BaseToolReturnPart):
                results[part.tool_call_id] = _one_line(part.model_response_str())
            elif isinstance(part, RetryPromptPart):
                results[part.tool_call_id] = 'retry requested: ' + _one_line(part.model_response())
    return results


def _user_text(part: UserPromptPart) -> str:
    if isinstance(part.content, str):
        return part.content
    return ' '.join(_content_text(item) for item in part.content)


def _content_text(item: UserContent) -> str:
    if isinstance(item, str):
        return item
    if isinstance(item, TextContent):
        return item.content
    return f'[{type(item).__name__}]'


def _one_line(text: str) -> str:
    first = next((line for line in text.splitlines() if line.strip()), '')
    return textwrap.shorten(first, width=SUMMARY_WIDTH, placeholder='...') or '(empty)'
