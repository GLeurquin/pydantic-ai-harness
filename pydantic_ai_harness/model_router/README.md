# Model Router

Select a model from a described menu when the best candidate depends on the conversation. `ModelRouter` asks a separate model for a typed choice and confidence, then uses a declared default when routing fails or confidence is too low.

[Source](https://github.com/pydantic/pydantic-ai-harness/tree/main/pydantic_ai_harness/model_router/)

> While Pydantic AI Harness is on 0.x releases, the API may change between minor releases; when it does, deprecation warnings and release-note migration guidance tell you (or your agent) exactly how to upgrade. See the [version policy](../../docs/index.md#version-policy).

## Usage

No extra dependencies are required beyond the provider packages for your models.

```python
from pydantic_ai import Agent

from pydantic_ai_harness.model_router import ModelChoice, ModelRouter

agent = Agent(
    capabilities=[
        ModelRouter(
            model='anthropic:claude-haiku-4-5',
            choices={
                'fast': ModelChoice(
                    model='anthropic:claude-haiku-4-5',
                    description='Short factual questions and routine transformations.',
                ),
                'reasoning': ModelChoice(
                    model='anthropic:claude-sonnet-5',
                    description='Multi-step reasoning, debugging, and complex code changes.',
                ),
            },
            default='fast',
            min_confidence=0.7,
            scope='run',
        ),
    ],
)
```

The routing model receives descriptions, not candidate model IDs. Its structured output has a `choice` constrained to a `Literal` of your keys and a required `confidence` between zero and one. Confidence is self-reported, not a calibrated probability. Models must support Pydantic AI structured output.

## Decisions and fallback

- `scope='run'` (default) caches the first decision for that run, including fallback decisions. Separate and concurrent runs do not share decisions.
- `scope='step'` selects once per logical model request step. Core owns step boundaries and transport retries; the capability does not add a request loop.
- `min_confidence` defaults to `0.0`. A score below the threshold selects `default`; a score equal to it is accepted.
- Provider failures, exhausted output-validation retries, and other routing exceptions select `default`. Usage-limit failures, cancellation, and process-control exceptions propagate.
- Failure of the selected model is not a routing failure and is not retried with `default`. Use core's `FallbackModel` inside a `ModelChoice` for provider fallback.

## Cost and data routing

Each uncached decision adds an internal agent run and its model requests, latency, and token cost. Output-validation retries can make more than one request per decision. Router requests and tokens share the parent run's usage and limits, including output-validation retries. Exhausting a limit stops the run rather than selecting the default. The internal agent is named `model_router` so global Pydantic AI instrumentation attributes its requests and spend separately.

The router receives core's model-selection history, plus the current user prompt on the first step. Core excludes the pending request: on later steps, the newest tool results, retry feedback, and queued messages are not yet visible to the router. Routing is therefore based on the preceding conversation, not the exact payload about to reach the selected model. This can include system messages, tool arguments and results, image URLs, or encoded binary content. These are sent as JSON text, not as native multimodal inputs. The router does not receive dependencies or tool definitions. Prior requests can include the outer agent's rendered instructions, including separately configured instructions; those are forwarded with the history on later steps or resumed runs. The current request's instructions are not resolved before selection. Choose a routing provider authorized to receive that data, not just the providers for the candidates. Prompt injection can influence the selection; descriptions and confidence are not authorization controls.

## Model precedence

`ModelRouter` uses core's `AbstractCapability.get_model()` hook. An explicit run model or `Agent.override(model=...)` takes precedence and makes no routing call. Otherwise, the last capability contributing a model wins, ahead of the agent's default model. Two routers remain separate capabilities; only the last model contribution routes.

The declared default provides core's bootstrap model before run-local state exists; it is resolved and entered even when routing ultimately chooses another candidate. Configure its provider credentials and resources accordingly. Each run starts with a fresh cache, including a run continued from message history. Core's restrictions on resuming deferred calls with dynamic model selectors still apply.

## Durable execution

Routing decisions and the internal agent are not checkpointed. Runs inside core durability workflows or flows are rejected before model calls rather than repeating router spend on replay. Ordinary runs of durability-capable agents outside those containers remain supported. Persisted message history does not persist a routing decision. Construct `ModelRouter` in Python; spec-based construction is not supported.

## Telemetry

Each uncached decision emits `model_router.select` on `RunContext.tracer`. Attributes are `model_router.choice` (the effective key), `model_router.confidence` (only when a valid result exists), `model_router.reason` (`selected`, `low_confidence`, or `router_error`), `model_router.scope`, and `model_router.step`. Choice keys are operational labels and should not contain user or tenant data. Prompts, descriptions, model output text, and exception messages are not added to this span. Cached decisions emit no new span.

Per-agent instrumentation on the outer agent covers the selection span. Use `Agent.instrument_all()` to also instrument the internal agent. Core controls content capture for those model-request spans separately.
