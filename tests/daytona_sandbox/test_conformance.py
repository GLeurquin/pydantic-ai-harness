"""Pydantic AI's workspace backend conformance suite, run against `DaytonaSandboxBackend`.

`TestFakeDaytonaSandboxBackend` runs everywhere, over the fake Daytona SDK in host mode, where
commands and file operations act on a temporary host directory. `TestLiveDaytonaSandboxBackend`
runs the same rules against a real sandbox and is gated like `test_daytona_live.py`.
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable, Iterator
from pathlib import Path

import pytest
from pydantic_ai.workspaces import WorkspaceBackend, WorkspaceRef
from pydantic_ai.workspaces.testing import WorkspaceBackendSuite

from pydantic_ai_harness.daytona_sandbox import DaytonaSandboxBackend

from .fake_daytona import FakeDaytona

_live_enabled = os.getenv('PYDANTIC_AI_HARNESS_DAYTONA_LIVE') == '1'


def _attach(ref: WorkspaceRef) -> WorkspaceBackend:
    return DaytonaSandboxBackend(ref=ref)


async def _delete(backend: WorkspaceBackend) -> None:
    assert isinstance(backend, DaytonaSandboxBackend)
    sandbox = await backend.get_client()
    await sandbox.delete()


class TestFakeDaytonaSandboxBackend(WorkspaceBackendSuite):
    @pytest.fixture
    def backend(self, fake_daytona: FakeDaytona, tmp_path: Path) -> DaytonaSandboxBackend:
        # Resolved so the working directory `pwd -P` reports matches it on hosts whose temp
        # directory sits behind a symlink.
        fake_daytona.host_root = tmp_path.resolve()
        return DaytonaSandboxBackend()

    @pytest.fixture
    def attach_backend(self) -> Callable[[WorkspaceRef], WorkspaceBackend]:
        return _attach

    @pytest.fixture
    def destroy_environment(self) -> Callable[[WorkspaceBackend], Awaitable[None]]:
        return _delete


@pytest.mark.daytona_live
@pytest.mark.skipif(
    not _live_enabled or not os.getenv('DAYTONA_API_KEY'),
    reason='requires PYDANTIC_AI_HARNESS_DAYTONA_LIVE=1 and DAYTONA_API_KEY',
)
class TestLiveDaytonaSandboxBackend(WorkspaceBackendSuite):  # pragma: no cover - live tier runs without coverage
    # One event loop for the class: the class-scoped backend's `AsyncDaytona` client holds an
    # HTTP session bound to the loop it was created on.
    @pytest.fixture(scope='class')
    @classmethod
    def anyio_backend(cls) -> str:
        return 'asyncio'

    # Class-scoped so the rules share one sandbox instead of starting one each; the suite runs
    # its destroy rule last. The teardown uses Daytona's blocking client because a class-scoped
    # fixture outlives each test's event loop.
    @pytest.fixture(scope='class')
    @classmethod
    def backend(cls) -> Iterator[DaytonaSandboxBackend]:
        backend = DaytonaSandboxBackend(auto_stop_minutes=15)
        yield backend
        if backend.ref is not None:
            import daytona  # noqa: PLC0415 - optional extra, absent on slim installs

            try:
                sandbox = daytona.Daytona().get(backend.ref.id)
            except daytona.DaytonaNotFoundError:
                return
            # The destroy rule normally deleted it already; a second delete is not needed.
            if sandbox.state not in (daytona.SandboxState.DESTROYING, daytona.SandboxState.DESTROYED):
                sandbox.delete()

    @pytest.fixture
    def attach_backend(self) -> Callable[[WorkspaceRef], WorkspaceBackend]:
        return _attach

    @pytest.fixture
    def destroy_environment(self) -> Callable[[WorkspaceBackend], Awaitable[None]]:
        return _delete
