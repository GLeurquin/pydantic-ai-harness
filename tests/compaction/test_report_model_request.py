"""Tests for the `ReportModelRequest` capability."""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from typing import Any

import pytest
from pydantic_ai import Agent
from pydantic_ai.capabilities import AbstractCapability, Hooks
from pydantic_ai.messages import ModelRequest, UserPromptPart
from pydantic_ai.models import ModelRequestContext
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext

from pydantic_ai_harness.compaction import ModelRequestReportedEvent, ReportModelRequest

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


@dataclass
class _PrependMarkerMessage(AbstractCapability[Any]):
    """A stand-in for a compaction strategy: deterministically edits the pending request."""

    async def before_model_request(
        self, ctx: RunContext[Any], request_context: ModelRequestContext
    ) -> ModelRequestContext:
        marker = ModelRequest(parts=[UserPromptPart(content='marker')])
        return dataclasses.replace(request_context, messages=[marker, *request_context.messages])


def _recorder() -> tuple[list[ModelRequestReportedEvent], Hooks[Any]]:
    events: list[ModelRequestReportedEvent] = []
    hooks = Hooks[Any]()

    @hooks.on.event(ModelRequestReportedEvent)
    async def record(ctx: RunContext[Any], event: ModelRequestReportedEvent) -> None:
        events.append(event)

    return events, hooks


class TestReportModelRequest:
    async def test_emits_the_pending_messages(self) -> None:
        events, hooks = _recorder()
        await Agent(TestModel(), capabilities=[ReportModelRequest(), hooks]).run('go')

        assert len(events) == 1
        assert len(events[0].messages) == 1  # the single request built from the user prompt

    async def test_model_id_is_none_for_the_agents_own_model(self) -> None:
        events, hooks = _recorder()
        await Agent(TestModel(), capabilities=[ReportModelRequest(), hooks]).run('go')

        assert events[0].model_id is None

    async def test_model_id_reflects_a_run_level_string_override(self) -> None:
        events, hooks = _recorder()
        agent = Agent(TestModel(), capabilities=[ReportModelRequest(), hooks])
        await agent.run('go', model='test')

        assert events[0].model_id == 'test'

    async def test_registered_after_a_capability_sees_its_edit(self) -> None:
        """Order matters: a capability listed earlier runs first (`before_model_request`
        composes in list order), so `ReportModelRequest` placed after it observes the result."""
        events, hooks = _recorder()
        await Agent(TestModel(), capabilities=[_PrependMarkerMessage(), ReportModelRequest(), hooks]).run('go')

        assert len(events[0].messages) == 2

    async def test_registered_before_a_capability_misses_its_edit(self) -> None:
        events, hooks = _recorder()
        await Agent(TestModel(), capabilities=[ReportModelRequest(), _PrependMarkerMessage(), hooks]).run('go')

        assert len(events[0].messages) == 1

    async def test_never_edits_the_history(self) -> None:
        """It only observes: what it reports is exactly the request half of the final history,
        with only the model's own response appended after (a single turn makes no tool call)."""
        events, hooks = _recorder()
        result = await Agent(TestModel(), capabilities=[ReportModelRequest(), hooks]).run('go')

        assert events[0].messages == result.all_messages()[:-1]

    async def test_emits_one_event_per_model_request_across_multiple_turns(self) -> None:
        events, hooks = _recorder()
        agent = Agent(TestModel(call_tools=['output']), capabilities=[ReportModelRequest(), hooks])

        @agent.tool_plain
        def output() -> str:
            return 'done'

        await agent.run('go')

        # A tool call forces a second model request with the tool result folded in.
        assert len(events) == 2
        assert len(events[1].messages) > len(events[0].messages)
