# CLAI 2.0

A separately installable terminal client for Pydantic AI, using `Coder()` by default.
Python 3.11+ is required by Termflow. Tracking issue: https://github.com/pydantic/pydantic-ai-harness/issues/875.

## Start chatting

Launch `clai2`. No model needs to be configured before the terminal opens.
Type `/set model ` and press Tab to pick a provider-qualified model name.
The choice is saved in SQLite and used for the next prompt without restarting.

From a source checkout, launch with `uv run --project pydantic-clai2 clai2`.

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

```text
/set
/set model <Tab>
/set display.thinking false
/set run.request_limit 10000
```

Tab completes setting names, boolean values, and model names from Pydantic AI's
built-in catalog without network access. Provider prefixes include `openai-codex:`,
which core supports but does not currently include in that model catalog. Complete
the provider prefix, then enter the model identifier; suggestions do not establish
subscription availability. Custom model identifiers are accepted too.

The command registry uses Termflow's `Completer`, `Document`, and `Completion`
types. The current input widget and popup still use prompt-toolkit through a small
adapter; replacing that editor with a Termflow-based editor is separate work.
`/set SETTING` shows its current value. `/set` changes apply to subsequent prompts
and preserve conversation history; splash changes apply at next startup.

Precedence is defaults, SQLite overrides, `CLAI_MODEL`, then explicit CLI flags.
Settings are validated before writes. `/set` updates the active settings snapshot;
legacy `/config` writes and plugin changes apply on restart. `--request-limit` controls the full prompt's model-request budget.

Interactive commands: `/set`, `/help`, `/new`, `/exit`, `/config`, and `/plugins`.
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

### Plugin commands

Capabilities can explicitly implement the typed `CommandProvider` protocol.
CLAI calls `get_commands(context)` once at startup and registers the returned
immutable `Command` declarations. Handlers receive parsed arguments and return
text; completion providers receive argument prefixes and return suggestions.

```python
from pydantic_ai.capabilities import AbstractCapability
from pydantic_clai2.command_context import CommandContext, CommandProvider
from pydantic_clai2.commands import Command


class GreetingPlugin(AbstractCapability[None], CommandProvider):
    def get_commands(self, context: CommandContext) -> list[Command]:
        return [
            Command(
                name='greet',
                description='Show a greeting',
                handler=lambda args: 'Hello ' + (' '.join(args) or 'there'),
                complete=lambda args: ('Mike',),
            )
        ]
```

Pass `GreetingPlugin()` through `plugins=` or register its class with `/plugins`.
Its `/greet` command appears in help and autocomplete automatically. `CommandContext`
provides active settings, the settings store, history clearing, and the validated
`set_setting` operation. Duplicate names, including collisions with built-ins, are
rejected before a provider's commands are installed. Registries are conversation-local.
There are no string event names or global callback hooks. Native `@on_event`
methods remain responsible for runtime agent/capability event subscriptions.

## Telemetry and references

CLAI emits no additional telemetry. Pydantic AI's own instrumentation covers model
requests, tools, and capability hooks when configured on the supplied agent.

- [Pydantic AI agent execution and events](https://pydantic.dev/docs/ai/core-concepts/agent/)
- [Capability events](https://pydantic.dev/docs/ai/capabilities/overview/)
- [Code Puppy splash](https://github.com/code-puppy/code_puppy/blob/main/code_puppy/splash.py)
- [Code Puppy streaming](https://github.com/code-puppy/code_puppy/blob/main/code_puppy/agents/event_stream_handler.py)
- [Code Puppy command registry](https://github.com/code-puppy/code_puppy/blob/main/code_puppy/command_line/command_registry.py)

See `THIRD_PARTY_NOTICES.md` for attribution.
