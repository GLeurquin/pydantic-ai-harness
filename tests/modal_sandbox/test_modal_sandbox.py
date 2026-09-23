"""Focused public tests for the Modal workspace capability."""

from __future__ import annotations

import sys
from typing import Any

import anyio
import pytest
from pydantic_ai import Agent
from pydantic_ai.exceptions import UserError
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext
from pydantic_ai.usage import RunUsage
from pydantic_ai.workspaces import (
    Workspace,
    WorkspaceError,
    WorkspaceRef,
    WorkspaceTimeoutError,
    WorkspaceUnavailableError,
)

import pydantic_ai_harness.modal_sandbox as modal_sandbox_package
from pydantic_ai_harness.modal_sandbox import ModalSandbox, ModalSandboxBackend

from .fake_modal import FakeModal

pytestmark = pytest.mark.anyio(backends=['asyncio'])


async def test_backend_acquires_fresh_workspace_and_records_ref(fake_modal: FakeModal) -> None:
    backend = ModalSandboxBackend()
    assert not fake_modal.sandboxes
    native = await backend.get_client()
    assert native is fake_modal.sandboxes[0]
    assert backend.ref == WorkspaceRef(provider='modal', id=native.object_id)


async def test_missing_modal_extra_has_install_hint(fake_modal: FakeModal, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, 'modal', None)
    with pytest.raises(WorkspaceError, match=r'pydantic-ai-harness\[modal\]'):
        await ModalSandboxBackend().get_client()


async def test_backend_attaches_explicit_ref_without_create(fake_modal: FakeModal) -> None:
    backend = ModalSandboxBackend(ref=WorkspaceRef(provider='modal', id='existing'))
    await backend.get_client()
    assert fake_modal.attach_ids == ['existing']
    assert not fake_modal.create_kwargs


@pytest.mark.parametrize('error_kind', ['auth', 'error'])
async def test_attach_failures_keep_reference_and_do_not_create(fake_modal: FakeModal, error_kind: str) -> None:
    fake_modal.attach_error = fake_modal.auth_type('bad') if error_kind == 'auth' else fake_modal.error_type('failed')
    backend = ModalSandboxBackend(ref=WorkspaceRef(provider='modal', id='existing'))
    with pytest.raises(WorkspaceUnavailableError if error_kind == 'auth' else WorkspaceError) as exc_info:
        await backend.get_client()
    assert backend.ref == WorkspaceRef(provider='modal', id='existing')
    assert not fake_modal.create_kwargs
    assert exc_info.value.__cause__ is fake_modal.attach_error


async def test_native_workspace_identity_is_immediate(fake_modal: FakeModal) -> None:
    native = await ModalSandboxBackend().get_client()
    backend = ModalSandboxBackend(workspace=native)
    assert backend.ref == WorkspaceRef(provider='modal', id=native.object_id)
    assert await backend.get_client() is native


async def test_native_workspace_and_ref_conflict(fake_modal: FakeModal) -> None:
    native = await ModalSandboxBackend().get_client()
    with pytest.raises(ValueError, match='either `workspace` or `ref`'):
        ModalSandboxBackend(workspace=native, ref=WorkspaceRef(provider='modal', id='other'))


async def test_filesystem_directory_error_uses_builtin_exception(fake_modal: FakeModal) -> None:
    backend = ModalSandboxBackend()
    await backend.get_client()
    fake_modal.sandboxes[0].directories.add('/directory')
    with pytest.raises(IsADirectoryError, match='Is a directory'):
        await backend.read_bytes('/directory')


async def test_filesystem_not_directory_error_uses_builtin_exception(fake_modal: FakeModal) -> None:
    backend = ModalSandboxBackend()
    await backend.get_client()
    fake_modal.sandboxes[0].fs_error = fake_modal.module.exception.SandboxFilesystemNotADirectoryError('file')
    with pytest.raises(NotADirectoryError, match='Not a directory'):
        await backend.read_bytes('/file/child')


async def test_command_start_timeout_is_bounded(fake_modal: FakeModal) -> None:
    fake_modal.exec_hangs = True
    backend = ModalSandboxBackend()
    with pytest.raises(WorkspaceTimeoutError, match='before the command could start') as exc_info:
        with anyio.fail_after(0.2):
            await backend.run(['echo', 'hello'], timeout=0.01)
    assert exc_info.value.timeout == 0.01


async def test_create_timeout_is_bounded(fake_modal: FakeModal, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_modal.create_gate = anyio.Event()
    monkeypatch.setattr('pydantic_ai_harness.modal_sandbox._backend._CREATE_TIMEOUT', 0.01)
    backend = ModalSandboxBackend()
    with pytest.raises(WorkspaceError, match='control plane'):
        await backend.get_client()
    assert backend.ref is None
    assert not fake_modal.sandboxes


async def test_command_timeout_bounds_acquisition(fake_modal: FakeModal) -> None:
    fake_modal.create_gate = anyio.Event()
    backend = ModalSandboxBackend()
    with pytest.raises(WorkspaceTimeoutError) as exc_info:
        await backend.run(['echo', 'hello'], timeout=0.01)
    assert exc_info.value.timeout == 0.01
    assert backend.ref is None
    assert not fake_modal.sandboxes


async def test_command_timeout_keeps_captured_output(fake_modal: FakeModal, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr('pydantic_ai_harness.modal_sandbox._backend._RESULT_GRACE', 0.01)
    fake_modal.responder = lambda argv, timeout: ('partial stdout', 'partial stderr', 0)
    fake_modal.wait_hangs = True
    backend = ModalSandboxBackend()
    with pytest.raises(WorkspaceTimeoutError) as exc_info:
        await backend.run(['echo', 'hello'], timeout=0.01)
    assert exc_info.value.stdout == 'partial stdout'
    assert exc_info.value.stderr == 'partial stderr'


async def test_command_timeout_keeps_completed_stderr_when_stdout_reader_hangs(
    fake_modal: FakeModal, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr('pydantic_ai_harness.modal_sandbox._backend._RESULT_GRACE', 0.01)
    fake_modal.responder = lambda argv, timeout: ('partial stdout', 'partial stderr', 0)
    fake_modal.stdout_hangs = True
    backend = ModalSandboxBackend()
    with pytest.raises(WorkspaceTimeoutError) as exc_info:
        await backend.run(['echo', 'hello'], timeout=0.01)
    assert exc_info.value.stdout == ''
    assert exc_info.value.stderr == 'partial stderr'


def test_capability_takes_the_base_class_options_and_the_creation_settings() -> None:
    capability = ModalSandbox(id='modal', description='a sandbox', image='python:3.13-slim', env={'A': '1'})
    assert (capability.id, capability.description, capability.defer_loading) == ('modal', 'a sandbox', False)
    assert capability == ModalSandbox(id='modal', description='a sandbox', image='python:3.13-slim', env={'A': '1'})
    assert capability.get_toolset() is None
    assert capability.get_instructions() is None


@pytest.mark.parametrize(
    ('legacy', 'guidance'),
    [
        ({'sandbox_id': 'sb-1'}, "workspace=WorkspaceRef(provider='modal', id=sandbox_id)"),
        ({'session': object()}, 'ModalSandboxBackend(workspace=<modal.Sandbox>)'),
        ({'default_command_timeout': 5.0}, 'Shell(default_timeout=...)'),
        ({'max_command_timeout': 60}, 'sandbox lifetime (`sandbox_timeout`) bounds every command'),
        ({'max_output_bytes': 1}, 'Shell(max_output_chars=...)'),
        ({'max_output_lines': 1}, 'ToolOutputLimits'),
        ({'max_read_bytes': 1}, 'FileSystem(max_read_lines=..., max_read_chars=...)'),
        ({'instructions': ''}, "belongs in the agent's `instructions`"),
    ],
)
def test_previous_constructor_arguments_are_refused_with_guidance(legacy: dict[str, Any], guidance: str) -> None:
    # The previous `ModalSandbox` bundled its own tools; each of its arguments now points at
    # where that setting lives, rather than failing as an unknown keyword.
    with pytest.raises(UserError) as exc_info:
        ModalSandbox(**legacy)  # pyright: ignore[reportArgumentType]
    message = str(exc_info.value)
    (name,) = legacy
    assert message.startswith(f'`ModalSandbox` no longer accepts `{name}`.')
    assert 'add `Shell()` and/or `FileSystem()`' in message
    assert f'- `{name}`: ' in message
    assert guidance in message
    assert message.endswith('#upgrading-from-the-previous-modalsandbox')


def test_several_previous_arguments_are_reported_together() -> None:
    with pytest.raises(UserError, match=r'no longer accepts `sandbox_id`, `instructions`') as exc_info:
        ModalSandbox(sandbox_id='sb-1', instructions='')  # pyright: ignore[reportArgumentType]
    assert str(exc_info.value).count('\n- `') == 2


def test_an_unknown_argument_is_still_a_type_error() -> None:
    with pytest.raises(TypeError, match="unexpected keyword argument 'imag'"):
        ModalSandbox(imag='python:3.13-slim')  # pyright: ignore[reportArgumentType]


async def test_capability_declines_foreign_ref(fake_modal: FakeModal) -> None:
    capability = ModalSandbox()
    ctx = RunContext(deps=None, model=TestModel(), usage=RunUsage())
    assert capability.get_workspace(ctx, ref=WorkspaceRef(provider='other', id='foreign')) is None
    assert not fake_modal.sandboxes


async def test_backend_rejects_foreign_ref(fake_modal: FakeModal) -> None:
    with pytest.raises(ValueError, match="expected 'modal'"):
        ModalSandboxBackend(ref=WorkspaceRef(provider='other', id='foreign'))
    assert not fake_modal.sandboxes


async def test_agent_without_workspace_tool_does_not_create(fake_modal: FakeModal) -> None:
    agent = Agent(TestModel(), capabilities=[ModalSandbox()])
    result = await agent.run('go')
    assert result.output
    assert not fake_modal.sandboxes


async def test_agent_runs_without_history_create_fresh_workspaces(fake_modal: FakeModal) -> None:
    agent = Agent(TestModel(call_tools=['run_command']), capabilities=[ModalSandbox()])

    @agent.tool
    async def run_command(ctx: RunContext[object]) -> str:
        return (await ctx.workspace.run(['printf', 'ok'])).stdout

    await agent.run('go')
    await agent.run('go')
    assert len(fake_modal.sandboxes) == 2


async def test_agent_history_attaches_same_workspace(fake_modal: FakeModal) -> None:
    def model(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        request = messages[-1]
        if isinstance(request, ModelRequest) and any(isinstance(part, ToolReturnPart) for part in request.parts):
            return ModelResponse(parts=[TextPart(content='done')])
        return ModelResponse(parts=[ToolCallPart(tool_name='run_command', args={}, tool_call_id='call')])

    agent = Agent(FunctionModel(model), capabilities=[ModalSandbox()])
    tool_results: list[str] = []

    @agent.tool
    async def run_command(ctx: RunContext[object]) -> str:
        if await ctx.workspace.exists('/marker.txt'):
            result = await ctx.workspace.read_text('/marker.txt')
        else:
            await ctx.workspace.write_text('/marker.txt', 'persisted')
            result = 'created'
        tool_results.append(result)
        return result

    first = await agent.run('go')
    second = await agent.run('go', message_history=first.all_messages())
    assert first.output == 'done'
    assert second.output == 'done'
    assert tool_results == ['created', 'persisted']
    assert len(fake_modal.sandboxes) == 1
    assert first.workspace.ref is not None
    assert fake_modal.attach_ids == [first.workspace.ref.id]


async def test_concurrent_operations_share_one_acquisition(fake_modal: FakeModal) -> None:
    backend = ModalSandboxBackend()
    fake_modal.create_gate = anyio.Event()

    async with anyio.create_task_group() as tg:
        tg.start_soon(backend.run, ['printf', 'one'])
        tg.start_soon(backend.run, ['printf', 'two'])
        while not fake_modal.create_started:
            await anyio.sleep(0)
        fake_modal.create_gate.set()
    assert fake_modal.owned_creates == 1
    assert len(fake_modal.sandboxes[0].exec_calls) == 2


async def test_filesystem_operation_is_not_blocked_by_command_wait(
    fake_modal: FakeModal,
) -> None:
    fake_modal.wait_hangs = True
    backend = ModalSandboxBackend()
    async with anyio.create_task_group() as tg:
        tg.start_soon(backend.run, ['sleep', '1'])
        while not fake_modal.sandboxes:
            await anyio.sleep(0)
        fake_modal.sandboxes[0].files['/marker.txt'] = b'marker'
        with anyio.fail_after(0.2):
            assert await Workspace(backend).read_text('/marker.txt') == 'marker'
        tg.cancel_scope.cancel()


async def test_failed_acquisition_can_retry(fake_modal: FakeModal) -> None:
    backend = ModalSandboxBackend()
    fake_modal.create_error = fake_modal.error_type('temporary')
    with pytest.raises(WorkspaceError):
        await backend.get_client()
    fake_modal.create_error = None
    await backend.get_client()
    assert fake_modal.owned_creates == 1


async def test_cancelled_acquisition_can_retry(fake_modal: FakeModal) -> None:
    backend = ModalSandboxBackend()
    fake_modal.create_gate = anyio.Event()

    async def acquire() -> None:
        await backend.get_client()

    with anyio.CancelScope() as scope:
        async with anyio.create_task_group() as tg:
            tg.start_soon(acquire)
            while not fake_modal.create_started:
                await anyio.sleep(0)
            scope.cancel()
            fake_modal.create_gate.set()
    fake_modal.create_gate = None
    await backend.get_client()
    assert fake_modal.owned_creates == 1


async def test_agent_uses_modal_sandbox(fake_modal: FakeModal) -> None:
    agent = Agent(TestModel(call_tools=['run_command']), capabilities=[ModalSandbox()])

    @agent.tool
    async def run_command(ctx: RunContext[object]) -> str:
        result = await ctx.workspace.run(['printf', 'hello'])
        return result.stdout

    result = await agent.run('go')
    assert 'run_command' in result.output
    assert fake_modal.sandboxes[0].exec_calls[0].argv == ['printf', 'hello']


@pytest.mark.parametrize(
    ('name', 'replacement'),
    [
        ('ModalSandboxSession', 'ModalSandboxBackend(workspace=<modal.Sandbox>)'),
        ('ModalSandboxExecResult', 'pydantic_ai.workspaces.CommandResult'),
        ('ModalSandboxError', 'pydantic_ai.workspaces.WorkspaceError'),
        ('ModalSandboxTerminalError', 'pydantic_ai.workspaces.WorkspaceUnavailableError'),
        ('ModalSandboxUnavailableError', 'pydantic_ai.workspaces.WorkspaceUnavailableError'),
        ('ModalSandboxAuthError', 'pydantic_ai.workspaces.WorkspaceUnavailableError'),
    ],
)
def test_removed_names_raise_import_error_naming_the_replacement(name: str, replacement: str) -> None:
    with pytest.raises(ImportError) as exc_info:
        getattr(modal_sandbox_package, name)
    message = str(exc_info.value)
    assert message.startswith(f'`{name}` was removed from `pydantic_ai_harness.modal_sandbox`.')
    assert replacement in message
    assert message.endswith('#upgrading-from-the-previous-modalsandbox')
    assert exc_info.value.name == name


def test_removed_name_fails_a_from_import_with_the_guidance() -> None:
    with pytest.raises(ImportError, match='ModalSandboxBackend'):
        from pydantic_ai_harness.modal_sandbox import ModalSandboxSession  # noqa: F401, I001, PLC0415  # pyright: ignore[reportUnusedImport]


def test_other_missing_names_are_attribute_errors() -> None:
    with pytest.raises(AttributeError, match="has no attribute 'ModalSandboxTypo'"):
        getattr(modal_sandbox_package, 'ModalSandboxTypo')


@pytest.mark.parametrize('sandbox_timeout', [0, -5, 1.5, True])
def test_sandbox_timeout_must_be_a_positive_integer(sandbox_timeout: Any) -> None:
    with pytest.raises(UserError, match=rf'sandbox_timeout must be a positive integer, got {sandbox_timeout!r}\.'):
        ModalSandbox(sandbox_timeout=sandbox_timeout)


@pytest.mark.parametrize('workdir', ['relative/dir', '', 'C:\\work'])
def test_workdir_must_be_an_absolute_posix_path(workdir: str) -> None:
    with pytest.raises(UserError, match='workdir must be an absolute POSIX path or None'):
        ModalSandbox(workdir=workdir)


def test_valid_creation_settings_are_accepted() -> None:
    capability = ModalSandbox(sandbox_timeout=1, workdir='/work')
    assert (capability.sandbox_timeout, capability.workdir) == (1, '/work')
