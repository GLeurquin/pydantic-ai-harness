"""Routing state, cancellation, and observability contracts."""

from __future__ import annotations

import anyio
import pytest
from logfire.testing import CaptureLogfire
from pydantic_ai import Agent
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.exceptions import UserError
from pydantic_ai.messages import ModelMessage, ModelResponse, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel

from pydantic_ai_harness.model_router import ModelChoice, ModelRouter
from tests.conftest import agent_run_names  # pyright: ignore[reportMissingTypeStubs]

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


def menu() -> dict[str, ModelChoice]:
    return {key: ModelChoice(model=TestModel(custom_output_text=key), description=key) for key in ('a', 'b')}


class TestModelRouterRuntime:
    async def test_concurrent_runs(self) -> None:
        entered = 0
        both_entered = anyio.Event()
        outputs: dict[str, str] = {}

        async def select(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
            nonlocal entered
            entered += 1
            if entered == 2:
                both_entered.set()
            await both_entered.wait()
            key = 'b' if 'choose-b' in str(messages) else 'a'
            return ModelResponse(parts=[ToolCallPart(info.output_tools[0].name, {'choice': key, 'confidence': 1})])

        router = ModelRouter[object](model=FunctionModel(select), choices=menu(), default='a')
        agent = Agent(capabilities=[router])

        async def run(key: str) -> None:
            outputs[key] = (await agent.run(f'choose-{key}')).output

        with anyio.fail_after(5):
            async with anyio.create_task_group() as group:
                group.start_soon(run, 'a')
                group.start_soon(run, 'b')
        assert outputs == {'a': 'a', 'b': 'b'}

    async def test_cancellation_is_not_fallback(self) -> None:
        entered = anyio.Event()
        cleaned = anyio.Event()
        returned = False

        async def select(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
            entered.set()
            try:
                await anyio.sleep_forever()
            finally:
                cleaned.set()
            raise AssertionError('unreachable')  # pragma: no cover

        router = ModelRouter[object](model=FunctionModel(select), choices=menu(), default='a')

        async def run() -> None:
            nonlocal returned
            await Agent(capabilities=[router]).run('hello')
            returned = True  # pragma: no cover

        with anyio.fail_after(5):
            async with anyio.create_task_group() as group:
                group.start_soon(run)
                await entered.wait()
                group.cancel_scope.cancel()
        assert cleaned.is_set()
        assert not returned

    @pytest.mark.parametrize('confidence,choice,reason', [(0.9, 'b', 'selected'), (0.1, 'a', 'low_confidence')])
    async def test_telemetry(
        self, capfire: CaptureLogfire, instrument_all_agents: None, confidence: float, choice: str, reason: str
    ) -> None:
        router = ModelRouter[object](
            model=TestModel(custom_output_args={'choice': 'b', 'confidence': confidence}),
            choices=menu(),
            default='a',
            min_confidence=0.5,
        )
        await Agent(capabilities=[router]).run('private prompt')
        spans = [span for span in capfire.exporter.exported_spans_as_dict() if span['name'] == 'model_router.select']
        assert len(spans) == 1
        attrs = spans[0]['attributes']
        assert attrs is not None
        assert attrs['model_router.choice'] == choice
        assert attrs['model_router.confidence'] == confidence
        assert attrs['model_router.reason'] == reason
        assert attrs['model_router.scope'] == 'run'
        assert attrs['model_router.step'] == 1
        assert 'private prompt' not in str(attrs)
        assert 'model_router' in agent_run_names(capfire)

    async def test_error_telemetry(self, capfire: CaptureLogfire, instrument_all_agents: None) -> None:
        router = ModelRouter[object](model='invalid:router', choices=menu(), default='a')
        await Agent(capabilities=[router]).run('hello')
        spans = [span for span in capfire.exporter.exported_spans_as_dict() if span['name'] == 'model_router.select']
        assert len(spans) == 1
        attrs = spans[0]['attributes']
        assert attrs is not None
        assert attrs['model_router.reason'] == 'router_error'
        assert 'model_router.confidence' not in attrs

    @pytest.mark.parametrize('engine', ['temporal', 'dbos', 'prefect', 'aws_lambda'])
    @pytest.mark.parametrize('active', [True, False])
    async def test_durable_context(self, engine: str, active: bool) -> None:
        class Durability(AbstractCapability[object]):
            in_durable_context = active

        Durability.__module__ = f'pydantic_ai.durable_exec.{engine}'
        router = ModelRouter[object](
            model=TestModel(custom_output_args={'choice': 'b', 'confidence': 1}), choices=menu(), default='a'
        )
        agent = Agent(capabilities=[router, Durability()])
        if active:
            with pytest.raises(UserError, match='not checkpointed'):
                await agent.run('hello')
        else:
            assert (await agent.run('hello')).output == 'b'

    async def test_last_router_wins(self) -> None:
        first = ModelRouter[object](model='invalid:unused', choices=menu(), default='a')
        last = ModelRouter[object](
            model=TestModel(custom_output_args={'choice': 'b', 'confidence': 1}), choices=menu(), default='a'
        )
        assert (await Agent(TestModel(), capabilities=[first, last]).run('hello')).output == 'b'
