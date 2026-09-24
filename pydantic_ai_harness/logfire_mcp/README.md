# Logfire MCP

Query Logfire telemetry and manage observability resources. `LogfireMCP` connects an agent to the provider's hosted MCP server. By default it exposes the tools the server offers, including write tools. Provider credentials and server settings determine what those tools may access.

> While Pydantic AI Harness is on 0.x releases, the API may change between minor releases; when it does, deprecation warnings and release-note migration guidance tell you (or your agent) exactly how to upgrade. See the [version policy](https://github.com/pydantic/pydantic-ai-harness#version-policy).

## Install and connect

uv:

```bash
uv add "pydantic-ai-harness[logfire-mcp]" "pydantic-ai-slim[openai]"
```

pip:

```bash
pip install "pydantic-ai-harness[logfire-mcp]" "pydantic-ai-slim[openai]"
```

Set `LOGFIRE_API_KEY` to a Logfire API key, or pass `auth=...`. When neither is supplied, the connection starts browser OAuth. `auth` accepts an `httpx.Auth` for caller-managed authentication, or a callable that returns a credential for each run (see [Per-user credentials](#per-user-credentials)). See the [provider setup](https://pydantic.dev/docs/logfire/guides/mcp-server/).

```python
from pydantic_ai import Agent
from pydantic_ai_harness.logfire_mcp import LogfireMCP

agent = Agent('openai:gpt-5.6-sol', capabilities=[LogfireMCP()])
result = agent.run_sync('Summarize the resources I can access')
print(result.output)
```

## Per-user credentials

A fixed `auth`, `LOGFIRE_API_KEY`, and `'oauth'` all give every run the same connection and the same identity. Use them for scripts, local tools, and single-user agents. `'oauth'` opens a browser on the machine running the agent and keeps tokens in memory, so it does not suit a server.

When one agent serves several users, pass a callable instead. It receives the run context at the start of each run and returns that user's credential, so each run opens its own connection:

```python
from dataclasses import dataclass

from pydantic_ai import Agent, RunContext
from pydantic_ai_harness.logfire_mcp import LogfireMCP


@dataclass
class Deps:
    logfire_token: str | None
    logfire_region: str = 'us'


def logfire_token(ctx: RunContext[Deps]) -> str | None:
    return ctx.deps.logfire_token


agent = Agent('openai:gpt-5.6-sol', deps_type=Deps, capabilities=[LogfireMCP(auth=logfire_token)])
```

The callable can be async and can return a token or an `httpx.Auth`. When it returns `None`, the run has no Logfire tools; it does not fall back to `LOGFIRE_API_KEY` or browser OAuth. Returning `'oauth'` raises an error, because it would open a browser on the server. Your application owns obtaining, storing, and refreshing each user's token, for example through an OAuth flow in your web app, and the callable reads the current token from that store.

`client` accepts a callable in the same way, for settings beyond the credential that differ per user, such as a user whose data is in the EU region:

```python
from fastmcp.client.transports import StreamableHttpTransport
from pydantic_ai import RunContext
from pydantic_ai_harness.logfire_mcp import LOGFIRE_EU_MCP_URL, LOGFIRE_US_MCP_URL, LogfireMCP


def logfire_client(ctx: RunContext[Deps]) -> StreamableHttpTransport | None:
    if ctx.deps.logfire_token is None:
        return None
    url = LOGFIRE_EU_MCP_URL if ctx.deps.logfire_region == 'eu' else LOGFIRE_US_MCP_URL
    return StreamableHttpTransport(url, auth=ctx.deps.logfire_token)


capability = LogfireMCP(client=logfire_client)
```

Each run connects and lists tools when it starts, and disconnects when it ends. Under durable execution such as Temporal, the callable runs in the worker, so it should derive the credential from serializable deps. Give each `LogfireMCP` on one agent a distinct `id`.

## Provider settings

The default endpoint is `https://logfire-us.pydantic.dev/mcp`. Set `url=LOGFIRE_EU_MCP_URL` for EU data, or provide a self-hosted MCP URL. API-key scopes determine access to projects and operations.

The capability supplies the current UTC time and brief query guidance: schema timestamps are not a clock, transport time bounds also constrain SQL, and links are created only when requested. `include_instructions=False` disables both this guidance and server instructions. Logfire owns query semantics, time windows, and result schemas.

## Tool selection and approval

`read_only=True` keeps only tools explicitly marked `readOnlyHint: true`; unmarked tools are omitted. This can leave no tools when a server does not annotate its read operations. Credentials remain the access-control boundary.

For application-level filtering or approval, compose the existing [toolset wrappers](https://pydantic.dev/docs/ai/tools-toolsets/toolsets/). For example, this requires approval before every tool call:

```python
from pydantic_ai import Agent
from pydantic_ai.messages import DeferredToolRequests
from pydantic_ai_harness.logfire_mcp import LogfireMCP

capability = LogfireMCP()
agent = Agent(
    'openai:gpt-5.6-sol',
    toolsets=[capability.get_toolset().approval_required()],
    instructions=capability.get_instructions(),
    output_type=[str, DeferredToolRequests],
)
```

Handle the resulting requests using the [deferred tools workflow](https://pydantic.dev/docs/ai/tools-toolsets/deferred-tools/). Output limits can be composed with [Tool Output Limits](https://pydantic.dev/docs/ai/harness/tool-output-limits/).

## Connection customization

Pass `client` to use a configured FastMCP client or transport, including custom OAuth token storage and MCP handlers. That client owns its URL, authentication, and server configuration; configure those on it instead of the capability. `read_only=True` applies the same annotation filter to custom clients.

`include_instructions` controls whether server instructions reach the model. A fixed `client` is one connection shared by every run; see [Per-user credentials](#per-user-credentials) for per-run connections. To combine connections with overlapping tool names, give them distinct IDs and compose [PrefixTools](https://pydantic.dev/docs/ai/capabilities/prefix-tools/).

[Source](https://github.com/pydantic/pydantic-ai-harness/tree/main/pydantic_ai_harness/logfire_mcp/)
