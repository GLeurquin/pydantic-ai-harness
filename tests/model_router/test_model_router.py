"""Public-agent tests for typed model routing."""

from __future__ import annotations

from typing import Literal

import pytest
from pydantic_ai import Agent
from pydantic_ai.exceptions import UsageLimitExceeded, UserError
from pydantic_ai.messages import ModelMessage, ModelResponse, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.usage import UsageLimits

from pydantic_ai_harness.model_router import ModelChoice, ModelRouter

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    # Core's run lifecycle uses asyncio.create_task.
    return 'asyncio'


def choices() -> dict[str, ModelChoice]:
    return {
        'fast': ModelChoice(model=TestModel(custom_output_text='fast'), description='Simple tasks'),
        'deep': ModelChoice(model=TestModel(custom_output_text='deep'), description='Complex reasoning'),
    }


def router_model(choice: str = 'deep', *, confidence: float = 0.9) -> TestModel:
    return TestModel(custom_output_args={'choice': choice, 'confidence': confidence})


class TestModelRouter:
    async def test_typed_menu_and_prompt(self) -> None:
        def select(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
            assert info.output_tools[0].parameters_json_schema['properties']['choice']['enum'] == ['fast', 'deep']
            assert 'Simple tasks' in (info.instructions or '')
            assert 'Solve my difficult problem' in str(messages)
            return ModelResponse(parts=[ToolCallPart(info.output_tools[0].name, {'choice': 'deep', 'confidence': 0.9})])

        router = ModelRouter[object](model=FunctionModel(select), choices=choices(), default='fast')
        result = await Agent(capabilities=[router]).run('Solve my difficult problem')
        assert result.output == 'deep'
        assert result.usage.requests == 2

    @pytest.mark.parametrize('scope,expected', [('run', 1), ('step', 2)])
    async def test_scope_and_run_isolation(self, scope: Literal['run', 'step'], expected: int) -> None:
        calls = 0

        def select(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
            nonlocal calls
            calls += 1
            return ModelResponse(parts=[ToolCallPart(info.output_tools[0].name, {'choice': 'deep', 'confidence': 1})])

        router = ModelRouter[object](model=FunctionModel(select), choices=choices(), default='fast', scope=scope)
        agent = Agent(capabilities=[router])

        @agent.tool_plain
        def work() -> str:
            return 'work complete'

        for _ in range(2):
            assert (await agent.run('Do work')).output == 'deep'
        assert calls == expected * 2

    @pytest.mark.parametrize(
        'choice,confidence,threshold,expected',
        [
            ('deep', 0.2, 0.5, 'fast'),
            ('deep', 0.5, 0.5, 'deep'),
            ('missing', 1, 0, 'fast'),
            ('deep', -1, 0, 'fast'),
            ('deep', 2, 0, 'fast'),
        ],
    )
    async def test_fallback(self, choice: str, confidence: float, threshold: float, expected: str) -> None:
        router = ModelRouter[object](
            model=router_model(choice, confidence=confidence),
            choices=choices(),
            default='fast',
            min_confidence=threshold,
        )
        assert (await Agent(capabilities=[router]).run('hello')).output == expected

    def test_not_spec_serializable(self) -> None:
        assert ModelRouter.get_serialization_name() is None

    async def test_router_resolution_error(self) -> None:
        router = ModelRouter[object](model='unknown:router', choices=choices(), default='fast')
        assert (await Agent(capabilities=[router]).run('hello')).output == 'fast'

    async def test_router_usage_limit_propagates(self) -> None:
        router = ModelRouter[object](model=router_model('missing'), choices=choices(), default='fast')
        with pytest.raises(UsageLimitExceeded):
            await Agent(capabilities=[router]).run('hello', usage_limits=UsageLimits(request_limit=1))

    async def test_router_error(self) -> None:
        def fail(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
            raise RuntimeError('router unavailable')

        router = ModelRouter[object](model=FunctionModel(fail), choices=choices(), default='fast')
        assert (await Agent(capabilities=[router]).run('hello')).output == 'fast'

    async def test_explicit_model_bypasses_router(self) -> None:
        def fail(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
            pytest.fail('router should not be called')  # pragma: no cover

        agent = Agent(capabilities=[ModelRouter(model=FunctionModel(fail), choices=choices(), default='fast')])
        assert (await agent.run('hello', model=TestModel(custom_output_text='explicit'))).output == 'explicit'

    async def test_streaming(self) -> None:
        router = ModelRouter[object](model=router_model(), choices=choices(), default='fast')
        async with Agent(capabilities=[router]).run_stream('hello') as result:
            assert await result.get_output() == 'deep'

    async def test_no_user_prompt(self) -> None:
        router = ModelRouter[object](model=router_model(), choices=choices(), default='fast')
        assert (await Agent(capabilities=[router], instructions='Say hello').run()).output == 'deep'

    async def test_candidate_failure_propagates(self) -> None:
        def fail(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
            raise RuntimeError('candidate unavailable')

        menu = choices()
        menu['deep'] = ModelChoice(model=FunctionModel(fail), description='Unavailable model')
        router = ModelRouter[object](model=router_model(), choices=menu, default='fast')
        with pytest.raises(RuntimeError, match='candidate unavailable'):
            await Agent(capabilities=[router]).run('hello')

    @pytest.mark.parametrize('threshold', [-0.1, 1.1, float('nan')])
    def test_invalid_threshold(self, threshold: float) -> None:
        with pytest.raises(UserError, match='min_confidence'):
            ModelRouter(model=router_model(), choices=choices(), default='fast', min_confidence=threshold)

    def test_invalid_scope(self) -> None:
        with pytest.raises(UserError, match='scope'):
            ModelRouter(
                model=router_model(),
                choices=choices(),
                default='fast',
                scope='invalid',  # pyright: ignore[reportArgumentType]
            )

    def test_invalid_menu(self) -> None:
        with pytest.raises(UserError, match='default'):
            ModelRouter(model=router_model(), choices={}, default='fast')
        with pytest.raises(UserError, match='default'):
            ModelRouter(model=router_model(), choices=choices(), default='missing')
        with pytest.raises(UserError, match='blank'):
            ModelRouter(
                model=router_model(), choices={' ': ModelChoice(model=TestModel(), description='ok')}, default=' '
            )
        with pytest.raises(UserError, match='blank'):
            ModelRouter(
                model=router_model(), choices={'x': ModelChoice(model=TestModel(), description=' ')}, default='x'
            )
