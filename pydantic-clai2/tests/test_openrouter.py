"""Private-server discovery without network or real credentials."""

from pathlib import Path

import httpx
import pytest
from menu_script import make_context
from pydantic import SecretStr
from pydantic_ai.exceptions import UserError

from pydantic_clai2 import openrouter


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


@pytest.mark.parametrize('token', ['test-secret'])
async def test_discovery(token: str) -> None:
    def response(request: httpx.Request) -> httpx.Response:
        assert str(request.url) in ('https://openrouter.ai/api/v1/models', 'https://openrouter.ai/api/v1/key')
        assert request.headers.get('authorization') == (f'Bearer {token}' if token else None)
        return httpx.Response(200, json={'data': [{'id': 'b'}, {'id': 'a'}, {'id': 'a'}]})

    assert await openrouter.discover(
        openrouter.Connection(token=SecretStr(token)), transport=httpx.MockTransport(response)
    ) == ['a', 'b']


@pytest.mark.parametrize('status', [401, 302, 200])
async def test_discovery_failure(status: int) -> None:
    with pytest.raises(UserError):
        await openrouter.discover(
            openrouter.Connection(token=SecretStr('test-token')),
            transport=httpx.MockTransport(lambda request: httpx.Response(status, json={'data': []})),
        )


def test_url_and_credentials() -> None:
    with pytest.raises(UserError, match='Connect first'):
        openrouter.model('openrouter:test')
    openrouter.save_connection(openrouter.Connection(token=SecretStr('test-token')))
    assert openrouter.model('openrouter:my/model').model_name == 'my/model'


@pytest.mark.parametrize('outcome', ['ok', 'cancel', 'eof', 'args', 'empty'])
async def test_connect(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, outcome: str) -> None:
    context, _ = make_context(tmp_path)
    values = iter(['' if outcome == 'empty' else 'secret'])

    class Prompt:
        async def prompt_async(self, label: str, *, is_password: bool = False) -> str:
            if outcome == 'eof':
                raise EOFError
            if 'API key' in label:
                assert is_password
            return next(values)

    async def discovery(connection: openrouter.Connection) -> list[str]:
        return ['my/model']

    monkeypatch.setattr(openrouter, 'PromptSession', Prompt)
    monkeypatch.setattr(openrouter, 'discover', discovery)

    def choose(names: list[str]) -> str | None:
        return None if outcome == 'cancel' else names[0]

    monkeypatch.setattr(openrouter, 'choose', choose)
    if outcome == 'args':
        with pytest.raises(ValueError, match='Usage'):
            await openrouter.connect(context, ['secret'])
    elif outcome == 'empty':
        with pytest.raises(ValueError, match='required'):
            await openrouter.connect(context, [])
    else:
        result = await openrouter.connect(context, [])
        assert result == ('Saved model. Applied.' if outcome == 'ok' else 'Connection cancelled.')
        if outcome == 'ok':
            assert context.settings.model == 'openrouter:my/model'
