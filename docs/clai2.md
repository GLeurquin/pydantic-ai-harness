# CLAI 2.0

A separately installable terminal client for Pydantic AI, using `Coder()` by default.
Python 3.11+ is required by Termflow. Tracking issue: https://github.com/pydantic/pydantic-ai-harness/issues/875.

## Run from this repository

```sh
cd packages/pydantic-clai2
uv sync
uv run clai2 config set model anthropic:YOUR_MODEL_ID
uv run clai2
```

Set the provider's API key environment variable before starting. The default Coder
can read and modify files and execute commands with your user permissions. Run it
in a workspace you trust. CLAI does not add a sandbox or approval layer.

The startup splash adapts Code Puppy's stdlib-only, alternate-screen Pydantic
pyramid, with CLAI lettering. The persistent `CLAI 2.0` banner uses `ansi_shadow`.
The splash is disabled for redirected output, CLI arguments, small terminals,
Windows, `NO_COLOR`, or `CLAI_NO_SPLASH=1`.

## Settings and commands

Preferences live in `$XDG_CONFIG_HOME/pydantic-clai2/config.db`, falling back to
`~/.config/pydantic-clai2/config.db`. Use `--database PATH` to select another database.
There is no automatic repository config loading. API keys and conversation messages
are not written to the settings database.

```sh
clai2 config show
clai2 config set display.thinking false
clai2 config set run.request_limit 10000
clai2 config reset display.thinking
```

Precedence is defaults, SQLite overrides, `CLAI_MODEL`, then explicit CLI flags.
Settings are validated before writes and snapshotted at startup. Changes apply on
restart. `--request-limit` controls the full prompt's model-request budget.

Interactive commands: `/help`, `/new`, `/exit`, `/config`, and `/plugins`.
Tab completion suggests commands, settings, boolean values, plugin identifiers,
and paths after `@`. Path completion inserts a path; it does not attach file contents.
Unknown slash commands are not sent to the model. Up/down recall prompt history
within this process. Ctrl-D exits. Ctrl-C at input clears the line; during a run it
exits and unwinds the agent. No cancelled run is automatically retried.

## Bring an agent

```python
import asyncio
from pydantic_ai import Agent
from pydantic_clai2 import chat

agent = Agent('test')  # No capabilities required.
asyncio.run(chat(agent, deps=None))
```

`Session(agent, deps=..., plugins=..., on_stream_event=...)` is the noninteractive
API. Call `await session.prompt(text)` for each turn. Native `agent.run` drives the
loop through tools to completion. Successful turns retain `result.all_messages()`;
failed or cancelled turns leave the previous history intact, though external tool
side effects may already have occurred. History is in memory only. Structured
outputs are supported and displayed after completion.

Text and available thinking content are rendered line-by-line with Termflow,
including final incomplete lines. Thinking signatures without text cannot be shown.
A supplied agent's existing stream handler is preserved.

## Capability plugins

Plugins are native `AbstractCapability` instances, supplied per run. Use core's
`@on_event` for typed `AgentStreamEvent` or `CapabilityEvent` subscriptions. There
is no second event dispatcher or global callback registry.

```python
from pydantic_ai import CapabilityEvent, RunContext
from pydantic_ai.capabilities import AbstractCapability, on_event


class AuditPlugin(AbstractCapability[None]):
    @on_event(CapabilityEvent)
    async def record(self, ctx: RunContext[None], event: CapabilityEvent) -> None:
        print(type(event).__name__)
```

Pass instances through `chat(..., plugins=[AuditPlugin()])` or `Session`.
For the default CLI, explicitly register an importable class:

```sh
clai2 plugins add audit my_plugins:AuditPlugin
clai2 plugins list
clai2 plugins disable audit
```

An optional fourth argument to `plugins add` is a JSON settings object. Its entries
are passed as constructor keyword arguments; the plugin owns validation, preferably
with its own Pydantic model. Disabled plugins are not imported. Plugins execute
trusted Python code with your permissions. Only register code you trust.

`Commands.register(Command(...))` supports application-owned commands with a
handler and contextual completion provider. Help, dispatch, and completion share
one registry. Plugin-driven command registration is not implemented yet.

## Telemetry and references

CLAI emits no additional telemetry. Pydantic AI's own instrumentation covers model
requests, tools, and capability hooks when configured on the supplied agent.

- [Pydantic AI agent execution and events](https://pydantic.dev/docs/ai/core-concepts/agent/)
- [Capability events](https://pydantic.dev/docs/ai/capabilities/overview/)
- [Code Puppy splash](https://github.com/code-puppy/code_puppy/blob/main/code_puppy/splash.py)
- [Code Puppy streaming](https://github.com/code-puppy/code_puppy/blob/main/code_puppy/agents/event_stream_handler.py)
- [Code Puppy command registry](https://github.com/code-puppy/code_puppy/blob/main/code_puppy/command_line/command_registry.py)

See `THIRD_PARTY_NOTICES.md` for attribution.
