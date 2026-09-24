# Slack

Give an agent Slack messages, channels, and canvas tools. `Slack` connects an agent to the provider's hosted MCP server. By default it exposes the tools the server offers, including write tools. Provider credentials and server settings determine what those tools may access.

> While Pydantic AI Harness is on 0.x releases, the API may change between minor releases; when it does, deprecation warnings and release-note migration guidance tell you (or your agent) exactly how to upgrade. See the [version policy](https://github.com/pydantic/pydantic-ai-harness#version-policy).

## Install and connect

uv:

```bash
uv add "pydantic-ai-harness[slack]" "pydantic-ai-slim[openai]"
```

pip:

```bash
pip install "pydantic-ai-harness[slack]" "pydantic-ai-slim[openai]"
```

Set `SLACK_USER_TOKEN` to a Slack user token, or pass `auth=...`. `auth` accepts an `httpx.Auth` for caller-managed authentication, or a callable that returns a token for each run (see [Per-user credentials](#per-user-credentials)). See the [provider setup](https://docs.slack.dev/ai/slack-mcp-server/).

```python
from pydantic_ai import Agent
from pydantic_ai_harness.slack import Slack

agent = Agent('openai:gpt-5.6-sol', capabilities=[Slack()])
result = agent.run_sync('Summarize the resources I can access')
print(result.output)
```

## Per-user credentials

A fixed `auth` and `SLACK_USER_TOKEN` give every run the same connection and the same Slack user. Use them for scripts, local tools, and single-user agents.

When one agent serves several users, pass a callable instead. It receives the run context at the start of each run and returns that user's token, so each run opens its own connection and acts as its own user:

```python
from dataclasses import dataclass

from pydantic_ai import Agent, RunContext
from pydantic_ai_harness.slack import Slack


@dataclass
class Deps:
    slack_user_token: str | None


def slack_token(ctx: RunContext[Deps]) -> str | None:
    return ctx.deps.slack_user_token


agent = Agent('openai:gpt-5.6-sol', deps_type=Deps, capabilities=[Slack(auth=slack_token)])
```

The callable can be async and can return a token or an `httpx.Auth`. When it returns `None`, the run has no Slack tools; it does not fall back to `SLACK_USER_TOKEN`. Returning `'oauth'` raises an error, because it would open a browser on the server. Your application owns obtaining, storing, and refreshing each user's token, for example through Slack's OAuth flow in your web app, and the callable reads the current token from that store.

`client` also accepts a callable that returns a configured client or transport for each run.

Each run connects and lists tools when it starts, and disconnects when it ends. Under durable execution such as Temporal, the callable runs in the worker, so it should derive the token from serializable deps. Give each `Slack` on one agent a distinct `id`.

## Provider settings

Slack's hosted MCP server accepts user tokens (`xoxp-`), not bot tokens (`xoxb-`). Register the app and grant its user-token scopes as described in Slack's MCP documentation. Automatic OAuth client registration is not supported; a configured OAuth client can be supplied through `client`.

The tools act as the token's user, including when posting messages or editing canvases. This capability supplies tools to ordinary agent runs; receiving Slack messages is a separate application concern.

## Tool selection and approval

`read_only=True` keeps only tools explicitly marked `readOnlyHint: true`; unmarked tools are omitted. This can leave no tools when a server does not annotate its read operations. Credentials remain the access-control boundary.

For application-level filtering or approval, compose the existing [toolset wrappers](https://pydantic.dev/docs/ai/tools-toolsets/toolsets/). For example, this requires approval before every tool call:

```python
from pydantic_ai import Agent
from pydantic_ai.messages import DeferredToolRequests
from pydantic_ai_harness.slack import Slack

capability = Slack()
agent = Agent(
    'openai:gpt-5.6-sol',
    toolsets=[capability.get_toolset().approval_required()],
    output_type=[str, DeferredToolRequests],
)
```

Handle the resulting requests using the [deferred tools workflow](https://pydantic.dev/docs/ai/tools-toolsets/deferred-tools/). Output limits can be composed with [Tool Output Limits](https://pydantic.dev/docs/ai/harness/tool-output-limits/).

## Connection customization

Pass `client` to use a configured FastMCP client or transport, including custom OAuth token storage and MCP handlers. That client owns its URL, authentication, and server configuration; configure those on it instead of the capability. `read_only=True` applies the same annotation filter to custom clients.

`include_instructions` controls whether server instructions reach the model. A fixed `client` is one connection shared by every run; see [Per-user credentials](#per-user-credentials) for per-run connections. To combine connections with overlapping tool names, give them distinct IDs and compose [PrefixTools](https://pydantic.dev/docs/ai/capabilities/prefix-tools/).

[Source](https://github.com/pydantic/pydantic-ai-harness/tree/main/pydantic_ai_harness/slack/)
