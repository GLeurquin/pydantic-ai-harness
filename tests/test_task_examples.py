"""Executable tests for the task-led examples."""

from __future__ import annotations

import copy
import json
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, DeltaToolCalls, FunctionModel

from examples.manage_long_context import build_agent as build_context_agent  # pyright: ignore[reportMissingTypeStubs]
from examples.protect_coding_agent_secrets import (  # pyright: ignore[reportMissingTypeStubs]
    build_agent as build_secret_agent,
)
from examples.recover_file_migration import (  # pyright: ignore[reportMissingTypeStubs]
    build_agent as build_migration_agent,
)
from examples.recover_file_migration import resume_migration  # pyright: ignore[reportMissingTypeStubs]
from pydantic_ai_harness.compaction import ContextUsageEvent
from pydantic_ai_harness.step_persistence import SqliteStepStore
from pydantic_ai_harness.step_persistence.recovery import inspect_recovery

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


async def test_file_migration_reconciles_a_failed_side_effect(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config_dir = tmp_path / 'configs'
    config_dir.mkdir()
    api = config_dir / 'api.yaml'
    worker = config_dir / 'worker.yaml'
    for path in (api, worker):
        path.write_text(json.dumps({'schema_version': 1, 'service': path.stem}))

    writes: list[str] = []
    original_replace = Path.replace

    fail_worker_once = True

    def replace_then_fail(source: Path, target: Path) -> Path:
        nonlocal fail_worker_once
        replaced = original_replace(source, target)
        writes.append(target.name)
        if target.name == 'worker.yaml' and fail_worker_once:
            fail_worker_once = False
            raise RuntimeError('worker stopped after the atomic replace')
        return replaced

    async def model_fn(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        del info
        called_paths = [
            str(part.args_as_dict()['path'])
            for message in messages
            if isinstance(message, ModelResponse)
            for part in message.parts
            if isinstance(part, ToolCallPart) and part.tool_name == 'migrate_file'
        ]
        if 'configs/api.yaml' not in called_paths:
            return ModelResponse(parts=[ToolCallPart('migrate_file', {'path': 'configs/api.yaml'})])
        if 'configs/worker.yaml' not in called_paths:
            return ModelResponse(parts=[ToolCallPart('migrate_file', {'path': 'configs/worker.yaml'})])
        return ModelResponse(parts=[TextPart('Both configuration files are at schema version 2.')])

    store = SqliteStepStore(database=tmp_path / 'steps.db')
    agent = build_migration_agent(FunctionModel(model_fn), workspace=tmp_path, store=store)

    monkeypatch.setattr(Path, 'replace', replace_then_fail)
    with pytest.raises(RuntimeError, match='stopped after the atomic replace'):
        await agent.run('Migrate both configuration files.', run_id='migration')
    recovery = await inspect_recovery(store=store, run_id='migration')
    assert recovery.unresolved == ()
    assert recovery.failed_tools == ('migrate_file',)
    assert recovery.settled is not None

    result = await resume_migration(agent, store, failed_run_id='migration')
    assert result.output == 'Both configuration files are at schema version 2.'
    assert writes == ['api.yaml', 'worker.yaml']
    assert any(
        isinstance(part, ToolReturnPart) and 'no write performed' in str(part.content)
        for message in result.all_messages()
        if isinstance(message, ModelRequest)
        for part in message.parts
    )
    assert json.loads(api.read_text())['schema_version'] == 2
    assert json.loads(worker.read_text())['schema_version'] == 2


async def test_secret_controls_cover_files_shell_results_and_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    secret = 'sk-123456789012345678901234'
    (tmp_path / '.env').write_text(f'OPENAI_API_KEY={secret}\n')
    monkeypatch.setenv('OPENAI_API_KEY', secret)

    async def model_fn(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        del info
        calls = [
            part.tool_name
            for message in messages
            if isinstance(message, ModelResponse)
            for part in message.parts
            if isinstance(part, ToolCallPart)
        ]
        if 'read_file' not in calls:
            return ModelResponse(parts=[ToolCallPart('read_file', {'path': '.env'})])
        if calls.count('run_command') == 0:
            return ModelResponse(parts=[ToolCallPart('run_command', {'command': 'env'})])
        if calls.count('run_command') == 1:
            return ModelResponse(parts=[ToolCallPart('run_command', {'command': 'cat .env'})])
        return ModelResponse(parts=[TextPart(f'The build is healthy. I found {secret}.')])

    agent = build_secret_agent(FunctionModel(model_fn), workspace=tmp_path)
    result = await agent.run('Inspect the project without exposing credentials.')

    assert secret not in result.output
    assert '[redacted:openai_key]' in result.output
    requests = [message for message in result.all_messages() if isinstance(message, ModelRequest)]
    retries = [part for message in requests for part in message.parts if isinstance(part, RetryPromptPart)]
    assert any('denied' in str(part.content).lower() for part in retries)

    tool_results = [part.content for message in requests for part in message.parts if isinstance(part, ToolReturnPart)]
    assert any('OPENAI_API_KEY' not in str(content) and 'PATH=' in str(content) for content in tool_results)
    assert any('[redacted:openai_key]' in str(content) for content in tool_results)
    assert all(secret not in str(content) for content in tool_results)


async def test_tiered_compaction_preserves_tool_pairing_and_reports_usage() -> None:
    next_record = 1
    requests: list[list[ModelMessage]] = []
    usage_events: list[ContextUsageEvent] = []

    async def stream_fn(messages: list[ModelMessage], info: AgentInfo) -> AsyncIterator[DeltaToolCalls | str]:
        nonlocal next_record
        del info
        requests.append(copy.deepcopy(messages))
        if next_record <= 8:
            record_id = next_record
            next_record += 1
            yield {
                0: DeltaToolCall(
                    name='read_record',
                    json_args=json.dumps({'record_id': record_id}),
                    tool_call_id=f'record-{record_id}',
                )
            }
        else:
            yield 'Records 3 and 7 need attention.'

    agent = build_context_agent(
        FunctionModel(stream_function=stream_fn),
        observe_context=usage_events.append,
        target_fraction=0.25,
        fallback_context_window=200,
    )
    result = await agent.run('Inspect records 1 through 8 and identify those that need attention.')

    assert result.output == 'Records 3 and 7 need attention.'
    final_request = requests[-1]
    all_returns = [
        part
        for request in requests
        for message in request
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, ToolReturnPart)
    ]
    assert any(part.content == '[tool result cleared]' for part in all_returns)

    for request in requests:
        open_calls: set[str] = set()
        for message in request:
            if isinstance(message, ModelResponse):
                open_calls.update(part.tool_call_id for part in message.parts if isinstance(part, ToolCallPart))
            else:
                for part in message.parts:
                    if isinstance(part, ToolReturnPart):
                        assert part.tool_call_id in open_calls
                        open_calls.remove(part.tool_call_id)
        assert not open_calls

    assert len(final_request) < 1 + 2 * 8  # initial prompt plus eight untrimmed call/return pairs
    assert usage_events
    raw_tool_tokens = 8 * len('diagnostic context ' * 80) // 4
    assert usage_events[-1].used_tokens < raw_tool_tokens
    assert all(event.window_tokens == 200 and not event.resolved for event in usage_events)
