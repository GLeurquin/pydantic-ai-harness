# Ordinal

`Ordinal` connects an agent to [Ordinal](https://www.tryordinal.com)'s hosted MCP
server so it can draft, schedule, and analyze social posts in the signed-in
user's workspaces.

[Source](https://github.com/pydantic/pydantic-ai-harness/tree/main/pydantic_ai_harness/ordinal/)

> While Pydantic AI Harness is on 0.x releases, the API may change between minor releases; when it does, deprecation warnings and release-note migration guidance tell you (or your agent) exactly how to upgrade. See the [version policy](https://github.com/pydantic/pydantic-ai-harness#version-policy).

## Before you start

Ordinal MCP is available on the Pro plan or higher, same as the REST API. You
need an Ordinal account with access to at least one workspace. Sign-in is OAuth
-- there is no API key to copy.

If you previously configured the old server at `https://app.tryordinal.com/api/mcp`
with a workspace API key, remove it. The old and new servers cannot coexist:
duplicate tool names confuse the agent.

## Installation

uv:

```bash
uv add "pydantic-ai-harness[ordinal]" "pydantic-ai-slim[openai]"
```

pip:

```bash
pip install "pydantic-ai-harness[ordinal]" "pydantic-ai-slim[openai]"
```

The second package installs the OpenAI provider used by the example. For
another model, install its matching provider extra instead.

## Connect

```python
from pydantic_ai import Agent
from pydantic_ai_harness import Ordinal

agent = Agent('openai:gpt-5', capabilities=[Ordinal()])
result = agent.run_sync('List my Ordinal workspaces')
print(result.output)
```

Without `auth`, the first Ordinal tool call opens a browser. Sign in and
approve access. To serve several users from one agent, pass each user's token
instead (see [Per-user credentials](#per-user-credentials)). After that, start by listing workspaces -- every other Ordinal tool needs a
`workspaceSlug` from `ordinal_get_workspace_context`.

`Ordinal` only configures the connection. For custom clients, tool filtering,
or approval policy, use Pydantic AI's generic
[`MCP`](https://pydantic.dev/docs/ai/capabilities/mcp/) capability or
[`MCPToolset`](https://pydantic.dev/docs/ai/mcp/) directly.

## Per-user credentials

Without `auth`, the capability uses browser OAuth: every run shares one
connection and the identity of whoever signed in. A fixed `auth` token does the
same with that token's identity. Use these for scripts, local tools, and
single-user agents. Browser OAuth opens a browser on the machine running the
agent and keeps tokens in memory, so it does not suit a server.

When one agent serves several users, pass a callable as `auth`. It receives the
run context at the start of each run and returns that user's Ordinal access
token, so each run opens its own connection:

```python
from dataclasses import dataclass

from pydantic_ai import Agent, RunContext
from pydantic_ai_harness import Ordinal


@dataclass
class Deps:
    ordinal_token: str | None


def ordinal_token(ctx: RunContext[Deps]) -> str | None:
    return ctx.deps.ordinal_token


agent = Agent('openai:gpt-5', deps_type=Deps, capabilities=[Ordinal(auth=ordinal_token)])
```

The callable can be async and can return a token or an `httpx.Auth`. When it
returns `None`, the run has no Ordinal tools; it does not fall back to browser
OAuth. Returning `'oauth'` raises an error, because it would open a browser on
the server. Your application owns obtaining, storing, and refreshing each user's
token, for example through an OAuth flow in your web app, and the callable reads
the current token from that store.

Each run connects and lists tools when it starts, and disconnects when it ends.
Under durable execution such as Temporal, the callable runs in the worker, so it
should derive the credential from serializable deps. Give each `Ordinal` on one
agent a distinct `id`.

## Define the agent in YAML or JSON

```yaml
# agent.yaml
model: openai:gpt-5
capabilities:
  - Ordinal: {}
```

```python
from pydantic_ai import Agent
from pydantic_ai_harness import Ordinal

agent = Agent.from_file('agent.yaml', custom_capability_types=[Ordinal])
```

Pass `custom_capability_types` so the spec loader knows how to instantiate `Ordinal`.
