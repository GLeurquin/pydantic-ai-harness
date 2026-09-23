---
title: Modal Sandbox
description: Give a Pydantic AI agent a Modal sandbox as its workspace for commands and files.
---

# Modal Sandbox

Run agent tools against files and processes in a Modal container. `ModalSandbox` supplies the run's `ctx.workspace`; your tools choose which workspace operations the model can use.

[Source](https://github.com/pydantic/pydantic-ai-harness/tree/main/pydantic_ai_harness/modal_sandbox/)

> While Pydantic AI Harness is on 0.x releases, the API may change between minor releases; when it does, deprecation warnings and release-note migration guidance tell you (or your agent) exactly how to upgrade. See the [version policy](index.md#version-policy).

## Install

```bash
pip/uv-add "pydantic-ai-harness[modal]"
```

```bash
py-cli modal token new
```

Modal SDK 1.5.2 or later is required for its filesystem operations. Credentials can also be supplied through `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`.

## Use a workspace

```python
from pydantic_ai import Agent, RunContext
from pydantic_ai_harness.modal_sandbox import ModalSandbox

agent = Agent(
    'anthropic:claude-sonnet-4-6',
    capabilities=[ModalSandbox(image='python:3.12-slim')],
)

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

Construction makes no Modal requests. The first workspace operation creates the container and records its reference. Later operations on that backend reuse the same SDK handle. A run that does not use its workspace creates nothing.

The second run above recovers the reference from message history and attaches on first use. Starting a run without a reference or history creates a fresh workspace when needed. An explicit reference takes precedence over history. If the referenced container is gone, attachment fails; it does not create an empty replacement. `name=` is a creation option, not a lookup key.

Tools can also use `ctx.workspace.read_text()`, `write_text()`, and filesystem operations. To give the model ready-made command and file tools in the sandbox, add the `Shell` and `FileSystem` capabilities, which run their tools against `ctx.workspace`.

## References and the native SDK handle

Persist `result.workspace.ref` when your application needs to reuse the container outside message history. It is `None` until creation succeeds; a backend supplied an existing reference exposes that reference immediately.

```python
from pydantic_ai import Agent, RunContext
from pydantic_ai.workspaces import WorkspaceRef
from pydantic_ai_harness.modal_sandbox import ModalSandbox

agent = Agent('anthropic:claude-sonnet-4-6', capabilities=[ModalSandbox()])

@agent.tool
async def read_file(ctx: RunContext[None], path: str) -> str:
    return await ctx.workspace.read_text(path)

async def resume(ref: WorkspaceRef) -> str:
    result = await agent.run('Read /tmp/numbers.txt.', workspace=ref)
    return result.output
```

For SDK operations, retain a `ModalSandboxBackend` and call `await backend.get_client()` to get the typed `modal.Sandbox`. The first call creates or attaches to the container; later calls return the same object. You can also construct the backend with an existing native handle using `ModalSandboxBackend(workspace=native)`. Supply either a native handle or `ref=`, not both.

Pydantic AI does not terminate the container or detach the SDK handle; both are the application's job. This example explicitly acquires a container and cleans it up after the run:

```python
from pydantic_ai import Agent, RunContext
from pydantic_ai_harness.modal_sandbox import ModalSandboxBackend

agent = Agent('anthropic:claude-sonnet-4-6')

@agent.tool
async def working_directory(ctx: RunContext[None]) -> str:
    return await ctx.workspace.working_dir()

async def run_with_cleanup() -> str:
    backend = ModalSandboxBackend(image='python:3.12-slim')
    native = await backend.get_client()
    try:
        result = await agent.run('What is the working directory?', workspace=backend)
        return result.output
    finally:
        try:
            await native.terminate.aio()
        finally:
            await native.detach.aio()
```

## Lifetimes and cleanup

`sandbox_timeout` is the lifetime of a newly created container, in seconds; it defaults to 300. Finishing an agent run does not terminate it. Creation settings such as the image, environment, and working directory do not reconfigure a container attached by reference.

Pass a finite `timeout` to bound a command. Modal applies whole seconds, so fractional execution timeouts round up. Result collection allows up to 30 additional seconds for the SDK to return output after that deadline. Timeout errors include output that has been collected.

Modal has no per-command kill operation. Cancelling a call stops waiting locally; the command may continue until its server deadline or the container's lifetime ends. Cancelling creation can leave a container whose ID the caller did not receive; its server lifetime still applies.

Pydantic AI does not terminate containers. Terminating them, and choosing a `sandbox_timeout` that reaps the ones you lose track of, is the application's job. `ModalSandbox.get_workspace` performs no I/O, so a backend can be rebuilt from a `WorkspaceRef` wherever the run continues, including under a durable execution engine; the reference carries no credentials, so each worker needs its own Modal configuration. See [Workspaces](https://pydantic.dev/docs/ai/core-concepts/workspace/) for how a run selects and restores its workspace.

The capability emits no additional telemetry spans. Core agent and tool spans cover the calls made through tools; provider-specific diagnostics remain available through Modal.

## Upgrading from the previous `ModalSandbox`

Earlier releases shipped a `ModalSandbox` that registered its own `run_command`, `read_file`, `write_file`, and `list_directory` tools and terminated its sandbox when the run ended. The capability now only supplies the sandbox as `ctx.workspace`: it registers no tools and adds no instructions. Passing one of the previous constructor arguments raises a `UserError`, and importing one of the removed names raises an `ImportError`; both name the replacement.

`ModalSandbox(image=...)` on its own still builds, but the model then has no tool that reaches the sandbox. The first run whose tools include none of the `Shell` or `FileSystem` tool names emits a `UserWarning`, once per process. If your own tools use `ctx.workspace` under other names, silence it with ``warnings.filterwarnings('ignore', message='`ModalSandbox` supplies')``.

### What changed in the lifecycle

- A run no longer terminates the sandbox when it ends. The sandbox runs until you terminate it or its `sandbox_timeout` expires.
- A run that continues a `message_history` reattaches to the sandbox the previous run used. Pass `workspace='new'` to `agent.run()` to start a fresh sandbox instead.
- If the sandbox being reattached has expired or was terminated, the first workspace operation raises `WorkspaceUnavailableError`. No empty replacement is created.
- To terminate the sandbox a run used, take the backend from `result.workspace` and terminate its Modal handle:

```python
from pydantic_ai import Agent
from pydantic_ai_harness.modal_sandbox import ModalSandbox, ModalSandboxBackend
from pydantic_ai_harness.shell import Shell

agent = Agent('anthropic:claude-sonnet-4-6', capabilities=[ModalSandbox(), Shell()])

async def run_once(prompt: str) -> str:
    result = await agent.run(prompt)
    backend = result.workspace.backend
    # `ref` is `None` when the run never touched the sandbox; `get_client()` would create one.
    if isinstance(backend, ModalSandboxBackend) and backend.ref is not None:
        sandbox = await backend.get_client()
        await sandbox.terminate.aio()
    return result.output
```

### Migration table

| Previous API | Now |
| --- | --- |
| `image`, `app_name`, `create_app_if_missing`, `env` | Unchanged; they configure a newly created sandbox. |
| `sandbox_timeout` | Unchanged. It also bounds every command, since a command cannot outlive the sandbox. |
| `workdir` | Unchanged; must be an absolute path. |
| `sandbox_id` | Removed. Use `agent.run(..., workspace=WorkspaceRef(provider='modal', id=sandbox_id))`. |
| `session` | Removed. Pass `ModalSandboxBackend(workspace=<modal.Sandbox>)` as `workspace=` to `agent.run()`. |
| `default_command_timeout` | Removed. Use `Shell(default_timeout=...)`. |
| `max_command_timeout` | Removed, no replacement. `sandbox_timeout` bounds every command. |
| `max_output_bytes`, `max_output_lines` | Removed. Use `Shell(max_output_chars=...)`, or `ToolOutputLimits` for any tool. |
| `max_read_bytes` | Removed. Use `FileSystem(max_read_lines=..., max_read_chars=...)`. |
| `instructions` | Removed. Put guidance in the agent's `instructions`. |
| `run_command` tool | Removed. Add `Shell()`. |
| `read_file`, `write_file`, `list_directory` tools | Removed. Add `FileSystem()`. |
| `ModalSandboxSession` | Removed. Use `ModalSandboxBackend(workspace=<modal.Sandbox>)` passed as `workspace=`. |
| `ModalSandboxExecResult` | Removed. `backend.run(...)` returns `pydantic_ai.workspaces.CommandResult`. |
| `ModalSandboxError` | Removed. Catch `pydantic_ai.workspaces.WorkspaceError`. |
| `ModalSandboxTerminalError`, `ModalSandboxUnavailableError`, `ModalSandboxAuthError` | Removed. Catch `pydantic_ai.workspaces.WorkspaceUnavailableError`. |

## API reference

::: pydantic_ai_harness.modal_sandbox.ModalSandbox

::: pydantic_ai_harness.modal_sandbox.ModalSandboxBackend
