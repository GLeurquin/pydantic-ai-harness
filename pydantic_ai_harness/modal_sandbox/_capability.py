"""Capability that supplies a Modal sandbox as an agent run's workspace."""

from __future__ import annotations

import posixpath
import warnings
from collections.abc import Mapping
from dataclasses import dataclass

from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.exceptions import UserError
from pydantic_ai.tools import AgentDepsT, RunContext, ToolDefinition
from pydantic_ai.workspaces import WorkspaceBackend, WorkspaceRef
from typing_extensions import Never

from pydantic_ai_harness.modal_sandbox._backend import (
    DEFAULT_APP_NAME,
    DEFAULT_IMAGE,
    DEFAULT_SANDBOX_TIMEOUT,
    ModalSandboxBackend,
)

UPGRADE_DOCS_URL = 'https://pydantic.dev/docs/ai/harness/modal-sandbox/#upgrading-from-the-previous-modalsandbox'

# Constructor arguments of the previous `ModalSandbox`, which registered its own `run_command`,
# `read_file`, `write_file`, and `list_directory` tools, that have no counterpart now that the
# capability only supplies `ctx.workspace`. Each maps to the guidance for moving off it.
_LEGACY_ARGUMENTS: Mapping[str, str] = {
    'sandbox_id': (
        'attach to an existing sandbox per run instead: '
        "`agent.run(..., workspace=WorkspaceRef(provider='modal', id=sandbox_id))`. "
        'Later runs that continue the message history reattach to it without being told.'
    ),
    'session': (
        '`ModalSandboxSession` no longer exists. To share a sandbox you own across runs, pass '
        '`ModalSandboxBackend(workspace=<modal.Sandbox>)` (or its `WorkspaceRef`) as `workspace=` to '
        '`agent.run()`. The backend never terminates a sandbox; that stays your job.'
    ),
    'default_command_timeout': (
        'command timeouts belong to the tool that runs commands: use `Shell(default_timeout=...)`.'
    ),
    'max_command_timeout': (
        'the ceiling is gone; the sandbox lifetime (`sandbox_timeout`) bounds every command, and the '
        'model-facing default is `Shell(default_timeout=...)`.'
    ),
    'max_output_bytes': (
        'output limits belong to the tools: use `Shell(max_output_chars=...)`, or `ToolOutputLimits` for any tool.'
    ),
    'max_output_lines': (
        'output limits belong to the tools: use `Shell(max_output_chars=...)`, or `ToolOutputLimits` for any tool.'
    ),
    'max_read_bytes': 'file read limits belong to the tool: use `FileSystem(max_read_lines=..., max_read_chars=...)`.',
    'instructions': (
        'the capability no longer adds instructions; `Shell` and `FileSystem` describe their own tools, and any '
        "further guidance belongs in the agent's `instructions`."
    ),
}


# The tools of `Shell` and `FileSystem`, which run against `ctx.workspace`. A run with none of these
# names most likely has no way to reach the sandbox; custom tools by other names are not detected.
_WORKSPACE_TOOL_NAMES = frozenset(
    {
        'run_command',
        'start_command',
        'check_command',
        'stop_command',
        'shell',
        'read_file',
        'write_file',
        'edit_file',
        'list_directory',
        'search_files',
        'find_files',
        'create_directory',
        'file_info',
        'list_files',
        'grep',
    }
)

_NO_WORKSPACE_TOOLS_MESSAGE = (
    "`ModalSandbox` supplies the Modal sandbox as the run's `ctx.workspace` and registers no tools of its own, "
    'and this run has no `Shell` or `FileSystem` tool. Add `Shell()` and/or `FileSystem()` alongside it, or write '
    f'tools that use `ctx.workspace`. See {UPGRADE_DOCS_URL}'
)

_warned_no_workspace_tools = False


def _legacy_argument_message(names: list[str]) -> str:
    moves = '\n'.join(f'- `{name}`: {_LEGACY_ARGUMENTS[name]}' for name in names)
    listed = ', '.join(f'`{name}`' for name in names)
    return (
        f"`ModalSandbox` no longer accepts {listed}. It now supplies the Modal sandbox as the run's "
        '`ctx.workspace` and registers no tools of its own; add `Shell()` and/or `FileSystem()` alongside it '
        'to give the model command and file tools that run in the sandbox.\n'
        f'{moves}\n'
        f'See {UPGRADE_DOCS_URL}'
    )


@dataclass(kw_only=True, init=False)
class ModalSandbox(AbstractCapability[AgentDepsT]):
    """Supply a Modal sandbox as the run's workspace, through `ctx.workspace`.

    A run with an explicit `WorkspaceRef` attaches to that sandbox. Without a reference, the
    first workspace operation creates a fresh Modal sandbox. Pydantic AI does not terminate the
    sandbox; terminating it is the application's job.

    The capability registers no tools. Pair it with `Shell` and `FileSystem`, which run their tools
    against `ctx.workspace`, or write tools that use `ctx.workspace` directly. Constructor arguments
    of the previous `ModalSandbox`, which bundled its own tools, raise a `UserError` that says how to
    express each one now.
    """

    image: str = DEFAULT_IMAGE
    """Registry image used when creating a sandbox."""

    name: str | None = None
    """Optional Modal name used only when creating a sandbox."""

    app_name: str = DEFAULT_APP_NAME
    """Modal app used when creating a sandbox."""

    create_app_if_missing: bool = True
    """Whether Modal may create the app."""

    sandbox_timeout: int = DEFAULT_SANDBOX_TIMEOUT
    """Server-side lifetime for a newly created sandbox, in seconds."""

    workdir: str | None = None
    """Absolute working directory for a newly created sandbox."""

    env: Mapping[str, str] | None = None
    """Environment variables configured on a newly created sandbox."""

    def __init__(
        self,
        *,
        id: str | None = None,
        description: str | None = None,
        defer_loading: bool = False,
        image: str = DEFAULT_IMAGE,
        name: str | None = None,
        app_name: str = DEFAULT_APP_NAME,
        create_app_if_missing: bool = True,
        sandbox_timeout: int = DEFAULT_SANDBOX_TIMEOUT,
        workdir: str | None = None,
        env: Mapping[str, str] | None = None,
        **legacy: Never,
    ) -> None:
        # Hand-written, with the same parameters a dataclass would generate, so the previous
        # `ModalSandbox` arguments reach a message that says where each one went. `**legacy: Never`
        # keeps the static signature closed.
        if legacy:
            unknown = [argument for argument in legacy if argument not in _LEGACY_ARGUMENTS]
            if unknown:
                raise TypeError(f'ModalSandbox.__init__() got an unexpected keyword argument {unknown[0]!r}')
            raise UserError(_legacy_argument_message(list(legacy)))
        # Checked here rather than when the backend first creates a sandbox, so a bad value fails
        # where it is written instead of at the first workspace operation of some later run.
        if type(sandbox_timeout) is not int or sandbox_timeout <= 0:
            raise UserError(f'sandbox_timeout must be a positive integer, got {sandbox_timeout!r}.')
        if workdir is not None and not posixpath.isabs(workdir):
            raise UserError(f'workdir must be an absolute POSIX path or None, got {workdir!r}.')
        self.id = id
        self.description = description
        self.defer_loading = defer_loading
        self.image = image
        self.name = name
        self.app_name = app_name
        self.create_app_if_missing = create_app_if_missing
        self.sandbox_timeout = sandbox_timeout
        self.workdir = workdir
        self.env = env

    def get_workspace(self, ctx: RunContext[AgentDepsT], *, ref: WorkspaceRef | None) -> WorkspaceBackend | None:
        """Build a backend without performing Modal I/O."""
        del ctx
        if ref is not None and ref.provider != 'modal':
            return None
        return ModalSandboxBackend(
            ref=ref,
            name=self.name,
            image=self.image,
            app_name=self.app_name,
            create_app_if_missing=self.create_app_if_missing,
            sandbox_timeout=self.sandbox_timeout,
            workdir=self.workdir,
            env=self.env,
        )

    async def prepare_tools(self, ctx: RunContext[AgentDepsT], tool_defs: list[ToolDefinition]) -> list[ToolDefinition]:
        # The previous `ModalSandbox` registered its own tools, so `ModalSandbox(image=...)` on its
        # own still builds but now leaves the model without the sandbox. This is the earliest hook
        # that sees the run's tools; it warns once per process and never changes the tools.
        global _warned_no_workspace_tools
        if not _warned_no_workspace_tools and _WORKSPACE_TOOL_NAMES.isdisjoint(tool.name for tool in tool_defs):
            _warned_no_workspace_tools = True
            warnings.warn(_NO_WORKSPACE_TOOLS_MESSAGE, UserWarning, stacklevel=2)
        return tool_defs
