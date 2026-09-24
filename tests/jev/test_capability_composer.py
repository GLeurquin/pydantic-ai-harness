"""Tests for `JevCapabilityComposer`.

Jev is stood in for by a `FunctionModel` that answers the composer's output tool and reports
`provider_details['confidence']` the way Pydantic AI's `TypeSafeModel` does.
"""

from __future__ import annotations

import importlib.util
from collections.abc import AsyncIterable, Sequence
from dataclasses import dataclass
from importlib.machinery import ModuleSpec
from pathlib import Path

import pytest
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import NoOpTracer
from pydantic_ai import Agent, AgentStreamEvent
from pydantic_ai.capabilities import AbstractCapability, CapabilityOrdering
from pydantic_ai.exceptions import UnexpectedModelBehavior, UserError
from pydantic_ai.messages import (
    BinaryContent,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    UserPromptPart,
)
from pydantic_ai.models import ModelRequestContext, ModelRequestParameters
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.instrumented import InstrumentationSettings
from pydantic_ai.models.test import TestModel
from pydantic_ai.profiles import ModelProfile
from pydantic_ai.settings import ModelSettings
from pydantic_ai.tools import RunContext, Tool
from pydantic_ai.toolsets import FunctionToolset
from pydantic_ai.usage import RunUsage

from pydantic_ai_harness.jev import (
    SKILLS_DIRECTORY,
    CapabilitiesComposedEvent,
    ComposableCapability,
    Composition,
    JevCapabilityComposer,
    Thinking,
    default_catalog,
)
from pydantic_ai_harness.subagents import ModelOption

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


@dataclass
class Notes(AbstractCapability[object]):
    """A catalog capability with one tool, named from its argument so spec arguments are observable."""

    prefix: str = 'notes'

    def get_toolset(self) -> FunctionToolset[object]:
        def take_note() -> str:
            return 'noted'

        return FunctionToolset([Tool(take_note, name=f'{self.prefix}_take')])


@dataclass
class Clock(AbstractCapability[object]):
    """A second catalog capability."""

    def get_toolset(self) -> FunctionToolset[object]:
        def now() -> str:
            return 'noon'

        return FunctionToolset([Tool(now, name='clock_now')])


@dataclass
class Unloadable(AbstractCapability[object]):
    @classmethod
    def get_serialization_name(cls) -> str | None:
        return None


CATALOG = {
    'notes': ComposableCapability(description='Keep notes', capability=Notes, arguments={'prefix': 'memo'}),
    'clock': ComposableCapability(description='Tell the time', capability=Clock),
}


@dataclass
class Jev:
    """A picker model with a fixed answer, recording the prompts and output schemas it was sent."""

    model: str = 'strong'
    thinking: str = 'high'
    capabilities: Sequence[str] = ('notes',)
    confidence: dict[str, float] | None = None

    def __post_init__(self) -> None:
        self.prompts: list[str] = []
        self.schemas: list[dict[str, object]] = []

    def respond(self, messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        [prompt] = [p.content for m in messages for p in m.parts if isinstance(p, UserPromptPart)]
        assert isinstance(prompt, str)
        self.prompts.append(prompt)
        [tool] = info.output_tools
        self.schemas.append(tool.parameters_json_schema)
        args = {'model': self.model, 'thinking': self.thinking, 'capabilities': list(self.capabilities)}
        confidence = self.confidence if self.confidence is not None else {'model': 0.9, 'thinking': 0.8}
        return ModelResponse(parts=[ToolCallPart(tool.name, args)], provider_details={'confidence': confidence})

    @property
    def model_(self) -> FunctionModel:
        return FunctionModel(self.respond, model_name='jev-test')


def child(name: str, seen: list[tuple[str, list[str]]]) -> FunctionModel:
    """A sub-agent model that answers with its name and records the prompt and tools it got."""

    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        part = messages[-1].parts[-1]
        assert isinstance(part, UserPromptPart)
        seen.append((str(part.content), sorted(tool.name for tool in info.function_tools)))
        return ModelResponse(parts=[TextPart(content=f'{name} answered')])

    return FunctionModel(respond, model_name=name)


def main_model(calls: list[str]) -> FunctionModel:
    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        calls.append('main')
        return ModelResponse(parts=[TextPart(content='main answered')])

    return FunctionModel(respond)


def composer(jev: Jev, seen: list[tuple[str, list[str]]], **kwargs: object) -> JevCapabilityComposer[object]:
    return JevCapabilityComposer(
        models={
            'fast': ModelOption(child('fast', seen), description='Quick answers'),
            'strong': ModelOption(child('strong', seen), description='Hard problems'),
        },
        catalog=CATALOG,
        jev_model=jev.model_,
        **kwargs,  # pyright: ignore[reportArgumentType]
    )


def recording_tracer() -> tuple[TracerProvider, InMemorySpanExporter]:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return provider, exporter


def compose_span(exporter: InMemorySpanExporter) -> ReadableSpan:
    [span] = [s for s in exporter.get_finished_spans() if s.name == 'jev_capability_composer compose']
    return span


class TestConfiguration:
    def test_requires_models(self):
        with pytest.raises(UserError, match='`models`'):
            JevCapabilityComposer(models={}, catalog=CATALOG)

    def test_requires_a_catalog(self):
        with pytest.raises(UserError, match='`catalog`'):
            JevCapabilityComposer(models={'fast': 'test'}, catalog={})

    @pytest.mark.parametrize('threshold', [-0.1, 1.1])
    def test_rejects_threshold_outside_unit_interval(self, threshold: float):
        with pytest.raises(UserError, match='between 0 and 1'):
            JevCapabilityComposer(models={'fast': 'test'}, catalog=CATALOG, confidence_threshold=threshold)

    def test_rejects_an_unsure_model_off_the_menu(self):
        with pytest.raises(UserError, match="unsure_model 'nope' is not a key"):
            JevCapabilityComposer(models={'fast': 'test'}, catalog=CATALOG, unsure_model='nope')

    def test_rejects_a_capability_that_cannot_load_from_a_spec(self):
        catalog = {'x': ComposableCapability(description='x', capability=Unloadable)}
        with pytest.raises(UserError, match="'x': Unloadable cannot be loaded from a spec"):
            JevCapabilityComposer(models={'fast': 'test'}, catalog=catalog)

    def test_not_spec_serializable(self):
        assert JevCapabilityComposer.get_serialization_name() is None

    def test_sits_innermost(self):
        assert JevCapabilityComposer(models={'fast': 'test'}).get_ordering() == CapabilityOrdering(position='innermost')

    def test_an_entry_is_described_by_its_capability_docstring(self):
        entry = ComposableCapability.of(Clock)

        assert entry == ComposableCapability(description='A second catalog capability.', capability=Clock)

    def test_an_entry_description_and_arguments_can_be_given(self):
        entry = ComposableCapability.of(Notes, description='Keep notes', arguments={'prefix': 'memo'})

        assert entry == CATALOG['notes']

    def test_an_entry_needs_a_description_from_somewhere(self):
        with pytest.raises(UserError, match='Unloadable has no docstring'):
            ComposableCapability.of(Unloadable)

    def test_the_default_catalog_builds(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        """Every default entry loads from a spec, so a composition of all of them is a working agent."""
        monkeypatch.chdir(tmp_path)
        (tmp_path / SKILLS_DIRECTORY).mkdir(parents=True)
        catalog = default_catalog()
        composer = JevCapabilityComposer(models={'fast': 'test'})

        built = composer.build_agent(
            Composition(model='fast', thinking=Thinking.low, capabilities=tuple(catalog), confidence={})
        )

        assert built.name == 'jev_capability_composer_sub_agent'
        assert 'skills' in catalog
        assert ('code_mode' in catalog) == (importlib.util.find_spec('pydantic_monty') is not None)
        assert ('web_fetch' in catalog) == (importlib.util.find_spec('markdownify') is not None)

    def test_the_default_catalog_leaves_out_what_is_not_available(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.chdir(tmp_path)
        find_spec = importlib.util.find_spec

        def without_extras(name: str, package: str | None = None) -> ModuleSpec | None:
            return None if name in ('pydantic_monty', 'ddgs', 'markdownify') else find_spec(name, package)

        monkeypatch.setattr(importlib.util, 'find_spec', without_extras)

        catalog = default_catalog()

        assert list(catalog) == ['filesystem', 'shell', 'planning', 'repo_context', 'pydantic_ai_docs', 'web_search']
        assert catalog['web_search'].arguments == {}

    async def test_default_entries_run_together(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        """No two local-tool entries register the same tool name. The web entries are native tools `TestModel` lacks."""
        monkeypatch.chdir(tmp_path)
        (tmp_path / SKILLS_DIRECTORY).mkdir(parents=True)
        local = tuple(key for key in default_catalog() if key not in ('web_search', 'web_fetch'))
        built = JevCapabilityComposer(models={'fast': 'test'}).build_agent(
            Composition(model='fast', thinking=Thinking.low, capabilities=local, confidence={})
        )

        result = await built.run('hi', model=TestModel(call_tools=[]))

        assert result.output == 'success (no tool calls)'


class TestSchema:
    async def test_every_option_is_described(self):
        """Jev reads each option's description from the schema, so none may go without one."""
        jev = Jev()
        await composer(jev, []).compose('commit this')

        assert jev.schemas == [
            {
                '$defs': {
                    'Thinking': {
                        'anyOf': [
                            {'const': 'low', 'description': 'Routine or single-step work'},
                            {'const': 'medium', 'description': 'Moderate multi-step work'},
                            {'const': 'high', 'description': 'Hard problems: debugging, design, or large changes'},
                        ],
                        'description': 'How much reasoning effort a request needs.',
                        'title': 'Thinking',
                        'type': 'string',
                    }
                },
                'properties': {
                    'model': {
                        'anyOf': [
                            {'const': 'fast', 'description': 'Quick answers'},
                            {'const': 'strong', 'description': 'Hard problems'},
                        ],
                        'description': 'Which model should handle this request?',
                        'type': 'string',
                    },
                    'thinking': {
                        '$ref': '#/$defs/Thinking',
                        'description': 'How much reasoning effort does this request need?',
                    },
                    'capabilities': {
                        'description': 'Does handling this request need this capability?',
                        'items': {
                            'anyOf': [
                                {'const': 'notes', 'description': 'Keep notes'},
                                {'const': 'clock', 'description': 'Tell the time'},
                            ],
                            'type': 'string',
                        },
                        'type': 'array',
                    },
                },
                'required': ['model', 'thinking', 'capabilities'],
                'title': 'Composition',
                'type': 'object',
            }
        ]

    async def test_a_model_without_a_description_is_described_by_its_name(self):
        jev = Jev(model='fast')
        await JevCapabilityComposer(models={'fast': 'test'}, catalog=CATALOG, jev_model=jev.model_).compose('hi')

        properties = jev.schemas[0]['properties']
        assert isinstance(properties, dict)
        assert properties['model'] == {
            'anyOf': [{'const': 'fast', 'description': 'test'}],
            'description': 'Which model should handle this request?',
            'type': 'string',
        }


class TestHandoff:
    async def test_the_composed_sub_agent_answers(self):
        seen: list[tuple[str, list[str]]] = []
        calls: list[str] = []
        jev = Jev(model='strong', capabilities=('notes',))
        agent = Agent(main_model(calls), capabilities=[composer(jev, seen)])

        result = await agent.run('write that down')

        assert result.output == 'strong answered'
        assert result.response.model_name == 'strong'
        assert calls == []
        assert jev.prompts == ['write that down']
        assert seen == [('write that down', ['memo_take'])]

    async def test_capabilities_are_built_in_catalog_order(self):
        seen: list[tuple[str, list[str]]] = []
        jev = Jev(capabilities=('clock', 'notes'))

        composition = await composer(jev, seen).compose('what time is it?')

        assert composition.capabilities == ('notes', 'clock')

    async def test_the_composition_event_is_emitted(self):
        streamed: list[AgentStreamEvent] = []

        async def handler(ctx: RunContext[object], stream: AsyncIterable[AgentStreamEvent]) -> None:
            async for event in stream:
                streamed.append(event)

        agent = Agent(main_model([]), capabilities=[composer(Jev(thinking='medium', capabilities=('clock',)), [])])

        await agent.run('what time is it?', event_stream_handler=handler)

        events = [e for e in streamed if isinstance(e, CapabilitiesComposedEvent)]
        assert [(e.model, e.thinking, e.capabilities, e.escalated) for e in events] == [
            ('strong', 'medium', ('clock',), False)
        ]

    async def test_usage_is_shared_with_the_parent_run(self):
        agent = Agent(main_model([]), capabilities=[composer(Jev(), [])])

        result = await agent.run('write that down')

        assert result.usage.requests == 3  # Jev, the sub-agent, and the parent's skipped request

    async def test_a_model_id_option_goes_into_the_spec(self):
        jev = Jev(model='fast', capabilities=('notes', 'clock'))
        agent = Agent(
            main_model([]),
            capabilities=[JevCapabilityComposer(models={'fast': 'test'}, catalog=CATALOG, jev_model=jev.model_)],
        )

        result = await agent.run('write that down')

        assert result.output == '{"memo_take":"noted","clock_now":"noon"}'

    async def test_the_sub_agent_carries_instructions_and_thinking(self):
        built = JevCapabilityComposer(models={'fast': 'test'}, catalog=CATALOG, instructions='Be brief.').build_agent(
            Composition(model='fast', thinking=Thinking.high, capabilities=('notes',), confidence={})
        )

        assert built.model_settings == {'thinking': 'high'}
        seen: list[str | None] = []

        def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
            seen.append(info.instructions)
            return ModelResponse(parts=[TextPart(content='ok')])

        await built.run('hi', model=FunctionModel(respond))
        assert seen == ['Be brief.']

    async def test_the_picked_thinking_reaches_a_model_that_supports_it(self):
        thinking: list[object] = []

        def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
            thinking.append(info.model_request_parameters.thinking)
            return ModelResponse(parts=[TextPart(content='thought')])

        thinker = FunctionModel(respond, profile=ModelProfile(supports_thinking=True))
        jev = Jev(model='deep', thinking='medium')
        agent = Agent(
            main_model([]),
            capabilities=[JevCapabilityComposer(models={'deep': thinker}, catalog=CATALOG, jev_model=jev.model_)],
        )

        await agent.run('write that down')

        assert thinking == ['medium']

    async def test_model_option_settings_override_the_picked_thinking(self):
        option = ModelOption('test', settings=ModelSettings(thinking='xhigh', temperature=0.2))
        built = JevCapabilityComposer(models={'deep': option}, catalog=CATALOG).build_agent(
            Composition(model='deep', thinking=Thinking.low, capabilities=('clock',), confidence={})
        )

        assert built.model_settings == {'thinking': 'xhigh', 'temperature': 0.2}

    async def test_a_picker_without_confidence_is_trusted(self):
        """A language model standing in for Jev reports no confidence, so its composition is used as given."""
        seen: list[tuple[str, list[str]]] = []

        def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
            [tool] = info.output_tools
            args = {'model': 'fast', 'thinking': 'low', 'capabilities': ['clock']}
            return ModelResponse(parts=[ToolCallPart(tool.name, args)])

        agent = Agent(
            main_model([]),
            capabilities=[
                JevCapabilityComposer(
                    models={'fast': child('fast', seen)}, catalog=CATALOG, jev_model=FunctionModel(respond)
                )
            ],
        )

        result = await agent.run('what time is it?')

        assert result.output == 'fast answered'

    async def test_text_parts_of_a_multimodal_prompt_are_composed_and_the_whole_prompt_is_handed_off(self):
        jev = Jev()
        seen: list[tuple[str, list[str]]] = []
        agent = Agent(main_model([]), capabilities=[composer(jev, seen)])

        await agent.run(['look at this', BinaryContent(data=b'png', media_type='image/png'), 'and that'])

        assert jev.prompts == ['look at this\nand that']
        assert len(seen) == 1 and 'BinaryContent' in seen[0][0]


class TestValidation:
    async def test_jev_can_only_answer_from_the_menu(self):
        """An off-menu model or capability fails output validation, so it can never be built."""
        with pytest.raises(UnexpectedModelBehavior):
            await composer(Jev(model='bogus'), []).compose('write that down')

        with pytest.raises(UnexpectedModelBehavior):
            await composer(Jev(capabilities=('bogus',)), []).compose('write that down')


class TestHistory:
    async def test_a_run_without_a_new_prompt_composes_from_the_latest_one_in_history(self):
        jev = Jev()
        seen: list[tuple[str, list[str]]] = []
        history: list[ModelMessage] = [
            ModelRequest(parts=[UserPromptPart(content='earlier')]),
            ModelResponse(parts=[TextPart(content='reply')]),
            ModelRequest(parts=[UserPromptPart(content='latest')]),
        ]
        agent = Agent(main_model([]), capabilities=[composer(jev, seen)])

        result = await agent.run(message_history=history)

        assert result.output == 'strong answered'
        assert jev.prompts == ['latest']


class TestEscalation:
    async def test_an_unsure_model_pick_runs_on_the_last_entry(self):
        """The capabilities Jev picked are kept; only the uncertain model pick is replaced."""
        calls: list[str] = []
        seen: list[tuple[str, list[str]]] = []
        jev = Jev(model='fast', capabilities=('notes',), confidence={'model': 0.3})
        agent = Agent(main_model(calls), capabilities=[composer(jev, seen)])

        result = await agent.run('write that down')

        assert result.output == 'strong answered'
        assert calls == []
        assert seen == [('write that down', ['memo_take'])]

    async def test_unsure_model_can_be_chosen(self):
        jev = Jev(model='strong', confidence={'model': 0.1})
        agent = Agent(main_model([]), capabilities=[composer(jev, [], unsure_model='fast')])

        result = await agent.run('write that down')

        assert result.output == 'fast answered'

    async def test_threshold_is_inclusive(self):
        agent = Agent(main_model([]), capabilities=[composer(Jev(model='fast', confidence={'model': 0.4}), [])])

        result = await agent.run('write that down')

        assert result.output == 'fast answered'

    async def test_the_event_says_it_escalated(self):
        streamed: list[AgentStreamEvent] = []

        async def handler(ctx: RunContext[object], stream: AsyncIterable[AgentStreamEvent]) -> None:
            async for event in stream:
                streamed.append(event)

        jev = Jev(model='fast', capabilities=('clock',), confidence={'model': 0.2})
        agent = Agent(main_model([]), capabilities=[composer(jev, [])])

        await agent.run('what time is it?', event_stream_handler=handler)

        events = [e for e in streamed if isinstance(e, CapabilitiesComposedEvent)]
        assert [(e.model, e.escalated) for e in events] == [('strong', True)]


class TestFallthrough:
    async def test_no_capabilities_falls_through(self):
        agent = Agent(main_model([]), capabilities=[composer(Jev(capabilities=()), [])])

        result = await agent.run('hi')

        assert result.output == 'main answered'

    async def test_composes_once_per_run(self):
        """Later requests in a fallen-through run (after a tool call) are not composed again."""
        jev = Jev(capabilities=())
        agent = Agent(TestModel(call_tools=['noop']), capabilities=[composer(jev, [])])

        @agent.tool_plain
        def noop() -> str:
            return 'ok'

        result = await agent.run('do something')

        assert result.output == '{"noop":"ok"}'
        assert jev.prompts == ['do something']

    async def test_a_prompt_without_text_is_not_composed(self):
        jev = Jev()
        agent = Agent(main_model([]), capabilities=[composer(jev, [])])

        result = await agent.run([BinaryContent(data=b'png', media_type='image/png')])

        assert result.output == 'main answered'
        assert jev.prompts == []


class TestDirect:
    """`before_model_request` paths that `Agent.run` does not reach."""

    @staticmethod
    def contexts(messages: list[ModelMessage], *, run_step: int = 1) -> tuple[RunContext[object], ModelRequestContext]:
        model = TestModel()
        run_ctx: RunContext[object] = RunContext(
            deps=None,
            model=model,
            usage=RunUsage(),
            prompt=None,
            messages=messages,
            run_step=run_step,
            tracer=NoOpTracer(),
        )
        req_ctx = ModelRequestContext(
            model=model, messages=messages, model_settings=None, model_request_parameters=ModelRequestParameters()
        )
        return run_ctx, req_ctx

    async def test_history_without_a_prompt_is_not_composed(self):
        jev = Jev()
        run_ctx, req_ctx = self.contexts([ModelResponse(parts=[TextPart(content='no prompt')])])

        assert await composer(jev, []).before_model_request(run_ctx, req_ctx) is req_ctx
        assert jev.prompts == []

    async def test_later_steps_pass_through(self):
        jev = Jev()
        run_ctx, req_ctx = self.contexts([ModelRequest(parts=[UserPromptPart(content='hi')])], run_step=2)

        assert await composer(jev, []).before_model_request(run_ctx, req_ctx) is req_ctx
        assert jev.prompts == []


class TestTracing:
    async def test_the_span_records_a_handoff(self):
        provider, exporter = recording_tracer()
        agent = Agent(main_model([]), capabilities=[composer(Jev(capabilities=('notes', 'clock')), [])])
        agent.instrument = InstrumentationSettings(tracer_provider=provider, include_content=False)

        await agent.run('write that down')

        assert dict(compose_span(exporter).attributes or {}) == {
            'jev_composer.model': 'strong',
            'jev_composer.thinking': 'high',
            'jev_composer.capabilities': ('notes', 'clock'),
            'jev_composer.action': 'handoff',
            'jev_composer.handoff_model': 'strong',
            'jev_composer.confidence.model': 0.9,
            'jev_composer.confidence.thinking': 0.8,
        }

    async def test_the_span_records_an_escalation(self):
        provider, exporter = recording_tracer()
        jev = Jev(model='fast', capabilities=('notes',), confidence={'model': 0.2})
        agent = Agent(main_model([]), capabilities=[composer(jev, [])])
        agent.instrument = InstrumentationSettings(tracer_provider=provider, include_content=False)

        await agent.run('write that down')

        attributes = dict(compose_span(exporter).attributes or {})
        assert attributes['jev_composer.action'] == 'escalate'
        assert attributes['jev_composer.model'] == 'fast'
        assert attributes['jev_composer.handoff_model'] == 'strong'

    async def test_the_span_records_a_fallthrough_and_the_prompt_when_allowed(self):
        provider, exporter = recording_tracer()
        agent = Agent(main_model([]), capabilities=[composer(Jev(capabilities=()), [])])
        agent.instrument = InstrumentationSettings(tracer_provider=provider, include_content=True)

        await agent.run('hi')

        attributes = dict(compose_span(exporter).attributes or {})
        assert attributes['jev_composer.action'] == 'fallthrough'
        assert 'jev_composer.handoff_model' not in attributes
        assert attributes['jev_composer.prompt'] == 'hi'
