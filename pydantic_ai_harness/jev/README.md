# Jev Capability Composer

> [!NOTE]
> Nothing here is re-exported at the top level -- import from the submodule:
>
> ```python
> from pydantic_ai_harness.jev import JevCapabilityComposer
> ```
>
> While Pydantic AI Harness is on 0.x releases, the API may change between minor releases; when it does, deprecation warnings and release-note migration guidance tell you (or your agent) exactly how to upgrade. See the [version policy](https://github.com/pydantic/pydantic-ai-harness#version-policy).

Build a sub-agent for each prompt from a fixed allowlist, with [Jev](https://typesafe.ai) choosing its model, thinking effort, and capabilities, and hand it the turn.

[Source](https://github.com/pydantic/pydantic-ai-harness/tree/main/pydantic_ai_harness/jev/)

## The problem

A general-purpose agent carries every tool and runs on one model for every request. "Commit this" pays for the same frontier model, the same thinking budget, and the same thirty tool definitions as "redesign the auth layer". Asking a language model to size the request first costs about as much as the request itself.

## The solution

`JevCapabilityComposer` asks [Jev](https://pydantic.dev/docs/ai/models/typesafe/) once, before the first model request of a run. Jev is a classifier rather than a language model: it answers typed questions with a confidence, in a few hundred milliseconds. One request asks three things:

- **model**: which entry of your `models` menu should handle the request
- **thinking**: `low`, `medium`, or `high` reasoning effort
- **capabilities**: for each entry of the catalog, whether the request needs it

The composer builds that sub-agent from an `AgentSpec`, runs it on the prompt, and returns its answer as the turn's response. The main model is not called. When Jev's confidence in the model pick is below `confidence_threshold`, the sub-agent still gets the capabilities Jev picked, but runs on `unsure_model`: the last entry of `models` unless you name one, so order the menu from cheapest to strongest. An unsure pick then costs a stronger model rather than a wrong one, or the tools. When Jev picks no capabilities, the composer does nothing and the main agent handles the prompt as usual. The default threshold of 0.4 comes from a hand-labelled check of the example menu below, where every wrong model pick scored 0.33 or less and nearly every right one 0.56 or more. Recalibrate it for your own menu.

```python
from pydantic_ai import Agent
from pydantic_ai_harness.jev import JevCapabilityComposer
from pydantic_ai_harness.subagents import ModelOption

agent = Agent(
    'openai-codex:gpt-6-sol',
    capabilities=[
        JevCapabilityComposer(
            models={
                'fast': ModelOption('openai-codex:gpt-6-luna', description='Answering a question, or one command or trivial edit that needs no investigation'),
                'medium': ModelOption('openai-codex:gpt-6-sol', description='A focused code change with a clear cause or spec, in one or a few files'),
                'max': ModelOption('openai-codex:gpt-6-astra', description='Open-ended work: an unknown root cause, a design decision, or changes across many files'),
            },
        )
    ],
)

result = agent.run_sync('commit this with a sensible message')
print(result.output)
```

Jev runs through Pydantic AI's `TypeSafeModel`. Install `pydantic-ai-harness[jev]`, which brings in `pydantic-ai-slim[typesafe]`, and set `TYPESAFE_API_KEY`; see [TypeSafe (Jev)](https://pydantic.dev/docs/ai/models/typesafe/). To use another picker, pass `jev_model=` any model that can fill a structured output. A picker that reports no confidence is trusted as given.

## What Jev is asked

The questions are an ordinary output type. The composer builds one per model menu and catalog, using Pydantic AI's `Choices` for the options only known at construction and a `Thinking` enum with a docstring per member:

```python {test="skip" lint="skip"}
class Composition(BaseModel):
    """Compose an agent to handle this request: its model, reasoning effort, and capabilities."""

    model: Annotated[str, Choices({'fast': 'Quick answers ...', 'medium': 'Everyday coding ...', 'max': 'Hard reasoning ...'})] = Field(
        description='Which model should handle this request?'
    )
    thinking: Thinking = Field(description='How much reasoning effort does this request need?')
    capabilities: list[Annotated[str, Choices({'filesystem': 'Read, search, and edit files ...', ...})]] = Field(
        description='Does handling this request need this capability?'
    )
```

`TypeSafeModel` asks the two pick-one fields as Choice questions and fans the list out into one yes/no per catalog entry, all in a single request. Jev can only answer with an option it was offered, so there is no invented model or capability to reject.

The descriptions are what Jev decides from. Give each `ModelOption` a `description` that says what kind of request it is for; without one, Jev sees only the model name. Describe a tier by the work a request takes (whether it needs investigation first, how far the change reaches) rather than by how capable the model is: Jev tells the tiers apart with more confidence that way, so fewer prompts escalate to the strongest model.

## The catalog is an allowlist

`catalog` maps a key to a `ComposableCapability`: a spec-loadable capability class, the arguments to build it with, and a description Jev reads. Only catalog entries can end up on a sub-agent.

When no `catalog` is given, the composer calls `default_catalog()` as it is constructed. Every entry needs no third-party API key, and the ones that need configuration take a default:

| Key | Capability | Configured with | Included when |
|---|---|---|---|
| `filesystem` | [FileSystem](../filesystem/) | defaults | always |
| `shell` | [Shell](../shell/) | defaults | always |
| `planning` | [Planning](../planning/) | defaults | always |
| `repo_context` | [Repo Context](../repo_context/) | the working directory | always |
| `pydantic_ai_docs` | [Pydantic AI Docs](../pydantic_ai_docs/) | defaults | always |
| `web_search` | Pydantic AI's `WebSearch` | DuckDuckGo fallback when the `duckduckgo` extra is installed | always |
| `skills` | [Skills](../skills/) | `SKILLS_DIRECTORY` (`.agents/skills`) | that directory exists |
| `code_mode` | [Code Mode](../code_mode/) | defaults | the `code-mode` extra is installed |
| `web_fetch` | Pydantic AI's `WebFetch` | local fetcher fallback | the `web-fetch` extra is installed |

Both web entries use the model's native tool when it has one. `web_fetch` is only offered with its local fallback, because native URL fetching is missing on common models, OpenAI's among them. Without the `duckduckgo` extra, `web_search` is native only, and a sub-agent whose model has no native web search raises `UserError` when it runs. The `jev` extra installs both web extras.

Some capabilities are left out on purpose:

- **Need a key or an external service**: `ExaSearch`, `YouSearch`, `ModalSandbox`, `BrowserUse`, `LocalStack`, `Macroscope`. They build without arguments, then call a paid service or need a CLI or container.
- **No default could be right**: `Advisor` needs a model, `AskUser` an answerer, `ConversationSearch` a history source, and `Memory`'s persistent stores are objects, so a sub-agent built per prompt would get an empty in-memory store.
- **Cannot be loaded from a spec**: `Coder` and `Researcher` are not dataclasses, and `SubAgents` has no serialization name.
- **Shape the run, not the task**: compaction, spend limits, persistence, and guardrails belong on the main agent, not in a per-prompt pick.

Add any of them yourself. `ComposableCapability.of` describes an entry from the first line of the capability's docstring unless you pass `description=`:

```python
from pydantic_ai_harness.exa import ExaSearch
from pydantic_ai_harness.jev import ComposableCapability, JevCapabilityComposer, default_catalog

composer = JevCapabilityComposer(
    models={'fast': 'openai-codex:gpt-6-luna'},
    catalog={
        **default_catalog(),
        'exa': ComposableCapability.of(ExaSearch, description='Research a topic across many web sources'),
    },
)
```

A docstring says what a capability is. Jev decides better from what a request would need it for, which is why the default entries carry descriptions written for that.

## Models and thinking

`models` takes the same entries as the [sub-agents](../subagents/) model menu: a model ID, a `Model`, or a `ModelOption`. The picked effort goes on the sub-agent as `ModelSettings(thinking=...)`, and a `ModelOption.settings` overrides it, so an entry that must always think hard can say so. A model whose profile does not support thinking ignores the setting.

## What the sub-agent sees

- The current prompt, including non-text parts. Jev reads only the text parts; a prompt with no text is not composed.
- The composer's `instructions`, not the main agent's.
- The parent run's `deps` and usage, so the sub-agent's requests count against the run's usage limits.

It does not see earlier messages in the conversation. The composer decides on the first model request of each run; later requests in the same run, after a fall-through, go to the main model.

## Telemetry

Each decision is a `jev_capability_composer compose` span on the run's tracer, with:

| Attribute | Value |
|---|---|
| `jev_composer.model`, `jev_composer.thinking`, `jev_composer.capabilities` | what Jev picked |
| `jev_composer.confidence.<field>` | Jev's confidence per field |
| `jev_composer.action` | `handoff`, `escalate` (unsure of the model, ran on `unsure_model`), or `fallthrough` (no capabilities picked) |
| `jev_composer.handoff_model` | the `models` key the sub-agent ran on, unless it fell through |
| `jev_composer.prompt` | the text Jev read, only when the run includes content in traces |

Jev's request and the sub-agent's run appear as their own agent spans under it. On a handoff or an escalation the composer also emits a `CapabilitiesComposedEvent` into the run's event stream, before the sub-agent starts; its `escalated` field says which.

Watch the escalation and fall-through rates as well as the picks. A composer that escalates on most prompts is running everything on the strongest model and saving nothing, and one that falls through on most is costing a Jev request per run and changing nothing; tune `confidence_threshold` and the descriptions against labelled prompts of your own, then pin the Jev version you tuned against with `jev_model='typesafe:jev-1.13.0'`.
