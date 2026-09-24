# Composio

Give an agent access to connected applications through a Composio session. Composio handles tool discovery, app authorization, and execution; this capability connects the session to your agent.

> While Pydantic AI Harness is on 0.x releases, the API may change between minor releases; when it does, deprecation warnings and release-note migration guidance tell you (or your agent) exactly how to upgrade. See the [version policy](index.md#version-policy).

## Install and connect

```bash
pip/uv-add "pydantic-ai-harness[composio]" "pydantic-ai-slim[openai]"
```

The `composio` extra installs the Composio SDK and MCP support. The model provider is installed separately.

Set `COMPOSIO_API_KEY` for Composio and `OPENAI_API_KEY` for the model. Create a session for a stable user ID from your application, and pass both connection values returned by Composio:

```python
from composio import Composio as ComposioClient
from pydantic_ai import Agent
from pydantic_ai_harness.composio import Composio

composio = ComposioClient()
session = composio.sessions.create(user_id='user_123', mcp=True)
agent = Agent(
    'openai:gpt-5.6-sol',
    capabilities=[Composio(url=session.mcp.url, headers=session.mcp.headers)],
)
result = agent.run_sync('Find the applications I can connect to')
print(result.output)
```

For later turns, reuse the session. Store `session.session_id` and restore it with `composio.use(session_id, mcp=True)` when needed. Session creation and restoration belong to your application. For an agent that serves several users, do them in a `client` callable (see [Per-user sessions](#per-user-sessions)).

## Per-user sessions

A fixed `url` and `headers`, or a fixed `client`, give every run the same connection and the same Composio session, so every run acts as the user that session was created for. Use them for scripts, local tools, and single-user agents.

When one agent serves several users, pass a callable as `client`. It receives the run context at the start of each run and returns a transport for that user's session, so each run opens its own connection:

```python
import asyncio
from dataclasses import dataclass

from composio import Composio as ComposioClient
from fastmcp.client.transports import StreamableHttpTransport
from pydantic_ai import Agent, RunContext
from pydantic_ai_harness.composio import Composio

composio = ComposioClient()


@dataclass
class Deps:
    user_id: str
    composio_session_id: str | None = None


def session_transport(deps: Deps) -> StreamableHttpTransport:
    if deps.composio_session_id is None:
        session = composio.sessions.create(user_id=deps.user_id, mcp=True)
        # Store session.session_id for this user so later runs restore it.
    else:
        session = composio.sessions.use(deps.composio_session_id, mcp=True)
    headers = {key: value for key, value in (session.mcp.headers or {}).items() if value is not None}
    return StreamableHttpTransport(session.mcp.url, headers=headers)


async def composio_session(ctx: RunContext[Deps]) -> StreamableHttpTransport:
    return await asyncio.to_thread(session_transport, ctx.deps)


agent = Agent('openai:gpt-5.6-sol', deps_type=Deps, capabilities=[Composio(client=composio_session)])
```

The callable can be async and can return any MCP client or transport. Composio's SDK is synchronous and calls its API to create or restore a session, so run it in a thread as above to keep the event loop free. `session.mcp.headers` can contain unset values; drop them before building the transport, as the capability does for `headers`. When the callable returns `None`, the run has no Composio tools; it does not fall back to `url` and `headers`. Your application owns mapping each user to a Composio user ID and storing their session ID.

Each run connects and lists tools when it starts, and disconnects when it ends. Under durable execution such as Temporal, the callable runs in the worker, so it should derive the session from serializable deps. Give each `Composio` on one agent a distinct `id`.

## Session settings

Choose toolkits, connected accounts, and tool restrictions when configuring the Composio session. By default, its discovery and execution tools let the agent find app actions as needed. Composio also offers a direct-tools preset when you want a fixed set of actions. Follow [Composio's session guide](https://docs.composio.dev/docs/sessions-via-mcp) for configuration and app authorization.

The capability forwards server instructions by default; set `include_instructions=False` to omit them. For a custom transport, pass `client=...`; that client owns its connection settings and overrides `url` and `headers`. A fixed `client` is one connection shared by every run; see [Per-user sessions](#per-user-sessions) for per-run connections.

The agent can use every tool exposed by the session, including writes. Configure access in Composio. For application-level approval or filtering, use Pydantic AI's [toolset wrappers](/ai/tools-toolsets/toolsets/) on `capability.get_toolset()`.

Composio's hosted MCP endpoint does not run local SDK tool-call modifiers or expose in-process custom tools. Those features require Composio's native SDK execution path.

[Source](https://github.com/pydantic/pydantic-ai-harness/tree/main/pydantic_ai_harness/composio/)
