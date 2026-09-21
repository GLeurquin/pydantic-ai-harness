---
title: E2B Workspace
description: Give a Pydantic AI agent an E2B workspace for commands and files.
---

# E2B Workspace

Run agent tools against files and processes in an E2B environment. `E2BWorkspace` supplies the run's `ctx.workspace`; your tools choose which operations the model can use.

[Source](https://github.com/pydantic/pydantic-ai-harness/tree/main/pydantic_ai_harness/e2b_workspace/)

> While Pydantic AI Harness is on 0.x releases, the API may change between minor releases; when it does, deprecation warnings and release-note migration guidance tell you (or your agent) exactly how to upgrade. See the [version policy](https://pydantic.dev/docs/ai/harness/#version-policy).

## Install

```bash
pip/uv-add "pydantic-ai-harness[e2b]"
```

Set `E2B_API_KEY` for authentication. The integration requires E2B SDK 2.34.0 or later.

## Use a workspace

```python
from pydantic_ai import Agent, RunContext
from pydantic_ai_harness.e2b_workspace import E2BWorkspace

agent = Agent('anthropic:claude-sonnet-4-6', capabilities=[E2BWorkspace()])

@agent.tool
async def run_python(ctx: RunContext[None], code: str) -> str:
    result = await ctx.workspace.run(['python', '-c', code], timeout=10)
    return result.stdout + result.stderr

async def main() -> None:
    first = await agent.run('Write the numbers 1 to 5 to /tmp/numbers.txt.')
    second = await agent.run(
        'Read /tmp/numbers.txt and calculate their sum.',
        message_history=first.all_messages(),
    )
    print(second.output)
```

Construction makes no E2B requests. First use creates a workspace and records its reference; later operations on that backend reuse the SDK handle. A run that does not use its workspace creates nothing.

The second run above recovers the reference from history and attaches on first use. Without a reference or history, each run creates a fresh workspace when needed. Metadata is passed to E2B as ordinary labels; it is not searched to recover workspaces. An explicit reference takes precedence over history. Missing references fail instead of creating empty replacements.

Tools can also call `ctx.workspace.read_text()`, `write_text()`, and filesystem operations. The existing `Shell` and `FileSystem` capabilities operate on the agent process's host; adding `E2BWorkspace` does not move those tools into E2B.

## References and the native SDK handle

Persist `result.workspace.ref` to reuse the environment outside message history. It is `None` until creation succeeds; supplying an existing reference exposes that reference immediately.

```python
from pydantic_ai import Agent, RunContext
from pydantic_ai.workspaces import WorkspaceRef
from pydantic_ai_harness.e2b_workspace import E2BWorkspace

agent = Agent('anthropic:claude-sonnet-4-6', capabilities=[E2BWorkspace()])

@agent.tool
async def read_file(ctx: RunContext[None], path: str) -> str:
    return await ctx.workspace.read_text(path)

async def resume(ref: WorkspaceRef) -> str:
    result = await agent.run('Read /tmp/numbers.txt.', workspace=ref)
    return result.output
```

Retain an `E2BWorkspaceBackend` and call `await backend.get_client()` to get the typed `e2b.AsyncSandbox`. The first call creates or attaches to the environment; later calls return the same object. An existing native handle can be supplied with `E2BWorkspaceBackend(workspace=native)`. Supply either a native handle or `ref=`, not both.

Pydantic AI does not kill the environment; that is the application's job. This example explicitly acquires a workspace and kills it after the run:

```python
from pydantic_ai import Agent, RunContext
from pydantic_ai_harness.e2b_workspace import E2BWorkspaceBackend

agent = Agent('anthropic:claude-sonnet-4-6')

@agent.tool
async def working_directory(ctx: RunContext[None]) -> str:
    return await ctx.workspace.working_dir()

async def run_with_cleanup() -> str:
    backend = E2BWorkspaceBackend()
    native = await backend.get_client()
    try:
        result = await agent.run('What is the working directory?', workspace=backend)
        return result.output
    finally:
        await native.kill()
```

## Lifetimes and cleanup

`sandbox_timeout` controls the lifetime of a newly created environment and defaults to 300 seconds. Finishing an agent run does not kill it. E2B's `connect` resumes a paused environment and applies its default 300-second connection lifetime, which can extend a shorter remaining lifetime.

The template, lifetime, environment variables, and metadata configure creation. They do not reconfigure an environment attached by reference. `workdir` sets the backend's command working directory, including for an attached environment.

E2B runs commands through `/bin/bash -l -c`. Argument lists are shell-quoted, and login-shell startup files still run.

Command `timeout` covers acquisition, startup, and waiting for completion. On timeout, cancellation, or a result-reading failure, the backend attempts to kill the command's PID with a bounded cleanup request. Before the SDK returns a command handle, there is no PID to kill; killing a parent process also does not guarantee termination of detached children. Commands buffer complete output, and timeout errors include output collected by the SDK.

Cancelling creation can leave an environment whose ID the caller did not receive; the configured server lifetime still applies.

Pydantic AI does not kill environments. Killing them, and choosing a `sandbox_timeout` that reaps the ones you lose track of, is the application's job. `E2BWorkspace.get_workspace` performs no I/O, so a backend can be rebuilt from a `WorkspaceRef` wherever the run continues, including under a durable execution engine; the reference carries no credentials, so each worker needs its own `E2B_API_KEY`. See [Workspaces](https://pydantic.dev/docs/ai/core-concepts/workspace/) for how a run selects and restores its workspace.

The capability emits no additional telemetry spans. Core agent and tool spans cover calls made through tools; provider-specific diagnostics remain available through E2B.

## API reference

::: pydantic_ai_harness.e2b_workspace.E2BWorkspace

::: pydantic_ai_harness.e2b_workspace.E2BWorkspaceBackend
