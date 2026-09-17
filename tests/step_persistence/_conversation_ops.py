"""One scenario for `update_run_metadata` and `delete_conversation`, run against every `StepStore`.

`test_conversation_ops.py` covers the three base stores; `test_mongo.py` runs
the same scenario against `MongoStepStore` behind its `pymongo` gate.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, UserPromptPart

from pydantic_ai_harness.step_persistence import (
    ContinuableSnapshot,
    RunRecord,
    StepEvent,
    StepStore,
    ToolEffectRecord,
)


def _messages(text: str) -> list[ModelMessage]:
    return [ModelRequest(parts=[UserPromptPart(content=text)]), ModelResponse(parts=[TextPart(content='ok')])]


def _prompt(snapshot: ContinuableSnapshot | None) -> str:
    assert snapshot is not None
    first = snapshot.messages[0]
    assert isinstance(first, ModelRequest)
    part = first.parts[0]
    assert isinstance(part, UserPromptPart) and isinstance(part.content, str)
    return part.content


async def populate(store: StepStore) -> None:
    """Two runs in conversation `a`, one in `b`, each with an event, a keyed snapshot, and an open tool call."""
    base = datetime(2024, 1, 1, tzinfo=timezone.utc)
    runs = [('r1', 'a', 0), ('r2', 'a', 1), ('r3', 'b', 2)]
    for run_id, conversation_id, offset in runs:
        await store.register_run(
            RunRecord(
                run_id=run_id,
                conversation_id=conversation_id,
                metadata={'cwd': '/work'},
                started_at=base + timedelta(seconds=offset),
            )
        )
        await store.append_event(StepEvent(run_id=run_id, kind='run_started', step_index=0))
        await store.save_snapshot(
            ContinuableSnapshot(run_id=run_id, step_index=1, messages=_messages(run_id), idempotency_key='0:1:complete')
        )
        await store.record_tool_effect(
            ToolEffectRecord(tool_call_id='t1', tool_name='add', run_id=run_id, status='started')
        )


async def exercise_conversation_ops(store: StepStore) -> None:
    await populate(store)

    await store.update_run_metadata(run_id='r1', metadata={'cwd': '/work', 'title': 'Greeting'})
    updated = await store.get_run(run_id='r1')
    assert updated is not None and updated.metadata == {'cwd': '/work', 'title': 'Greeting'}
    assert updated.conversation_id == 'a' and updated.started_at == datetime(2024, 1, 1, tzinfo=timezone.utc)
    listed = {record.run_id: record.metadata for record in await store.list_runs(conversation_id='a')}
    assert listed == {'r1': {'cwd': '/work', 'title': 'Greeting'}, 'r2': {'cwd': '/work'}}, 'sibling run untouched'
    await store.update_run_metadata(run_id='r1', metadata={})
    cleared = await store.get_run(run_id='r1')
    assert cleared is not None and cleared.metadata == {}, 'the mapping is replaced, not merged'
    with pytest.raises(LookupError, match="no run with id 'missing'"):
        await store.update_run_metadata(run_id='missing', metadata={'title': 'x'})

    await store.delete_conversation(conversation_id='a')
    assert await store.list_runs(conversation_id='a') == []
    for run_id in ('r1', 'r2'):
        assert await store.get_run(run_id=run_id) is None
        assert await store.list_events(run_id=run_id) == []
        assert await store.latest_snapshot(run_id=run_id, include_interrupted=True) is None
        assert await store.get_tool_effect(run_id=run_id, tool_call_id='t1') is None
        assert await store.list_unresolved_tool_effects(run_id=run_id) == []
    survivor = await store.get_run(run_id='r3')
    assert survivor is not None and survivor.conversation_id == 'b'
    assert [event.kind for event in await store.list_events(run_id='r3')] == ['run_started']
    assert _prompt(await store.latest_snapshot(run_id='r3')) == 'r3'
    assert len(await store.list_unresolved_tool_effects(run_id='r3')) == 1

    await store.delete_conversation(conversation_id='never-existed')
    assert [record.run_id for record in await store.list_runs()] == ['r3']

    # A deleted run id is free again, including the snapshot idempotency key it used before.
    await store.register_run(RunRecord(run_id='r1', conversation_id='a'))
    await store.save_snapshot(
        ContinuableSnapshot(run_id='r1', step_index=1, messages=_messages('again'), idempotency_key='0:1:complete')
    )
    assert _prompt(await store.latest_snapshot(run_id='r1')) == 'again'
