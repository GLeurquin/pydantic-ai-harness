"""Jev capability composer: Jev picks a sub-agent's model, thinking effort, and capabilities, and the sub-agent takes the turn."""

from __future__ import annotations

import inspect
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Annotated, Literal, TypeAlias

from pydantic import BaseModel, Field, TypeAdapter
from pydantic_ai import Agent, CapabilityEvent, Choices, UseEnumMemberDocstrings
from pydantic_ai.agent.spec import AgentSpec, CapabilitySpec
from pydantic_ai.capabilities import AbstractCapability, CapabilityOrdering, WebSearch
from pydantic_ai.exceptions import SkipModelRequest, UserError
from pydantic_ai.messages import ModelResponse, TextPart, UserContent
from pydantic_ai.models import KnownModelName, Model
from pydantic_ai.tools import AgentDepsT, RunContext

from pydantic_ai_harness.filesystem import FileSystem
from pydantic_ai_harness.planning import Planning
from pydantic_ai_harness.pydantic_ai_docs import PydanticAIDocs
from pydantic_ai_harness.shell import Shell
from pydantic_ai_harness.subagents import ModelOption
from pydantic_ai_harness.subagents._models import as_option, model_label

if TYPE_CHECKING:
    from opentelemetry.trace import Span
    from pydantic_ai.models import ModelRequestContext

_NAME = 'jev_capability_composer'


class Thinking(UseEnumMemberDocstrings, str, Enum):
    """How much reasoning effort a request needs."""

    # Jev reads these docstrings as each option's meaning. `low` is the sub-agents capability's effort floor.

    low = 'low'
    """Routine or single-step work"""
    medium = 'medium'
    """Moderate multi-step work"""
    high = 'high'
    """Hard problems: debugging, design, or large changes"""


FallthroughReason: TypeAlias = Literal['low_confidence', 'no_capabilities']
"""Why a composition was not handed the turn: Jev was unsure of the model, or picked no capabilities."""


@dataclass(frozen=True, kw_only=True)
class ComposableCapability:
    """One catalog entry: a spec-loadable capability class, and when a sub-agent needs it."""

    description: str
    """What the capability lets the sub-agent do. Jev reads it to decide whether a request needs it."""

    capability: type[AbstractCapability[object]]
    """The capability class. It must have a spec serialization name (most harness capabilities do)."""

    arguments: Mapping[str, object] = field(default_factory=dict[str, object])
    """Keyword arguments the capability is built with, as in an `AgentSpec` entry."""

    @classmethod
    def of(
        cls,
        capability: type[AbstractCapability[object]],
        *,
        description: str | None = None,
        arguments: Mapping[str, object] | None = None,
    ) -> ComposableCapability:
        """A catalog entry described by the first line of `capability`'s docstring unless `description` is given.

        A docstring says what a capability is; Jev decides best from what a request needs it for, so a
        description written for that tends to route better.
        """
        doc = inspect.getdoc(capability) or ''
        if doc.startswith(f'{capability.__name__}('):
            doc = ''  # the signature `dataclass` writes for a class without a docstring
        summary = description or next(iter(doc.splitlines()), '')
        if not summary:
            raise UserError(f'{capability.__name__} has no docstring to describe it; pass `description=`.')
        return cls(description=summary, capability=capability, arguments=dict(arguments or {}))


DEFAULT_CATALOG: Mapping[str, ComposableCapability] = {
    'filesystem': ComposableCapability(
        description='Read, search, and edit files in the working directory', capability=FileSystem
    ),
    'shell': ComposableCapability(
        description='Run shell commands such as git, tests, linters, or build tools', capability=Shell
    ),
    'planning': ComposableCapability(description='Track a multi-step plan across a long task', capability=Planning),
    'pydantic_ai_docs': ComposableCapability(
        description='Look up Pydantic AI documentation', capability=PydanticAIDocs
    ),
    'web_search': ComposableCapability(
        description='Search the public web for current information', capability=WebSearch
    ),
}
"""The allowlist `JevCapabilityComposer` picks from by default.

Every entry builds with no arguments and needs no third-party API key. A capability that builds without
arguments but calls a paid service (`ExaSearch`, `YouSearch`, `ModalSandbox`) stays out until you add it.
"""


@dataclass(frozen=True, kw_only=True)
class Composition:
    """What Jev picked for one prompt."""

    model: str
    """The key of the chosen `models` entry."""

    thinking: Thinking
    capabilities: tuple[str, ...]
    """Keys of the chosen catalog entries, in catalog order."""

    confidence: Mapping[str, float]
    """Jev's confidence per field (`model`, `thinking`, `capabilities`), from 0 to 1."""


@dataclass(kw_only=True)
class CapabilitiesComposedEvent(CapabilityEvent, namespace='jev', name='capabilities_composed'):
    """A composed sub-agent is about to take the turn."""

    model: str
    thinking: Thinking
    capabilities: tuple[str, ...]


class _Picks(BaseModel):
    """The fields Jev fills. `_picks_type` narrows `model` and `capabilities` to one composer's options."""

    model: str
    thinking: Thinking
    capabilities: list[str]


def _picks_type(models: Mapping[str, str], catalog: Mapping[str, str]) -> type[_Picks]:
    """The output type for one model menu and catalog, each option described by its `Choices` entry."""
    model_key = Choices(models, name='ModelPick')
    capability_key = Choices(catalog, name='Capability')

    class Composition(_Picks):
        """Compose an agent to handle this request: its model, reasoning effort, and capabilities."""

        model: Annotated[str, model_key] = Field(description='Which model should handle this request?')
        thinking: Thinking = Field(description='How much reasoning effort does this request need?')
        capabilities: list[Annotated[str, capability_key]] = Field(
            description='Does handling this request need this capability?'
        )

    return Composition


_CONFIDENCE = TypeAdapter(dict[str, float])


@dataclass
class JevCapabilityComposer(AbstractCapability[AgentDepsT]):
    """Compose a sub-agent for each prompt with [Jev](https://typesafe.ai) and hand it the turn.

    One Jev request picks a model from `models`, a thinking effort, and the capabilities from `catalog`
    the prompt needs. The composer builds that sub-agent from an `AgentSpec`, runs it on the prompt, and
    returns its answer without calling the main model. When Jev is unsure of the model, or picks no
    capabilities, the main model handles the prompt as usual.

    ```python
    from pydantic_ai import Agent
    from pydantic_ai_harness.jev import JevCapabilityComposer

    agent = Agent(
        'openai-codex:gpt-6-sol',
        capabilities=[
            JevCapabilityComposer(
                models={
                    'fast': 'openai-codex:gpt-6-luna',
                    'medium': 'openai-codex:gpt-6-sol',
                    'max': 'openai-codex:gpt-6-astra',
                },
            )
        ],
    )
    ```

    Jev runs through Pydantic AI's `TypeSafeModel`, which reads `TYPESAFE_API_KEY`.
    """

    models: Mapping[str, Model | KnownModelName | str | ModelOption]
    """The model menu Jev picks from. A `ModelOption.description` tells Jev what the entry is for, and
    `ModelOption.settings` apply to the sub-agent, overriding the thinking effort Jev picked."""

    catalog: Mapping[str, ComposableCapability] = field(default_factory=lambda: dict(DEFAULT_CATALOG))
    """The capabilities Jev picks from. Defaults to `DEFAULT_CATALOG`, an allowlist that needs no API keys."""

    instructions: str | None = None
    """Instructions for the composed sub-agent. The main agent's instructions are not passed on."""

    confidence_threshold: float = 0.5
    """Minimum Jev confidence in the model pick to hand off. A picker that reports no confidence is trusted."""

    jev_model: Model | str = 'typesafe:jev-latest'
    """The model that composes. Pin a version (`typesafe:jev-1.13.0`) once the threshold is tuned."""

    _options: dict[str, ModelOption] = field(init=False, repr=False, compare=False)
    _picker: Agent[None, _Picks] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        if not self.models:
            raise UserError('JevCapabilityComposer needs at least one entry in `models`.')
        if not self.catalog:
            raise UserError('JevCapabilityComposer needs at least one entry in `catalog`.')
        if not 0.0 <= self.confidence_threshold <= 1.0:
            raise UserError(f'confidence_threshold must be between 0 and 1, got {self.confidence_threshold}.')
        for key, entry in self.catalog.items():
            if entry.capability.get_serialization_name() is None:
                raise UserError(f'Catalog entry {key!r}: {entry.capability.__name__} cannot be loaded from a spec.')
        self._options = {key: as_option(value) for key, value in self.models.items()}
        self._picker = Agent(
            self.jev_model,
            name=_NAME,
            output_type=_picks_type(
                {key: option.description or model_label(option.model) for key, option in self._options.items()},
                {key: entry.description for key, entry in self.catalog.items()},
            ),
            defer_model_check=True,
        )

    @classmethod
    def get_serialization_name(cls) -> str | None:
        """Not spec-serializable: the catalog holds classes and the model menu may hold `Model` instances."""
        return None

    def get_ordering(self) -> CapabilityOrdering:
        """Sit innermost so prompt-rewriting capabilities run first and Jev reads the final prompt."""
        return CapabilityOrdering(position='innermost')

    async def before_model_request(
        self,
        ctx: RunContext[AgentDepsT],
        request_context: ModelRequestContext,
    ) -> ModelRequestContext:
        """On the first request, compose a sub-agent and hand it the turn, or fall through."""
        if ctx.run_step != 1:
            return request_context
        # `Agent.run` sets `prompt` from the latest user prompt, including one in `message_history`.
        prompt = ctx.prompt
        text = _text_of(prompt) if prompt is not None else None
        if prompt is None or text is None:
            return request_context

        with ctx.tracer.start_as_current_span(f'{_NAME} compose') as span:
            composition = await self.compose(text, usage_ctx=ctx)
            reason = self._fallthrough_reason(composition)
            _record(span, ctx, text, composition, reason)
        if reason is not None:
            return request_context

        await ctx.emit(
            CapabilitiesComposedEvent(
                model=composition.model, thinking=composition.thinking, capabilities=composition.capabilities
            )
        )
        result = await self.build_agent(composition).run(prompt, deps=ctx.deps, usage=ctx.usage)
        raise SkipModelRequest(ModelResponse(parts=[TextPart(content=result.output)]))

    async def compose(self, prompt: str, *, usage_ctx: RunContext[AgentDepsT] | None = None) -> Composition:
        """Ask Jev what sub-agent `prompt` needs. Usage is added to `usage_ctx`'s run when given."""
        result = await self._picker.run(prompt, usage=usage_ctx.usage if usage_ctx is not None else None)
        picks = result.output
        details = result.response.provider_details or {}
        return Composition(
            model=picks.model,
            thinking=picks.thinking,
            capabilities=tuple(key for key in self.catalog if key in picks.capabilities),
            confidence=_CONFIDENCE.validate_python(details.get('confidence', {})),
        )

    def build_agent(self, composition: Composition) -> Agent[AgentDepsT, str]:
        """Build the sub-agent `composition` describes, from an `AgentSpec`."""
        option = self._options[composition.model]
        entries = [self.catalog[key] for key in composition.capabilities]
        spec = AgentSpec(
            model=option.model if isinstance(option.model, str) else None,
            instructions=self.instructions,
            model_settings={'thinking': composition.thinking.value, **(option.settings or {})},
            capabilities=[_spec_entry(entry) for entry in entries],
        )
        return Agent.from_spec(
            spec,
            model=option.model if isinstance(option.model, Model) else None,
            name=f'{_NAME}_sub_agent',
            custom_capability_types=[entry.capability for entry in entries],
        )

    def _fallthrough_reason(self, composition: Composition) -> FallthroughReason | None:
        if composition.confidence.get('model', 1.0) < self.confidence_threshold:
            return 'low_confidence'
        if not composition.capabilities:
            return 'no_capabilities'
        return None


def _spec_entry(entry: ComposableCapability) -> CapabilitySpec:
    name = entry.capability.get_serialization_name()
    assert name is not None  # checked in `JevCapabilityComposer.__post_init__`
    return CapabilitySpec(name=name, arguments=dict(entry.arguments) or None)


def _text_of(prompt: str | Sequence[UserContent]) -> str | None:
    """The prompt's text parts, which are all Jev reads; `None` when there are none."""
    if isinstance(prompt, str):
        return prompt
    texts = [item for item in prompt if isinstance(item, str)]
    return '\n'.join(texts) if texts else None


def _record(
    span: Span, ctx: RunContext[AgentDepsT], prompt: str, composition: Composition, reason: FallthroughReason | None
) -> None:
    if not span.is_recording():
        return
    span.set_attributes(
        {
            'jev_composer.model': composition.model,
            'jev_composer.thinking': composition.thinking.value,
            'jev_composer.capabilities': list(composition.capabilities),
            'jev_composer.action': 'fallthrough' if reason is not None else 'handoff',
            **{f'jev_composer.confidence.{key}': value for key, value in composition.confidence.items()},
        }
    )
    if reason is not None:
        span.set_attribute('jev_composer.fallthrough_reason', reason)
    if ctx.trace_include_content:
        span.set_attribute('jev_composer.prompt', prompt)
