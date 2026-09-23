"""A Daytona sandbox behind Pydantic AI's `WorkspaceBackend` protocol.

External assumptions last verified 2026-09-08 against Daytona Python SDK 0.198.0:

* `AsyncDaytona.create`, `get`, and `close` and `AsyncSandbox.start` cover the lifecycle used
  here; `get` accepts a sandbox ID or name:
  https://www.daytona.io/docs/en/python-sdk/async/async-daytona/
* process sessions provide asynchronous execution, separate stdout and stderr callbacks,
  exit status, and deletion as the per-command kill mechanism:
  https://www.daytona.io/docs/en/python-sdk/async/async-process/
* `sandbox.fs` provides metadata, byte upload/download, and directory operations:
  https://www.daytona.io/docs/en/python-sdk/async/async-file-system/
* `auto_stop_interval` and `auto_delete_interval=-1` keep an owned sandbox stopped but
  available until explicit deletion:
  https://www.daytona.io/docs/en/python-sdk/async/async-daytona/

Re-check those sources and the installed 0.198.0 signatures before changing lifecycle,
command, or filesystem handling.
"""

from __future__ import annotations

import asyncio
import functools
import math
import posixpath
import shlex
import uuid
from collections.abc import AsyncGenerator, Awaitable, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING

import anyio
from pydantic_ai.workspaces import (
    CommandResult,
    FileEntry,
    SupportsCommands,
    SupportsFilesystem,
    WorkspaceBackend,
    WorkspaceError,
    WorkspaceRef,
    WorkspaceTimeoutError,
    WorkspaceUnavailableError,
)

from pydantic_ai_harness._workspace_provider import absolute_path

if TYPE_CHECKING:
    from daytona import AsyncDaytona, AsyncSandbox

    # Not re-exported at the package root; typing-only, so the private path never runs.
    from daytona._async.process import AsyncProcess
    from pydantic_ai.workspaces import WorkspaceCommand

__all__ = ('DaytonaSandboxBackend',)

DEFAULT_AUTO_STOP_MINUTES = 60

try:
    import daytona
except ImportError as error:  # pragma: no cover - exercised by the isolated missing-extra test
    raise ImportError('Install `pydantic-ai-harness[daytona]` to use DaytonaSandbox.') from error

_AUTH_MESSAGE = 'Daytona rejected the credentials. Set DAYTONA_API_KEY and try again.'
# Bound sandbox acquisition so a wedged control plane cannot hang creation or connection.
_CREATE_TIMEOUT = 120
# Bound routine SDK requests so a stalled control plane cannot hang an operation.
_REQUEST_TIMEOUT = 30
# Bound provider lifecycle RPCs such as create, start, and delete.
_LIFECYCLE_TIMEOUT = 60.0
# Bound cleanup RPCs so teardown cannot wedge the caller.
_TEARDOWN_TIMEOUT = 30.0


async def cleanup_call(call: Callable[[], Awaitable[object]], *, timeout: float) -> BaseException | None:
    try:
        with anyio.fail_after(timeout):
            await call()
    except BaseException as error:
        return error
    return None


def _command_line(command: WorkspaceCommand, shell: bool) -> str:
    if shell:
        if not isinstance(command, str):
            raise TypeError('an argv sequence cannot be combined with shell=True; pass a single command string')
        return command
    if isinstance(command, str):
        raise TypeError('a string command requires shell=True; pass an argv sequence otherwise')
    if not command:
        raise TypeError('a command needs at least the program to run; the argv sequence is empty')
    return shlex.join(command)


def _command_context(command: str, cwd: str | None, env: Mapping[str, str] | None) -> str:
    """Apply command-local settings that Daytona's session request cannot represent."""
    if env:
        assignments = ' '.join(shlex.quote(f'{name}={value}') for name, value in env.items())
        command = f'env -- {assignments} sh -c {shlex.quote(command)}'
    if cwd is not None:
        command = f'cd -- {shlex.quote(cwd)} && {command}'
    return command


@dataclass(kw_only=True)
class _DaytonaProcess:
    """Output and session identity for a single command."""

    _process: AsyncProcess
    _sandbox: AsyncSandbox
    _session_id: str
    _command_id: str
    stdout: list[str]
    stderr: list[str]
    _logs: asyncio.Task[None]

    async def wait(self) -> CommandResult:
        try:
            await self._logs
            command = await self._process.get_session_command(
                self._session_id, self._command_id, request_timeout=_REQUEST_TIMEOUT
            )
        except Exception as error:
            raise await _classified_error(
                self._sandbox, error, 'Could not read the command result', unavailable=True
            ) from error
        if command.exit_code is None:
            raise WorkspaceError('Daytona closed the command output before reporting an exit status.')
        result = CommandResult(
            exit_code=command.exit_code,
            stdout=''.join(self.stdout),
            stderr=''.join(self.stderr),
        )
        return result

    async def kill(self) -> None:
        """Delete the Daytona process session, which kills its command."""
        error = await cleanup_call(
            functools.partial(self._process.delete_session, self._session_id, request_timeout=_REQUEST_TIMEOUT),
            timeout=_TEARDOWN_TIMEOUT,
        )
        self._logs.cancel()
        with anyio.CancelScope(shield=True):
            await asyncio.gather(self._logs, return_exceptions=True)
        if error is None or isinstance(error, daytona.DaytonaNotFoundError):
            return
        if isinstance(error, Exception):
            raise _operation_error(
                error, f'Could not kill command session {self._session_id!r}', unavailable=True
            ) from error
        raise error  # pragma: no cover - cancellation propagates after bounded session cleanup


async def _kill_quietly(process: _DaytonaProcess) -> None:
    """Best-effort kill whose failure must not mask the outcome being raised."""
    try:
        await process.kill()
    except Exception:
        pass


class DaytonaSandboxBackend(WorkspaceBackend, SupportsCommands, SupportsFilesystem):
    """A [Daytona](https://www.daytona.io) sandbox as a Pydantic AI [`WorkspaceBackend`][pydantic_ai.workspaces.WorkspaceBackend].

    Commands and file operations run inside a Daytona sandbox, so the host is never exposed.

    Building one does no I/O. The first operation creates or attaches to a sandbox, and the typed
    `daytona.AsyncSandbox` is available through `get_client()`. The backend does not stop or
    delete the sandbox; that is the application's job, through the native handle.

    Commands run in Daytona process sessions, with complete output returned after they finish.
    An argv sequence is shell-quoted into one command string. The deadline is enforced
    client-side, and the session is deleted, which kills its command, when the deadline expires or
    the caller is cancelled.

    Daytona answers a request for a missing path and a request to a deleted sandbox with the same
    not-found error, so a not-found answer is followed by one control-plane lookup of the sandbox:
    a missing path raises `FileNotFoundError`, a deleted sandbox raises `WorkspaceUnavailableError`.

    The protocol is structural, but subclassing it here makes a signature drift fail the type
    check on this class instead of at a distant workspace call.

    Args:
        workspace: A live `daytona.AsyncSandbox` you already have. Whoever created it owns deleting it.
        client: A `daytona.AsyncDaytona` API client to create or attach with. The caller owns closing
            it. Without one, the backend creates its own from the environment and closes it only
            when creating or attaching fails.
        ref: Identity of an existing sandbox to attach to on first use.
        name: Daytona name for a newly created sandbox. It is not used to find a sandbox when `ref`
            is absent.
        snapshot: Daytona snapshot a newly created sandbox starts from; Daytona's default when `None`.
        auto_stop_minutes: Idle minutes before Daytona stops a newly created sandbox; `0` disables it.
        working_dir: Absolute directory commands start in; the sandbox's own default when `None`,
            discovered with `pwd -P` on first use.
        env: Environment variables set for the whole sandbox at creation.
        network_block_all: Whether a newly created sandbox is blocked from outbound network access.
    """

    def __init__(
        self,
        *,
        workspace: AsyncSandbox | None = None,
        client: AsyncDaytona | None = None,
        ref: WorkspaceRef | None = None,
        name: str | None = None,
        snapshot: str | None = None,
        auto_stop_minutes: int = DEFAULT_AUTO_STOP_MINUTES,
        working_dir: str | None = None,
        env: Mapping[str, str] | None = None,
        network_block_all: bool = False,
    ) -> None:
        if ref is not None and ref.provider != 'daytona':
            raise ValueError(f"unsupported workspace provider {ref.provider!r}; expected 'daytona'")
        if workspace is not None and ref is not None:
            raise ValueError('pass either `workspace` or `ref`, not both')
        self._workspace = workspace
        self._ref = ref if workspace is None else WorkspaceRef(provider='daytona', id=workspace.id)
        self._client = client
        self._owns_client = client is None
        self._name = name
        self._snapshot = snapshot
        self._auto_stop_minutes = auto_stop_minutes
        self._env = dict(env) if env is not None else None
        self._network_block_all = network_block_all
        self._canonical_working_dir: str | None = None
        self._working_dir = absolute_path('working_dir', working_dir)
        self._lock = anyio.Lock()

    @property
    def ref(self) -> WorkspaceRef | None:
        """Identity of the sandbox, or `None` before one has been created.

        The `id` is always Daytona's sandbox ID. Attaching by a `ref` whose `id` is a sandbox name
        also works, since Daytona looks sandboxes up by ID or name, and the ref is then rewritten to
        the ID so it stays valid if the sandbox is renamed.
        """
        return self._ref

    async def get_client(self) -> AsyncSandbox:
        """Return the typed `daytona.AsyncSandbox`, creating or attaching to it on first use.

        This is the sandbox handle, not the `AsyncDaytona` API client passed as `client=`.

        The only place `_client` and `_workspace` are read, so nothing can reach an
        unhydrated one: both stay optional and every other method comes through here.
        The lock serializes concurrent first uses -- two callers each creating a sandbox
        would leave the loser billed and unreferenced. A failed acquisition releases an
        API client this backend owns, so a retry starts from a clean one. Attaching by `ref`
        to a sandbox that no longer exists raises `WorkspaceUnavailableError`; it does not
        create a replacement.
        """
        async with self._lock:
            if (workspace := self._workspace) is not None:
                return workspace

            client = self._client
            if client is None:
                client = daytona.AsyncDaytona()
                self._client = client

            ref = self._ref
            try:
                workspace = await self._attach(client, ref.id) if ref is not None else await self._create(client)
            except BaseException:
                await self._close_owned_client()
                raise

            self._workspace = workspace
            # `client.get` also accepts a name; record the ID it resolved to.
            self._ref = WorkspaceRef(provider='daytona', id=workspace.id)
            return workspace

    async def read_bytes(self, path: str) -> bytes:
        sandbox = await self.get_client()
        async with _translated_filesystem_error(sandbox, path):
            try:
                return await sandbox.fs.download_file(path, _REQUEST_TIMEOUT)
            except daytona.DaytonaError as error:
                if isinstance(error, daytona.DaytonaNotFoundError):
                    raise
                # The toolbox's answer for reading a directory is not a documented error type; the
                # entry type tells it apart from other failures.
                if (await sandbox.fs.get_file_info(path, request_timeout=_REQUEST_TIMEOUT)).is_dir:
                    raise IsADirectoryError(f'Is a directory in the Daytona sandbox: {path!r}') from error
                raise

    async def write_bytes(self, path: str, data: bytes) -> None:
        sandbox = await self.get_client()
        parent = posixpath.dirname(path)
        async with _translated_filesystem_error(sandbox, path):
            if parent not in ('', '.', '/'):
                try:
                    mkdir = await sandbox.process.exec(f'mkdir -p -- {shlex.quote(parent)}', timeout=_REQUEST_TIMEOUT)
                except Exception as error:
                    raise await _classified_error(
                        sandbox, error, f'Could not create {parent!r}', unavailable=True
                    ) from error
                if mkdir.exit_code != 0:
                    raise WorkspaceError(mkdir.result or f'Could not create {parent!r}.')
            await sandbox.fs.upload_file(data, path, timeout=_REQUEST_TIMEOUT)

    async def stat(self, path: str) -> FileEntry:
        sandbox = await self.get_client()
        async with _translated_filesystem_error(sandbox, path):
            entry = await sandbox.fs.get_file_info(path, request_timeout=_REQUEST_TIMEOUT)
        return FileEntry(
            name=posixpath.basename(path.rstrip('/')),
            path=path,
            is_dir=entry.is_dir,
            size=None if entry.is_dir else entry.size,
        )

    async def list_dir(self, path: str) -> Sequence[FileEntry]:
        sandbox = await self.get_client()
        async with _translated_filesystem_error(sandbox, path):
            entries = await sandbox.fs.list_files(path, request_timeout=_REQUEST_TIMEOUT)
        return [
            FileEntry(
                name=entry.name,
                path=posixpath.join(path, entry.name),
                is_dir=entry.is_dir,
                size=None if entry.is_dir else entry.size,
            )
            for entry in entries
        ]

    async def make_dir(self, path: str) -> None:
        sandbox = await self.get_client()
        async with _translated_filesystem_error(sandbox, path):
            await sandbox.fs.create_folder(path, '755', request_timeout=_REQUEST_TIMEOUT)

    async def remove(self, path: str) -> None:
        sandbox = await self.get_client()
        async with _translated_filesystem_error(sandbox, path):
            # Whether the toolbox rejects removing a missing path is not documented; looking it up
            # first reports that as the protocol's `FileNotFoundError` either way.
            await sandbox.fs.get_file_info(path, request_timeout=_REQUEST_TIMEOUT)
            await sandbox.fs.delete_file(path, recursive=True, request_timeout=_REQUEST_TIMEOUT)

    async def exists(self, path: str) -> bool:
        sandbox = await self.get_client()
        try:
            await sandbox.fs.get_file_info(path, request_timeout=_REQUEST_TIMEOUT)
        except daytona.DaytonaNotFoundError as error:
            if await _is_gone(sandbox):
                raise WorkspaceUnavailableError(_gone_message(sandbox)) from error
            return False
        except Exception as error:
            raise await _classified_error(sandbox, error, f'Could not access {path!r} in the sandbox') from error
        return True

    async def _create(self, client: AsyncDaytona) -> AsyncSandbox:
        try:
            with anyio.fail_after(_CREATE_TIMEOUT):
                return await client.create(
                    daytona.CreateSandboxFromSnapshotParams(
                        name=self._name,
                        snapshot=self._snapshot,
                        env_vars=dict(self._env) if self._env is not None else None,
                        auto_stop_interval=self._auto_stop_minutes,
                        auto_delete_interval=-1,
                        network_block_all=self._network_block_all,
                    ),
                    timeout=_LIFECYCLE_TIMEOUT,
                )
        except TimeoutError as error:
            # `WorkspaceTimeoutError` is reserved for command deadlines; a stalled control plane is
            # a provider failure the caller may retry.
            raise WorkspaceError(
                f'Daytona workspace creation did not complete within {_CREATE_TIMEOUT}s; '
                'the Daytona control plane may be unreachable.'
            ) from error
        except Exception as error:
            raise _operation_error(error, 'Could not create Daytona workspace') from error

    async def _attach(self, client: AsyncDaytona, workspace_id: str) -> AsyncSandbox:
        """Attach to a sandbox that already exists, starting it if it is stopped.

        `delete()` returns once Daytona accepts the request, and the sandbox stays visible in the
        `destroying` state until it is gone, so that state counts as gone here rather than being
        started.
        """
        try:
            with anyio.fail_after(_CREATE_TIMEOUT):
                sandbox = await client.get(workspace_id, request_timeout=_REQUEST_TIMEOUT)
                if not _deleted(sandbox):
                    await sandbox.start(timeout=_LIFECYCLE_TIMEOUT)
        except TimeoutError as error:
            raise WorkspaceError(
                f'Daytona workspace connection did not complete within {_CREATE_TIMEOUT}s; '
                'the Daytona control plane may be unreachable.'
            ) from error
        except Exception as error:
            raise _operation_error(
                error, f'Could not connect to Daytona workspace {workspace_id!r}', unavailable=True
            ) from error
        if _deleted(sandbox):
            raise WorkspaceUnavailableError(_gone_message(sandbox))
        return sandbox

    async def _close_owned_client(self) -> None:
        if self._client is not None and self._owns_client:
            await self._client.close()
            self._client = None

    async def working_dir(self) -> str:
        """Return the filesystem-canonical default directory inside the workspace.

        A deleted sandbox raises `WorkspaceUnavailableError`, so this doubles as the check that the
        environment still exists.
        """
        if self._canonical_working_dir is None:
            sandbox = await self.get_client()
            try:
                result = await sandbox.process.exec('pwd -P', cwd=self._working_dir, timeout=_REQUEST_TIMEOUT)
            except Exception as error:
                raise await _classified_error(
                    sandbox, error, 'Could not determine the working directory', unavailable=True
                ) from error
            printed = result.result.removesuffix('\n')
            if result.exit_code != 0 or not posixpath.isabs(printed):
                raise WorkspaceError(f'Could not determine the working directory of Daytona sandbox {sandbox.id}.')
            self._canonical_working_dir = printed
        return self._canonical_working_dir

    async def run(
        self,
        command: WorkspaceCommand,
        *,
        shell: bool = False,
        cwd: str | None = None,
        env: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> CommandResult:
        if timeout is not None and (not math.isfinite(timeout) or timeout <= 0):
            raise ValueError(f'timeout must be a positive finite number or None, got {timeout!r}.')
        process: _DaytonaProcess | None = None
        with anyio.move_on_after(timeout) as scope:
            try:
                process = await self._start(command, shell=shell, cwd=cwd, env=env)
                return await process.wait()
            finally:
                if process is not None:
                    await _kill_quietly(process)
        assert scope.cancel_called
        raise WorkspaceTimeoutError(
            f'Command timed out after {timeout:g} seconds.',
            stdout=''.join(process.stdout) if process is not None else '',
            stderr=''.join(process.stderr) if process is not None else '',
            timeout=timeout,
        )

    async def _start(
        self,
        command: WorkspaceCommand,
        *,
        shell: bool = False,
        cwd: str | None = None,
        env: Mapping[str, str] | None = None,
    ) -> _DaytonaProcess:
        line = _command_context(
            _command_line(command, shell), absolute_path('cwd', cwd) if cwd is not None else self._working_dir, env
        )
        session_id = f'pydantic-ai-{uuid.uuid4().hex}'
        sandbox = await self.get_client()
        process = sandbox.process
        created = False
        try:
            with anyio.fail_after(_REQUEST_TIMEOUT):
                await process.create_session(session_id, request_timeout=_REQUEST_TIMEOUT)
                created = True
                response = await process.execute_session_command(
                    session_id,
                    daytona.SessionExecuteRequest(command=line, run_async=True),
                    timeout=_REQUEST_TIMEOUT,
                )
        except BaseException as error:
            if created:
                await cleanup_call(
                    functools.partial(process.delete_session, session_id, request_timeout=_REQUEST_TIMEOUT),
                    timeout=_TEARDOWN_TIMEOUT,
                )
            if isinstance(error, TimeoutError):
                raise WorkspaceError('Daytona command session setup timed out.') from error
            if isinstance(error, Exception):
                raise await _classified_error(sandbox, error, 'Could not start command', unavailable=True) from error
            raise  # pragma: no cover - cancellation propagates after bounded session cleanup
        stdout: list[str] = []
        stderr: list[str] = []
        logs = asyncio.create_task(
            process.get_session_command_logs_async(session_id, response.cmd_id, stdout.append, stderr.append)
        )
        return _DaytonaProcess(
            _process=process,
            _sandbox=sandbox,
            _session_id=session_id,
            _command_id=response.cmd_id,
            stdout=stdout,
            stderr=stderr,
            _logs=logs,
        )


def _deleted(sandbox: AsyncSandbox) -> bool:
    return sandbox.state in (daytona.SandboxState.DESTROYING, daytona.SandboxState.DESTROYED)


def _gone_message(sandbox: AsyncSandbox) -> str:
    return (
        f'The Daytona sandbox {sandbox.id!r} no longer exists (it was deleted). '
        'Attach to a live sandbox, or create a new one.'
    )


async def _is_gone(sandbox: AsyncSandbox) -> bool:
    """Ask the control plane whether the sandbox was deleted.

    Only called after a failure, so successful operations make no extra request. An inconclusive
    lookup counts as alive, leaving the original error retryable.
    """
    try:
        with anyio.fail_after(_REQUEST_TIMEOUT):
            await sandbox.refresh_data(request_timeout=_REQUEST_TIMEOUT)
    except daytona.DaytonaNotFoundError:
        return True
    except Exception:
        return False
    return _deleted(sandbox)


@asynccontextmanager
async def _translated_filesystem_error(sandbox: AsyncSandbox, path: str) -> AsyncGenerator[None]:
    """Map Daytona's filesystem errors onto the ones the protocol promises."""
    try:
        yield
    except daytona.DaytonaNotFoundError as error:
        if await _is_gone(sandbox):
            raise WorkspaceUnavailableError(_gone_message(sandbox)) from error
        raise FileNotFoundError(f'No such file or directory in the Daytona sandbox: {path!r}') from error
    except (WorkspaceError, IsADirectoryError):
        raise
    except Exception as error:
        raise await _classified_error(sandbox, error, f'Could not access {path!r} in the sandbox') from error


async def _classified_error(
    sandbox: AsyncSandbox, error: Exception, context: str, *, unavailable: bool = False
) -> WorkspaceError:
    """Translate an SDK error, reporting a deleted sandbox as `WorkspaceUnavailableError`.

    With `unavailable=True`, a not-found answer means the sandbox itself is gone; the call named
    no path that could be missing.
    """
    translated = _operation_error(error, context, unavailable=unavailable)
    if not isinstance(translated, WorkspaceUnavailableError) and await _is_gone(sandbox):
        return WorkspaceUnavailableError(_gone_message(sandbox))
    return translated


def _operation_error(error: Exception, context: str, *, unavailable: bool = False) -> WorkspaceError:
    if isinstance(error, (daytona.DaytonaAuthenticationError, daytona.DaytonaAuthorizationError)):
        return WorkspaceUnavailableError(_AUTH_MESSAGE)
    if unavailable and isinstance(error, daytona.DaytonaNotFoundError):
        return WorkspaceUnavailableError(f'{context}: the workspace does not exist or is no longer available.')
    return WorkspaceError(f'{context}: {type(error).__name__}: {error}')
