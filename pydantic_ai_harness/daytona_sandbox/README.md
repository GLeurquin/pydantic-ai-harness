# Daytona Sandbox

Run agent tools against files and processes in a Daytona environment. `DaytonaSandbox` supplies the run's `ctx.workspace`; your tools choose which operations the model can use.

[Source](https://github.com/pydantic/pydantic-ai-harness/tree/main/pydantic_ai_harness/daytona_sandbox/)

> While Pydantic AI Harness is on 0.x releases, the API may change between minor releases; when it does, deprecation warnings and release-note migration guidance tell you (or your agent) exactly how to upgrade. See the [version policy](https://pydantic.dev/docs/ai/harness/#version-policy).

## Install

uv:

```bash
uv add "pydantic-ai-harness[daytona]"
```

pip:

```bash
pip install "pydantic-ai-harness[daytona]"
```

Set `DAYTONA_API_KEY` for authentication. The integration uses Daytona SDK 0.198.x.

## Use a workspace

Keep the SDK client open around the agent's runs. Its context manager closes local HTTP connections and subscriptions when finished; the remote workspace remains available.

```python
from daytona import AsyncDaytona
from pydantic_ai import Agent, RunContext
from pydantic_ai_harness.daytona_sandbox import DaytonaSandbox

async def main() -> None:
    async with AsyncDaytona() as client:
        agent = Agent(
            'anthropic:claude-sonnet-4-6',
            capabilities=[DaytonaSandbox(client=client)],
        )

        @agent.tool
        async def run_python(ctx: RunContext[None], code: str) -> str:
            result = await ctx.workspace.run(['python', '-c', code], timeout=10)
            return result.stdout + result.stderr

        first = await agent.run('Write the numbers 1 to 5 to /tmp/numbers.txt.')
        second = await agent.run(
            'Read /tmp/numbers.txt and calculate their sum.',
            message_history=first.all_messages(),
        )
        print(second.output)
```

Constructing the capability or backend makes no Daytona requests. First use creates a workspace and records its reference; later operations on that backend reuse the SDK handle. A run that does not use its workspace creates no remote environment.

The second run recovers the reference from history and attaches on first use, starting the environment if it is stopped. Without a reference or history, each run creates a fresh workspace when needed. An explicit reference takes precedence over history. A missing referenced environment fails instead of creating an empty replacement. Backend `name=` is a creation option, not a lookup key.

Tools can also call `ctx.workspace.read_text()`, `write_text()`, and filesystem operations. The existing `Shell` and `FileSystem` capabilities operate on the agent process's host; adding `DaytonaSandbox` does not move those tools into Daytona.

## References and the native SDK handle

Persist `result.workspace.ref` to reuse the environment outside message history. It is `None` until creation succeeds; supplying an existing reference exposes that reference immediately. Keep the reference when closing a client, then supply a new client for later runs:

```python
from daytona import AsyncDaytona
from pydantic_ai import Agent, RunContext
from pydantic_ai.workspaces import WorkspaceRef
from pydantic_ai_harness.daytona_sandbox import DaytonaSandbox

async def resume(ref: WorkspaceRef) -> str:
    async with AsyncDaytona() as client:
        agent = Agent(
            'anthropic:claude-sonnet-4-6',
            capabilities=[DaytonaSandbox(client=client)],
        )

        @agent.tool
        async def read_file(ctx: RunContext[None], path: str) -> str:
            return await ctx.workspace.read_text(path)

        result = await agent.run('Read /tmp/numbers.txt.', workspace=ref)
        return result.output
```

Retain a `DaytonaSandboxBackend` and call `await backend.get_client()` to obtain the typed `daytona.AsyncSandbox`. The first call creates or attaches to the environment; later calls return the same object. An existing native handle can be supplied with `DaytonaSandboxBackend(workspace=native)`. Supply either a native handle or `ref=`, not both; the caller retains ownership of an injected handle and its SDK client.

Without `client=`, the backend creates and owns its `AsyncDaytona` API client on first acquisition. Retain that backend and call `disconnect()` in `finally`. This example also deletes the remote workspace using the native SDK:

```python
from pydantic_ai import Agent, RunContext
from pydantic_ai_harness.daytona_sandbox import DaytonaSandboxBackend

agent = Agent('anthropic:claude-sonnet-4-6')

@agent.tool
async def working_directory(ctx: RunContext[None]) -> str:
    return await ctx.workspace.working_dir()

async def run_with_cleanup() -> str:
    backend = DaytonaSandboxBackend()
    try:
        native = await backend.get_client()
        try:
            result = await agent.run('What is the working directory?', workspace=backend)
            return result.output
        finally:
            await native.delete(wait=True)
    finally:
        await backend.disconnect()
```

To keep the remote workspace, omit `native.delete()` and retain the outer `finally` that disconnects the backend. `disconnect()` closes only a backend-owned SDK client; it does not delete or start a workspace, or close a caller-supplied client. Finish in-flight operations before disconnecting or leaving the SDK client context.

## Lifetimes and cleanup

`auto_stop_minutes` defaults to 60 for newly created environments; `0` disables automatic stopping. Creation disables automatic deletion, so stopping retains disk. Finishing an agent run does not stop or delete the environment. Attached environments retain their existing lifecycle settings.

The snapshot, environment variables, network settings, and automatic-stop interval configure creation. They do not reconfigure an environment attached by reference. The capability's `workdir` sets the backend's command working directory, including for an attached environment.

Commands use Daytona process sessions. Argument lists are shell-quoted into command strings. The command `timeout` covers acquisition, session startup, and waiting for completion. The backend attempts bounded session deletion after completion, timeout, cancellation, or a result-reading failure. A failed cleanup request may leave the command running; these deadlines bound local waits and do not guarantee server-side termination. Complete output is buffered, and timeout errors include output received so far.

Cancelling creation can leave an environment whose ID the caller did not receive. Automatic stopping does not delete its disk.

Pydantic AI does not stop or delete environments. Deleting them, and choosing the `auto_stop_minutes` that applies to the ones you lose track of, is the application's job. `DaytonaSandbox.get_workspace` performs no I/O, so a backend can be rebuilt from a `WorkspaceRef` wherever the run continues, including under a durable execution engine; the reference carries no credentials, so each worker needs its own `DAYTONA_API_KEY` or `client=`. See [Workspaces](https://pydantic.dev/docs/ai/core-concepts/workspace/) for how a run selects and restores its workspace.

The capability emits no additional telemetry spans. Core agent and tool spans cover calls made through tools; the Daytona SDK retains its own instrumentation behavior.

## API reference

::: pydantic_ai_harness.daytona_sandbox.DaytonaSandbox

::: pydantic_ai_harness.daytona_sandbox.DaytonaSandboxBackend
