"""Pydantic AI's workspace backend conformance suite, run against `ModalSandboxBackend`.

`TestFakeModalSandboxBackend` runs everywhere, over the fake Modal SDK in host mode, where
commands and file operations act on a temporary host directory. `TestLiveModalSandboxBackend`
runs the same rules against a real sandbox and is gated like `test_modal_live.py`.
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable, Iterator
from pathlib import Path

import pytest
from pydantic_ai.workspaces import WorkspaceBackend, WorkspaceRef
from pydantic_ai.workspaces.testing import WorkspaceBackendSuite

from pydantic_ai_harness.modal_sandbox import ModalSandboxBackend

from .fake_modal import FakeModal

_live_enabled = os.getenv('PYDANTIC_AI_HARNESS_MODAL_LIVE') == '1'
_live_credentials = (os.getenv('MODAL_TOKEN_ID') is not None and os.getenv('MODAL_TOKEN_SECRET') is not None) or Path(
    '~/.modal.toml'
).expanduser().exists()


def _attach(ref: WorkspaceRef) -> WorkspaceBackend:
    return ModalSandboxBackend(ref=ref)


async def _terminate(backend: WorkspaceBackend) -> None:
    assert isinstance(backend, ModalSandboxBackend)
    sandbox = await backend.get_client()
    await sandbox.terminate.aio()


class TestFakeModalSandboxBackend(WorkspaceBackendSuite):
    @pytest.fixture
    def backend(self, fake_modal: FakeModal, tmp_path: Path) -> ModalSandboxBackend:
        # Resolved so the working directory `pwd -P` reports matches it on hosts whose temp
        # directory sits behind a symlink.
        fake_modal.host_root = tmp_path.resolve()
        return ModalSandboxBackend()

    @pytest.fixture
    def attach_backend(self) -> Callable[[WorkspaceRef], WorkspaceBackend]:
        return _attach

    @pytest.fixture
    def destroy_environment(self) -> Callable[[WorkspaceBackend], Awaitable[None]]:
        return _terminate


@pytest.mark.modal_live
@pytest.mark.skipif(
    not _live_enabled or not _live_credentials,
    reason='requires PYDANTIC_AI_HARNESS_MODAL_LIVE=1 and Modal credentials',
)
class TestLiveModalSandboxBackend(WorkspaceBackendSuite):  # pragma: no cover - live tier runs without coverage
    # Class-scoped so the rules share one sandbox instead of starting one each; the suite runs
    # its destroy rule last. The teardown uses Modal's blocking API because a class-scoped
    # fixture outlives each test's event loop.
    @pytest.fixture(scope='class')
    @classmethod
    def backend(cls) -> Iterator[ModalSandboxBackend]:
        backend = ModalSandboxBackend(image='python:3.12-slim')
        yield backend
        if backend.ref is not None:
            import modal  # noqa: PLC0415 - optional extra, absent on slim installs

            sandbox = modal.Sandbox.from_id(backend.ref.id)
            if sandbox.poll() is None:
                sandbox.terminate()

    @pytest.fixture
    def attach_backend(self) -> Callable[[WorkspaceRef], WorkspaceBackend]:
        return _attach

    @pytest.fixture
    def destroy_environment(self) -> Callable[[WorkspaceBackend], Awaitable[None]]:
        return _terminate
