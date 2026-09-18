"""Tests for `ToolCallJudge`."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import is_dataclass
from typing import TYPE_CHECKING, Literal

import pytest
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import NoOpTracer, Tracer
from pydantic_ai import Agent, AgentSpec, CallDeferred, DeferredToolRequests, ToolDenied
from pydantic_ai.capabilities import HandleDeferredToolCalls
from pydantic_ai.exceptions import UserError
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import DeferredToolResults, RunContext
from pydantic_ai.usage import RunUsage

from pydantic_ai_harness.tool_call_judge import ToolCallJudge, ToolCallVerdict
from tests.conftest import agent_run_names  # pyright: ignore[reportMissingTypeStubs]

if TYPE_CHECKING:
    from logfire.testing import CaptureLogfire

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


def _judge_model(
    answer: Literal['yes', 'no', 'unsure'],
    *,
    confidence: float | None = None,
    prompts: list[str] | None = None,
    instructions: list[str] | None = None,
) -> FunctionModel:
    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        if prompts is not None:
            prompts.extend(
                part.content
                for message in messages
                if isinstance(message, ModelRequest)
                for part in message.parts
                if isinstance(part, UserPromptPart) and isinstance(part.content, str)
            )
        if instructions is not None and info.instructions is not None:
            instructions.append(info.instructions)
        output_tool = info.output_tools[0]
        provider_details = {'confidence': {'response': confidence}} if confidence is not None else None
        return ModelResponse(
            parts=[ToolCallPart(output_tool.name, {'response': answer})],
            provider_details=provider_details,
        )

    return FunctionModel(respond)


def _error_model() -> FunctionModel:
    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        raise RuntimeError('judge unavailable')

    return FunctionModel(respond)


def _judge_model_with_provider_details(provider_details: dict[str, object]) -> FunctionModel:
    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        output_tool = info.output_tools[0]
        return ModelResponse(
            parts=[ToolCallPart(output_tool.name, {'response': 'no'})],
            provider_details=provider_details,
        )

    return FunctionModel(respond)


def _outer_model(
    tool_name: str, *, args: dict[str, object] | None = None, returns: list[ToolReturnPart] | None = None
) -> FunctionModel:
    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        tool_returns = [
            part
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, ToolReturnPart)
        ]
        if tool_returns:
            if returns is not None:
                returns.extend(tool_returns)
            return ModelResponse(parts=[TextPart('done')])
        return ModelResponse(parts=[ToolCallPart(tool_name, args or {}, tool_call_id='call-1')])

    return FunctionModel(respond)


def _judge(
    model: FunctionModel,
    *,
    tools: tuple[str, ...] = ('danger',),
    on_uncertain: Literal['deny', 'defer'] = 'deny',
    denial_message: str = 'judge denied',
    on_verdict: Callable[[ToolCallVerdict], None] | None = None,
) -> ToolCallJudge[None]:
    return ToolCallJudge(
        model,
        tools=tools,
        question='Would this cause harm?',
        on_uncertain=on_uncertain,
        denial_message=denial_message,
        on_verdict=on_verdict,
    )


def _recording_tracer() -> tuple[Tracer, InMemorySpanExporter]:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return provider.get_tracer('test'), exporter


def _ctx(*, tracer: Tracer | None = None, trace_include_content: bool = False) -> RunContext[None]:
    return RunContext(
        deps=None,
        model=TestModel(),
        usage=RunUsage(),
        tracer=tracer if tracer is not None else NoOpTracer(),
        trace_include_content=trace_include_content,
    )


def _requests(*calls: ToolCallPart) -> DeferredToolRequests:
    return DeferredToolRequests(approvals=list(calls))


def _only_span(exporter: InMemorySpanExporter) -> ReadableSpan:
    spans = exporter.get_finished_spans()
    assert len(spans) == 1
    return spans[0]


class TestConfiguration:
    def test_is_a_dataclass_with_capability_fields(self) -> None:
        judge = ToolCallJudge(
            _judge_model('no'),
            tools=['danger'],
            question='Risky?',
            id='risk-judge',
            description='judges risky tools',
            defer_loading=True,
        )

        assert is_dataclass(judge)
        assert (judge.id, judge.description, judge.defer_loading) == ('risk-judge', 'judges risky tools', True)
        assert judge.tools == ('danger',)

    @pytest.mark.parametrize('tools', ['danger', [], ['', 'danger'], [1]])
    def test_rejects_an_invalid_scope(self, tools: object) -> None:
        with pytest.raises(UserError, match='ToolCallJudge.tools'):
            ToolCallJudge(_judge_model('no'), tools=tools, question='Risky?')  # pyright: ignore[reportArgumentType]

    def test_rejects_an_empty_question(self) -> None:
        with pytest.raises(UserError, match='question must not be empty'):
            ToolCallJudge(_judge_model('no'), tools=['danger'], question='  ')

    def test_rejects_an_invalid_uncertainty_policy(self) -> None:
        with pytest.raises(UserError, match='on_uncertain'):
            ToolCallJudge(
                _judge_model('no'),
                tools=['danger'],
                question='Risky?',
                on_uncertain='approve',  # pyright: ignore[reportArgumentType]
            )

    def test_rejects_an_empty_denial_message(self) -> None:
        with pytest.raises(UserError, match='denial_message'):
            ToolCallJudge(_judge_model('no'), tools=['danger'], question='Risky?', denial_message='')

    def test_agent_spec_builds_the_serializable_configuration(self) -> None:
        judge = ToolCallJudge.from_spec(
            model='test',
            tools=['danger'],
            question='Risky?',
            on_uncertain='defer',
            denial_message='denied',
            id='risk-judge',
            description='judges risky tools',
            defer_loading=True,
        )

        assert judge.model == 'test'
        assert judge.tools == ('danger',)
        assert judge.on_uncertain == 'defer'
        assert (judge.id, judge.description, judge.defer_loading) == ('risk-judge', 'judges risky tools', True)

    def test_agent_spec_schema_includes_configuration_and_base_fields(self) -> None:
        schema = AgentSpec.model_json_schema_with_capabilities([ToolCallJudge])
        params = schema['$defs']['spec_params_ToolCallJudge']
        properties = params['properties']

        assert params['additionalProperties'] is False
        assert set(properties) == {
            'model',
            'tools',
            'question',
            'on_uncertain',
            'denial_message',
            'id',
            'description',
            'defer_loading',
        }
        assert set(params['required']) == {'model', 'tools', 'question'}
        assert ToolCallJudge.get_serialization_name() == 'ToolCallJudge'

    def test_agent_spec_loads_the_capability(self) -> None:
        agent = Agent.from_spec(
            {
                'model': 'test',
                'capabilities': [
                    {
                        'ToolCallJudge': {
                            'model': 'test',
                            'tools': ['danger'],
                            'question': 'Risky?',
                            'on_uncertain': 'defer',
                        }
                    }
                ],
            },
            custom_capability_types=[ToolCallJudge],
        )

        capability = agent.root_capability.capabilities[-1]
        assert isinstance(capability, ToolCallJudge)
        assert capability.tools == ('danger',)
        assert capability.on_uncertain == 'defer'


class TestApprovalDecisions:
    async def test_no_approves_and_executes_the_tool(self) -> None:
        executed: list[str] = []
        verdicts: list[ToolCallVerdict] = []
        prompts: list[str] = []
        instructions: list[str] = []
        agent = Agent(
            _outer_model('danger', args={'command': 'echo hello'}),
            deps_type=type(None),
            capabilities=[
                _judge(
                    _judge_model('no', confidence=0.94, prompts=prompts, instructions=instructions),
                    on_verdict=verdicts.append,
                )
            ],
        )

        @agent.tool_plain(requires_approval=True)
        def danger(command: str) -> str:
            executed.append(command)
            return 'ran'

        result = await agent.run('outer conversation secret')

        assert result.output == 'done'
        assert executed == ['echo hello']
        assert verdicts == [
            ToolCallVerdict(
                tool_name='danger',
                tool_call_id='call-1',
                verdict='approve',
                answer='no',
                confidence=0.94,
            )
        ]
        assert len(prompts) == 1
        assert prompts[0] == '{"tool_name": "danger", "arguments": {"command":"echo hello"}}'
        assert instructions and 'Would this cause harm?' in instructions[0]
        assert 'danger' in prompts[0]
        assert 'echo hello' in prompts[0]
        assert 'outer conversation secret' not in prompts[0]

    async def test_yes_denies_without_executing_the_tool(self) -> None:
        executed = False
        returns: list[ToolReturnPart] = []
        agent = Agent(
            _outer_model('danger', returns=returns),
            deps_type=type(None),
            capabilities=[_judge(_judge_model('yes'), denial_message='policy refused this call')],
        )

        @agent.tool_plain(requires_approval=True)
        def danger() -> str:  # pragma: no cover - denied before execution
            nonlocal executed
            executed = True
            return 'ran'

        result = await agent.run('try it')

        assert result.output == 'done'
        assert executed is False
        assert returns[-1].content == 'policy refused this call'
        assert returns[-1].outcome == 'denied'

    @pytest.mark.parametrize(('model', 'answer'), [(_judge_model('unsure'), 'unsure'), (_error_model(), None)])
    async def test_uncertainty_denies_by_default(self, model: FunctionModel, answer: str | None) -> None:
        verdicts: list[ToolCallVerdict] = []
        judge = _judge(model, on_verdict=verdicts.append)

        result = await judge.handle_deferred_tool_calls(
            _ctx(),
            requests=_requests(ToolCallPart('danger', {}, tool_call_id='call-1')),
        )

        assert result is not None
        assert isinstance(result.approvals['call-1'], ToolDenied)
        assert verdicts[0].verdict == 'deny'
        assert verdicts[0].answer == answer

    @pytest.mark.parametrize('model', [_judge_model('unsure'), _error_model()])
    async def test_uncertainty_can_be_left_for_a_person(self, model: FunctionModel) -> None:
        verdicts: list[ToolCallVerdict] = []
        judge = _judge(model, on_uncertain='defer', on_verdict=verdicts.append)

        result = await judge.handle_deferred_tool_calls(
            _ctx(),
            requests=_requests(ToolCallPart('danger', {}, tool_call_id='call-1')),
        )

        assert result is None
        assert verdicts[0].verdict == 'defer'

    async def test_unselected_approval_bubbles_up_without_calling_the_judge(self) -> None:
        calls = 0

        def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:  # pragma: no cover - not selected
            nonlocal calls
            calls += 1
            return ModelResponse(parts=[TextPart('unexpected')])

        agent = Agent(
            _outer_model('safe'),
            deps_type=type(None),
            capabilities=[_judge(FunctionModel(respond), tools=('danger',))],
            output_type=[str, DeferredToolRequests],
        )

        @agent.tool_plain(requires_approval=True)
        def safe() -> str:  # pragma: no cover - unresolved
            return 'ran'

        result = await agent.run('try it')

        assert isinstance(result.output, DeferredToolRequests)
        assert [call.tool_name for call in result.output.approvals] == ['safe']
        assert calls == 0

    async def test_external_call_bubbles_up_even_when_its_name_is_selected(self) -> None:
        agent = Agent(
            _outer_model('danger'),
            deps_type=type(None),
            capabilities=[_judge(_judge_model('no'))],
            output_type=[str, DeferredToolRequests],
        )

        @agent.tool_plain
        def danger() -> str:
            raise CallDeferred

        result = await agent.run('try it')

        assert isinstance(result.output, DeferredToolRequests)
        assert [call.tool_name for call in result.output.calls] == ['danger']

    async def test_later_handler_receives_only_the_unselected_approval(self) -> None:
        handled: list[list[str]] = []

        def approve_remaining(ctx: RunContext[None], requests: DeferredToolRequests) -> DeferredToolResults:
            handled.append([call.tool_name for call in requests.approvals])
            return requests.build_results(approve_all=True)

        agent = Agent(
            _outer_model('safe'),
            deps_type=type(None),
            capabilities=[
                _judge(_judge_model('yes'), tools=('danger',)),
                HandleDeferredToolCalls(approve_remaining),
            ],
        )

        @agent.tool_plain(requires_approval=True)
        def safe() -> str:
            return 'ran'

        result = await agent.run('try it')

        assert result.output == 'done'
        assert handled == [['safe']]


class TestObservability:
    async def test_span_records_verdict_and_confidence_without_arguments_by_default(self) -> None:
        tracer, exporter = _recording_tracer()
        judge = _judge(_judge_model('no', confidence=0.81))

        await judge.handle_deferred_tool_calls(
            _ctx(tracer=tracer),
            requests=_requests(ToolCallPart('danger', {'secret': 'value'}, tool_call_id='call-1')),
        )

        span = _only_span(exporter)
        assert span.name == 'judge tool call'
        assert dict(span.attributes or {}) == {
            'tool_call_judge.tool': 'danger',
            'tool_call_judge.tool_call_id': 'call-1',
            'tool_call_judge.model_result': 'no',
            'tool_call_judge.verdict': 'approve',
            'tool_call_judge.confidence': 0.81,
        }

    @pytest.mark.parametrize(
        'provider_details',
        [
            {},
            {'confidence': 'high'},
            {'confidence': {}},
            {'confidence': {'response': True}},
            {'confidence': {'response': '0.9'}},
            {'confidence': {'response': 1.1}},
        ],
    )
    async def test_ignores_invalid_or_missing_provider_confidence(self, provider_details: dict[str, object]) -> None:
        verdicts: list[ToolCallVerdict] = []
        judge = _judge(_judge_model_with_provider_details(provider_details), on_verdict=verdicts.append)

        await judge.handle_deferred_tool_calls(
            _ctx(),
            requests=_requests(ToolCallPart('danger', {}, tool_call_id='call-1')),
        )

        assert verdicts[0].confidence is None

    async def test_span_records_arguments_only_when_content_is_enabled(self) -> None:
        tracer, exporter = _recording_tracer()
        judge = _judge(_judge_model('yes'))

        await judge.handle_deferred_tool_calls(
            _ctx(tracer=tracer, trace_include_content=True),
            requests=_requests(ToolCallPart('danger', {'path': '/tmp/x'}, tool_call_id='call-1')),
        )

        assert dict(_only_span(exporter).attributes or {})['tool_call_judge.arguments'] == '{"path":"/tmp/x"}'

    async def test_span_records_model_error_and_fail_closed_verdict(self) -> None:
        tracer, exporter = _recording_tracer()
        judge = _judge(_error_model())

        await judge.handle_deferred_tool_calls(
            _ctx(tracer=tracer),
            requests=_requests(ToolCallPart('danger', {}, tool_call_id='call-1')),
        )

        attributes = dict(_only_span(exporter).attributes or {})
        assert attributes['tool_call_judge.model_result'] == 'error'
        assert attributes['tool_call_judge.error.type'] == 'RuntimeError'
        assert attributes['tool_call_judge.verdict'] == 'deny'

    @pytest.mark.usefixtures('instrument_all_agents')
    async def test_internal_agent_run_is_named_after_the_capability(self, capfire: CaptureLogfire) -> None:
        judge = _judge(_judge_model('no'))

        await judge.handle_deferred_tool_calls(
            _ctx(),
            requests=_requests(ToolCallPart('danger', {}, tool_call_id='call-1')),
        )

        assert 'tool_call_judge' in agent_run_names(capfire)
