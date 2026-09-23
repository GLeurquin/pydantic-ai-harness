from __future__ import annotations

import importlib.util
import shutil
from collections.abc import AsyncIterator
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

_HAS_SPRITES = importlib.util.find_spec('sprites') is not None
collect_ignore = (
    [] if _HAS_SPRITES else ['fake_sprites.py', 'test_conformance.py', 'test_sprites.py', 'test_sprites_live.py']
)

if TYPE_CHECKING or _HAS_SPRITES:  # pragma: no branch - installed and slim jobs take opposite branches
    from sprites import AsyncSprite, AsyncSpritesClient

    from .fake_sprites import FakeControlConnection, SpriteTransport


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


if _HAS_SPRITES:  # pragma: no branch - the fixture requires the SDK-backed fake

    @pytest.fixture
    async def transport(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> AsyncIterator[SpriteTransport]:
        transport = SpriteTransport(tmp_path)
        monkeypatch.setenv('SPRITE_TOKEN', 'test-token')
        monkeypatch.setattr('pydantic_ai_harness.sprites._backend.AsyncSpritesClient', transport.client)
        FakeControlConnection.transport = transport
        monkeypatch.setattr('pydantic_ai_harness.sprites._backend.ControlConnection', FakeControlConnection)

        async def get(client: AsyncSpritesClient, name: str) -> AsyncSprite:
            return await transport.get(client, name)

        async def create(client: AsyncSpritesClient, name: str, *, runtime: str | None) -> AsyncSprite:
            return await transport.create(client, name, runtime=runtime)

        monkeypatch.setattr(AsyncSpritesClient, 'get_sprite', get)
        monkeypatch.setattr(AsyncSpritesClient, 'create_sprite', create)

        async def close(client: AsyncSpritesClient) -> None:
            await transport.close(client)

        monkeypatch.setattr(AsyncSpritesClient, 'aclose', close)
        yield transport
        for client in transport.clients:
            await client.aclose()
        for control in transport.controls:
            shutil.rmtree(control, ignore_errors=True)
