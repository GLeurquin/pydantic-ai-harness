# Tool Call Judge

Use a separate model to approve or deny selected tool calls before their bodies run, while leaving uncertain calls available for a person to decide.

> While Pydantic AI Harness is on 0.x releases, the API may change between minor releases; when it does, deprecation warnings and release-note migration guidance tell you (or your agent) exactly how to upgrade. See the [version policy](../docs/index.md#version-policy).

[Source](https://github.com/pydantic/pydantic-ai-harness/tree/main/pydantic_ai_harness/tool_call_judge/)

## Usage

Mark each tool with `requires_approval=True`, then name it in `tools`. The judge's `question` is a risk question: a `yes` answer denies the call, a `no` answer approves it, and `unsure` follows `on_uncertain`.

For the models in this example, install their provider extras and set their API keys:

```bash
pip/uv-add pydantic-ai-harness "pydantic-ai-slim[openai,typesafe]"
```

```bash
export TYPESAFE_API_KEY='your-typesafe-api-key'
export OPENAI_API_KEY='your-openai-api-key'
```

```python
from pydantic_ai import Agent
from pydantic_ai_harness.tool_call_judge import ToolCallJudge

judge = ToolCallJudge(
    'typesafe:jev-latest',
    tools=['delete_file'],
    question='Would running this destroy data, spend money, or leak secrets?',
)
agent = Agent('openai:gpt-5.6-sol', capabilities=[judge])


@agent.tool_plain(requires_approval=True)
def delete_file(path: str) -> str:
    # Keep the example non-destructive. A real tool would enforce its own controls here.
    return f'Deletion requested for {path}'


result = agent.run_sync('Delete ./old-report.txt')
print(result.output)
```

The judging model returns only the typed literal `yes`, `no`, or `unsure`, not a free-text explanation. This keeps the response contract small and allows models that produce typed output without producing text. With TypeSafe, the configured question is in the internal agent's instructions, which Jev uses as the question for that literal output. Jev's response confidence is read from provider metadata rather than generated as another output field.

## Fail-closed behavior

`on_uncertain='deny'` is the default. It applies when the model answers `unsure`, raises an error, exceeds a usage limit, or returns output that fails validation. The call does not run; the agent receives `denial_message` as a denied tool result.

Set `on_uncertain='defer'` to leave those approval requests unresolved:

```python
from pydantic_ai_harness.tool_call_judge import ToolCallJudge

judge = ToolCallJudge(
    'typesafe:jev-latest',
    tools=['delete_file'],
    question='Would this destroy data?',
    on_uncertain='defer',
)
```

An unresolved request goes to the next capability that handles deferred tool calls. If none resolves it, it reaches the caller in the run's [`DeferredToolRequests`](/ai/tools-toolsets/deferred-tools/) output, where a person can approve or deny it. Include `DeferredToolRequests` in the agent's output type when unresolved calls may reach the caller.

`deny` is the safer default because a broken or unavailable judge cannot cause the tool to execute. `defer` is useful when an operator is available and availability matters more than completing the run without intervention.

## Scope and composition

`tools` is required and must contain at least one name. `ToolCallJudge` considers only approval requests for those exact names. It does not start judging every deferred request on an agent, and it does not resolve external tool calls.

Several judges can coexist with separate tool scopes or questions. Deferred-call handlers run in capability order and each receives only unresolved requests, so the first judge whose scope includes a call resolves it unless it returns `defer`. Put overlapping policies in the order you want them applied.

Tools still need to enter Pydantic AI's approval flow. `ToolCallJudge` does not change ordinary tools into approval-required tools; use `requires_approval=True`, an [`ApprovalRequiredToolset`](/ai/tools-toolsets/toolsets/#requiring-tool-approval), or raise `ApprovalRequired` from validation or execution.

## What the judge sees

Each judgement is a fresh internal-agent run. Its model input consists of:

- fixed judge instructions, including the configured risk question
- a user prompt containing the tool name and validated tool arguments as JSON

The outer agent's conversation history, system prompt, tool results, and deferred-call metadata are not forwarded. The judge does receive its own fixed instructions. This keeps the request bounded and avoids sending the whole history to another model. It also reduces a prompt-injection surface: the conversation can contain instructions written by pages, files, and other content the agent read. Tool arguments remain untrusted and can themselves contain instructions, so the judge instructions label the payload as data. This is a reduction, not an elimination, of prompt-injection risk.

The trade-off is deliberate. A question that needs user identity, earlier approvals, or other conversation state cannot be answered from the tool call alone. Use another deferred-call handler for policy that needs that context.

## Observability

Every selected approval request creates a `judge tool call` span on the active `RunContext` tracer. It carries:

| Attribute | Value |
|---|---|
| `tool_call_judge.tool` | tool name |
| `tool_call_judge.tool_call_id` | call identifier |
| `tool_call_judge.model_result` | `yes`, `no`, `unsure`, or `error` |
| `tool_call_judge.verdict` | `approve`, `deny`, or `defer` |
| `tool_call_judge.confidence` | single-answer confidence from provider metadata, when present |
| `tool_call_judge.error.type` | exception type when the judge failed |
| `tool_call_judge.arguments` | JSON arguments, only when `trace_include_content` is enabled |

Pass `on_verdict` to observe the same effective verdict in application code or tests:

```python
from pydantic_ai_harness.tool_call_judge import ToolCallJudge, ToolCallVerdict

verdicts: list[ToolCallVerdict] = []
judge = ToolCallJudge(
    'typesafe:jev-latest',
    tools=['delete_file'],
    question='Would this destroy data?',
    on_verdict=verdicts.append,
)
```

The internal agent is named `tool_call_judge`, so its model spend is grouped under that name in Logfire. Its usage is added to the outer run's usage and respects the outer run's usage limits.

## Safety boundary

A judgement cheap enough to run on every call is exactly why it must not be the only thing between an agent and an irreversible action. `ToolCallJudge` is a filter, not a security boundary. Enforce authentication, authorization, argument validation, least privilege, and recovery controls inside or below the tool for actions that destroy data, spend money, expose secrets, or cannot be undone.

Unlike [`OutputGuardrail`](guardrails.md), this capability does not inspect or replace the agent's final output. It resolves validated approval requests before tool execution through Pydantic AI's deferred-tool flow. Making it an output guard would put the decision after the wrong model output and would not provide an approval result that the tool execution pipeline can apply.

## Agent specs

`ToolCallJudge` publishes an agent-spec schema for string model identifiers, tool names, the question, uncertainty policy, denial message, and the standard capability fields (`id`, `description`, and `defer_loading`). A live `Model` object and `on_verdict` callback are code-only options and are not part of that schema.

## API reference

::: pydantic_ai_harness.tool_call_judge.ToolCallJudge

::: pydantic_ai_harness.tool_call_judge.ToolCallVerdict
