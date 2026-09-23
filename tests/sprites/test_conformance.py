"""Pydantic AI's workspace backend conformance suite, run against `SpriteWorkspaceBackend`.

`TestFakeSpriteWorkspaceBackend` runs everywhere, over the fake Sprites SDK, whose commands run in
local subprocesses under a temporary host directory. `TestLiveSpriteWorkspaceBackend` runs the same
rules against a real Sprite and is gated like `test_sprites_live.py`.

The backend implements `SupportsCommands` only, so the suite skips its filesystem rules, and with
them the reattach rules, which read files through the filesystem protocol. `test_sprites.py` and
`test_sprites_live.py` cover reattaching and a deleted Sprite through commands instead.
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable, Iterator

import pytest
from pydantic_ai.workspaces import WorkspaceBackend, WorkspaceRef, WorkspaceUnavailableError
from pydantic_ai.workspaces.testing import WorkspaceBackendSuite
from sprites.exceptions import NotFoundError

from pydantic_ai_harness.sprites import SpriteWorkspaceBackend

from .fake_sprites import SpriteTransport

_live_enabled = os.getenv('PYDANTIC_AI_HARNESS_SPRITES_LIVE') == '1'


def _attach(ref: WorkspaceRef) -> WorkspaceBackend:
    return SpriteWorkspaceBackend(ref=ref)


async def _delete(backend: WorkspaceBackend) -> None:
    assert isinstance(backend, SpriteWorkspaceBackend)
    sprite = await backend.get_client()
    await sprite.delete()


class TestFakeSpriteWorkspaceBackend(WorkspaceBackendSuite):
    @pytest.fixture
    def backend(self, transport: SpriteTransport) -> SpriteWorkspaceBackend:
        del transport
        return SpriteWorkspaceBackend()

    @pytest.fixture
    def attach_backend(self) -> Callable[[WorkspaceRef], WorkspaceBackend]:
        return _attach

    @pytest.fixture
    def destroy_environment(self) -> Callable[[WorkspaceBackend], Awaitable[None]]:
        return _delete


# The suite's reattach and destroy rules skip for this command-only backend, so these cover the
# helpers it would hand them.
@pytest.mark.anyio
async def test_attach_and_delete_helpers(transport: SpriteTransport) -> None:
    owner = SpriteWorkspaceBackend()
    assert (await owner.run(['true'])).exit_code == 0
    assert owner.ref is not None

    attached = _attach(owner.ref)
    assert isinstance(attached, SpriteWorkspaceBackend)
    assert (await attached.run(['true'])).exit_code == 0
    assert transport.created == [owner.ref.id]

    await _delete(attached)
    with pytest.raises(WorkspaceUnavailableError):
        await attached.run(['true'])


@pytest.mark.anyio
async def test_delete_helper_on_a_deleted_sprite(transport: SpriteTransport) -> None:
    backend = SpriteWorkspaceBackend()
    assert (await backend.run(['true'])).exit_code == 0
    await _delete(backend)
    with pytest.raises(NotFoundError):
        await _delete(backend)


@pytest.mark.sprites_live
@pytest.mark.skipif(
    not _live_enabled or not os.getenv('SPRITE_TOKEN'),
    reason='requires PYDANTIC_AI_HARNESS_SPRITES_LIVE=1 and SPRITE_TOKEN',
)
class TestLiveSpriteWorkspaceBackend(WorkspaceBackendSuite):  # pragma: no cover - live tier runs without coverage
    # One event loop for the class: the class-scoped backend's `AsyncSpritesClient` holds an
    # `httpx.AsyncClient` whose pooled connections are bound to the loop they were opened on.
    @pytest.fixture(scope='class')
    @classmethod
    def anyio_backend(cls) -> str:
        return 'asyncio'

    # Class-scoped so the rules share one Sprite instead of creating one each. The teardown uses
    # the blocking `SpritesClient` because a class-scoped fixture outlives each test's event loop.
    @pytest.fixture(scope='class')
    @classmethod
    def backend(cls) -> Iterator[SpriteWorkspaceBackend]:
        backend = SpriteWorkspaceBackend()
        yield backend
        if backend.ref is not None:
            from sprites import SpritesClient  # noqa: PLC0415 - optional extra, absent on slim installs
            from sprites.exceptions import NotFoundError  # noqa: PLC0415

            client = SpritesClient(token=os.environ['SPRITE_TOKEN'])
            try:
                client.delete_sprite(backend.ref.id)
            except NotFoundError:
                pass
            finally:
                client.close()

    @pytest.fixture
    def attach_backend(self) -> Callable[[WorkspaceRef], WorkspaceBackend]:
        return _attach

    @pytest.fixture
    def destroy_environment(self) -> Callable[[WorkspaceBackend], Awaitable[None]]:
        return _delete
