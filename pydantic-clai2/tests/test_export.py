"""`/export` writes the conversation to disk and never clobbers a file by accident."""

import io
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from prompt_toolkit.application import create_app_session
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.output import DummyOutput
from pydantic_ai import Agent
from pydantic_ai.messages import (
    BinaryContent,
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    RetryPromptPart,
    SystemPromptPart,
    TextPart,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.test import TestModel
from rich.console import Console

from pydantic_clai2 import chat
from pydantic_clai2.export import export_session, to_json, to_markdown
from pydantic_clai2.settings_store import SettingsStore

NOW = datetime(2026, 9, 17, 12, 30, 45, tzinfo=UTC)


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


def conversation() -> list[ModelMessage]:
    started = NOW - timedelta(minutes=5)
    return [
        ModelRequest(
            parts=[
                SystemPromptPart(content='be terse', timestamp=started),
                UserPromptPart(content='list files', timestamp=started),
            ]
        ),
        ModelResponse(
            parts=[
                ThinkingPart(content='hmm'),
                ToolCallPart(tool_name='ls', args={'path': '.'}, tool_call_id='call-1'),
                ToolCallPart(tool_name='cat', args='{"path": "x"}', tool_call_id='call-2'),
                ToolCallPart(tool_name='lost', args={}, tool_call_id='call-3'),
            ],
            timestamp=started + timedelta(seconds=1),
        ),
        ModelRequest(
            parts=[
                ToolReturnPart(tool_name='ls', content='a.py\nb.py', tool_call_id='call-1'),
                RetryPromptPart(content='wrong path', tool_name='cat', tool_call_id='call-2'),
                ToolReturnPart(tool_name='blank', content='', tool_call_id='call-4'),
            ]
        ),
        ModelResponse(
            parts=[TextPart(content='Two files: ' + 'x' * 200)],
            timestamp=started + timedelta(seconds=2),
        ),
        ModelRequest(
            parts=[
                UserPromptPart(
                    content=['and this?', BinaryContent(data=b'1', media_type='image/png')],
                    timestamp=started + timedelta(seconds=3),
                )
            ]
        ),
    ]


def test_markdown_lists_prompts_answers_and_tool_summaries() -> None:
    text = to_markdown(conversation(), model='test:model', now=NOW)
    assert text.startswith('# CLAI session\n\n- Model: `test:model`\n')
    assert '- Started: 2026-09-17T12:25:45+00:00\n- Last message: 2026-09-17T12:25:48+00:00\n' in text
    assert f'- Exported: {NOW.isoformat()}\n' in text
    assert '\n## User\n\nlist files\n' in text
    assert '- `ls({"path":"."})`: a.py\n' in text
    assert '- `cat({"path": "x"})`: retry requested: wrong path' in text
    assert '- `lost({})`: no result recorded\n' in text
    assert '\n## Assistant\n\nTwo files: ' in text
    assert '\n## User\n\nand this? [BinaryContent]\n' in text
    assert 'be terse' not in text
    assert 'hmm' not in text


def test_markdown_shortens_long_results_and_marks_empty_ones() -> None:
    messages = [
        ModelResponse(parts=[ToolCallPart(tool_name='big', args={}, tool_call_id='big')]),
        ModelRequest(
            parts=[
                ToolReturnPart(tool_name='big', content='word ' * 100, tool_call_id='big'),
                ToolReturnPart(tool_name='blank', content='', tool_call_id='blank'),
            ]
        ),
        ModelResponse(parts=[ToolCallPart(tool_name='blank', args={}, tool_call_id='blank')]),
    ]
    text = to_markdown(messages, model='m', now=NOW)
    line = next(line for line in text.splitlines() if line.startswith('- `big'))
    assert line.endswith('...') and len(line) < 140
    assert '- `blank({})`: (empty)' in text


def test_markdown_without_prompts_or_responses_has_unknown_times() -> None:
    messages = [ModelRequest(parts=[SystemPromptPart(content='only instructions')])]
    text = to_markdown(messages, model='m', now=NOW)
    assert '- Started: unknown\n- Last message: unknown\n' in text


def test_json_round_trips_through_core_adapter() -> None:
    messages = conversation()
    payload = json.loads(to_json(messages, model='test:model', now=NOW))
    assert payload['model'] == 'test:model'
    assert payload['exported_at'] == NOW.isoformat()
    restored = ModelMessagesTypeAdapter.validate_python(payload['messages'])
    assert ModelMessagesTypeAdapter.dump_python(restored, mode='json') == payload['messages']
    assert [type(message) for message in restored] == [type(message) for message in messages]


def test_export_session_paths_and_force(tmp_path: Path) -> None:
    messages = conversation()
    default = export_session([], messages=messages, model='m', workspace=tmp_path, now=NOW)
    written = tmp_path / 'clai-session-20260917-123045.md'
    assert default == f'Exported 5 messages to {written}'
    assert written.read_text(encoding='utf-8').startswith('# CLAI session')
    with pytest.raises(ValueError, match='Add --force'):
        export_session(['clai-session-20260917-123045.md'], messages=messages, model='m', workspace=tmp_path, now=NOW)
    export_session(
        ['--force', 'clai-session-20260917-123045.md'], messages=messages, model='m', workspace=tmp_path, now=NOW
    )
    export_session(['notes.json'], messages=messages, model='m', workspace=tmp_path, now=NOW)
    assert json.loads((tmp_path / 'notes.json').read_text(encoding='utf-8'))['model'] == 'm'
    absolute = tmp_path / 'elsewhere' / 'out.md'
    absolute.parent.mkdir()
    export_session([str(absolute)], messages=messages, model='m', workspace=tmp_path / 'other', now=NOW)
    assert absolute.exists()
    with pytest.raises(ValueError, match='Usage'):
        export_session(['a', 'b'], messages=messages, model='m', workspace=tmp_path, now=NOW)
    with pytest.raises(ValueError, match='Nothing to export'):
        export_session([], messages=[], model='m', workspace=tmp_path, now=NOW)


async def test_export_command_uses_live_conversation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    agent = Agent(TestModel(call_tools=['shout'], custom_output_text='Done shouting.'))

    @agent.tool_plain
    def shout(word: str) -> str:
        return word.upper() + '\nsecond line'

    output = io.StringIO()
    with create_pipe_input() as pipe, create_app_session(input=pipe, output=DummyOutput()):
        pipe.send_text('/export\nhello\n/export talk.md\n/export talk.md\n/exit\n')
        await chat(agent, deps=None, console=Console(file=output), store=SettingsStore(tmp_path / 'config.db'))
    text = output.getvalue()
    assert 'Nothing to export yet.' in text
    assert 'Exported 4 messages to' in text
    assert 'exists. Add --force' in text
    exported = (tmp_path / 'talk.md').read_text(encoding='utf-8')
    assert '- Model: `test`' in exported
    assert '## User\n\nhello\n' in exported
    assert '- `shout({"word":"a"})`: A\n' in exported
    assert '## Assistant\n\nDone shouting.' in exported
