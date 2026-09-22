"""Copilot device flow without real GitHub requests or credentials."""

import asyncio
import io
import json
import webbrowser
from collections.abc import Awaitable
from pathlib import Path

import anyio
import httpx
import keyring
import pytest
from keyring.errors import NoKeyringError
from pydantic_ai import Agent
from pydantic_ai.exceptions import UserError
from pydantic_ai.models.github_copilot import GitHubCopilotModel
from pydantic_ai.models.openai_codex import OpenAICodexModel
from pydantic_ai.models.test import TestModel
from rich.console import Console

from pydantic_clai2._app import create_shell
from pydantic_clai2.auth import CodexAuth
from pydantic_clai2.config import Settings
from pydantic_clai2.copilot_auth import CopilotAuth
from pydantic_clai2.credential_store import credentials_path, load_codex_credentials, save_codex_credentials
from pydantic_clai2.login import SubscriptionAuth
from pydantic_clai2.project_settings import ProjectSettings
from pydantic_clai2.settings_store import SettingsStore

DEVICE = {
    'device_code': 'secret-device',
    'user_code': 'ABCD-EFGH',
    'verification_uri': 'https://github.com/login/device',
    'expires_in': 900,
    'interval': 1,
}


async def waiting(message: str) -> str:
    await asyncio.Event().wait()
    raise AssertionError('unreachable')


@pytest.mark.parametrize('browser', ['opened', 'closed', 'error'])
@pytest.mark.parametrize('fallback', [False, True])
async def test_login(monkeypatch: pytest.MonkeyPatch, browser: str, *, fallback: bool) -> None:
    delays: list[float] = []
    responses = iter(
        [
            {'error': 'authorization_pending'},
            {'error': 'slow_down'},
            {'error': 'slow_down', 'interval': 20},
            {'access_token': 'secret-access'},
        ]
    )

    async def sleep(delay: float) -> None:
        delays.append(delay)

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.headers['accept'] == 'application/json'
        assert request.url.host == 'github.com'
        payload = json.loads(request.content)
        assert payload['client_id'] == 'Ov23li8tweQw6odWQebz'
        if request.url.path == '/login/device/code':
            assert payload['scope'] == 'read:user'
            return httpx.Response(200, json=DEVICE)
        assert request.url.path == '/login/oauth/access_token'
        assert payload['device_code'] == 'secret-device'
        assert payload['grant_type'] == 'urn:ietf:params:oauth:grant-type:device_code'
        return httpx.Response(200, json=next(responses))

    def open_browser(url: str) -> bool:
        assert url == 'https://github.com/login/device'
        if browser == 'error':
            raise webbrowser.Error('missing browser')
        return browser == 'opened'

    def unavailable(service: str, account: str) -> str | None:
        raise NoKeyringError()

    if fallback:
        monkeypatch.setattr(keyring, 'get_password', unavailable)
    monkeypatch.setattr('pydantic_clai2.copilot_auth.asyncio.sleep', sleep)
    output = io.StringIO()
    auth = CopilotAuth(
        Console(file=output), read_line=waiting, open_browser=open_browser, transport=httpx.MockTransport(respond)
    )
    message = await auth.login()
    assert 'connected' in message
    assert ('plaintext' in message) is fallback
    assert delays == [1, 1, 6, 20]
    assert 'ABCD-EFGH' in output.getvalue()
    assert ('manually' in output.getvalue()) is (browser != 'opened')
    assert 'secret-' not in output.getvalue()
    assert load_codex_credentials(account='github-copilot') == '{"access_token": "secret-access"}'
    assert load_codex_credentials() is None
    if fallback:
        assert credentials_path(account='github-copilot').stat().st_mode & 0o777 == 0o600
    model = await SubscriptionAuth(Console(file=io.StringIO())).resolve_model('github-copilot:test-model')
    assert isinstance(model, GitHubCopilotModel)
    assert model.model_name == 'test-model'
    assert model.client.api_key == 'secret-access'
    assert str(model.client.base_url) == 'https://api.githubcopilot.com'


@pytest.mark.parametrize('failure', ['denied', 'expired', 'http', 'malformed', 'redirect', 'network', 'device', 'url'])
async def test_failed_login_keeps_previous(monkeypatch: pytest.MonkeyPatch, failure: str) -> None:
    save_codex_credentials(account='github-copilot', value='previous')

    async def sleep(delay: float) -> None:
        pass

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path == '/login/device/code':
            if failure == 'device':
                return httpx.Response(200, json={})
            if failure == 'url':
                return httpx.Response(200, json={**DEVICE, 'verification_uri': 'https://evil.example'})
            return httpx.Response(200, json=DEVICE)
        if failure == 'network':
            raise httpx.ConnectError('secret server detail')
        if failure == 'http':
            return httpx.Response(500, text='secret server detail')
        if failure == 'redirect':
            return httpx.Response(302, headers={'location': 'https://evil.example'})
        if failure == 'malformed':
            return httpx.Response(200, json={'access_token': ''})
        return httpx.Response(200, json={'error': 'access_denied' if failure == 'denied' else 'expired_token'})

    monkeypatch.setattr('pydantic_clai2.copilot_auth.asyncio.sleep', sleep)
    auth = CopilotAuth(
        Console(file=io.StringIO()),
        read_line=waiting,
        open_browser=lambda _: False,
        transport=httpx.MockTransport(respond),
    )
    with pytest.raises(UserError, match='Copilot authorization') as error:
        await auth.login()
    assert 'secret' not in str(error.value)
    assert load_codex_credentials(account='github-copilot') == 'previous'


@pytest.mark.parametrize('cancel', ['eof', 'interrupt', 'outer', 'timeout'])
async def test_cancellation_cleans_up(cancel: str) -> None:
    polling = anyio.Event()
    cleaned = anyio.Event()
    prompt_cleaned = anyio.Event()

    async def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path == '/login/device/code':
            return httpx.Response(200, json=DEVICE)
        polling.set()
        try:
            await anyio.sleep_forever()
        finally:
            cleaned.set()
        raise AssertionError('unreachable')

    async def prompt(message: str) -> str:
        try:
            await polling.wait()
            if cancel == 'eof':
                raise EOFError()
            if cancel == 'interrupt':
                raise KeyboardInterrupt()
            await anyio.sleep_forever()
        finally:
            prompt_cleaned.set()
        raise AssertionError('unreachable')

    auth = CopilotAuth(
        Console(file=io.StringIO()),
        read_line=prompt,
        open_browser=lambda _: False,
        transport=httpx.MockTransport(respond),
        timeout=1.1 if cancel == 'timeout' else 30,
    )
    if cancel == 'outer':
        async with anyio.create_task_group() as group:
            group.start_soon(auth.login)
            await polling.wait()
            group.cancel_scope.cancel()
    else:
        with pytest.raises(UserError, match='timed out' if cancel == 'timeout' else 'cancelled'):
            await auth.login()
    assert cleaned.is_set()
    assert prompt_cleaned.is_set()
    assert load_codex_credentials(account='github-copilot') is None


async def test_models_and_dispatch(monkeypatch: pytest.MonkeyPatch) -> None:
    auth = SubscriptionAuth(Console(file=io.StringIO()))
    monkeypatch.setenv('GITHUB_COPILOT_API_KEY', 'environment-token')
    model = await auth.resolve_model('github-copilot:test')
    assert isinstance(model, GitHubCopilotModel)
    assert model.client.api_key == 'environment-token'
    assert await auth.resolve_model('test') == 'test'
    assert isinstance(await auth.resolve_model('openai-codex:test'), OpenAICodexModel)
    save_codex_credentials(account='github-copilot', value='bad json')
    with pytest.raises(UserError, match='invalid'):
        await auth.resolve_model('github-copilot:test')
    with pytest.raises(ValueError, match='Usage'):
        await auth.login(['bad'])

    async def copilot_login(self: CopilotAuth) -> str:
        return 'copilot'

    monkeypatch.setattr(CopilotAuth, 'login', copilot_login)
    assert await auth.login(['github-copilot']) == 'copilot'

    async def codex_login(self: CodexAuth, args: list[str]) -> str:
        return 'codex'

    monkeypatch.setattr(CodexAuth, 'login', codex_login)
    assert await auth.login([]) == 'codex'
    assert await auth.login(['openai-codex']) == 'codex'

    def other_model(name: str) -> TestModel:
        return TestModel()

    monkeypatch.setattr('pydantic_clai2.openrouter.model', other_model)
    monkeypatch.setattr('pydantic_clai2.vllm.model', other_model)
    assert isinstance(await auth.resolve_model('openrouter:test'), TestModel)
    assert isinstance(await auth.resolve_model('vllm:test'), TestModel)


async def test_shell_login_and_completion(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def login(self: CopilotAuth) -> str:
        save_codex_credentials(account='github-copilot', value='{"access_token":"shell-token"}')
        return 'Copilot connected.'

    monkeypatch.setattr(CopilotAuth, 'login', login)
    shell = create_shell(
        Agent(TestModel()),
        deps=None,
        plugins=[],
        usage_limits=None,
        console=Console(file=io.StringIO()),
        settings=Settings(model='test'),
        store=SettingsStore(tmp_path / 'settings.db'),
        builtin_plugins=[],
        project=ProjectSettings(),
    )
    command = next(command for command in shell.commands if command.name == 'login')
    assert tuple(command.complete([])) == ('openai-codex', 'github-copilot')
    assert await shell.commands.execute_async('/login github-copilot') == 'Copilot connected.'
    assert shell.session.model == 'test'
    pending = shell.session.resolve_model('github-copilot:test')
    assert isinstance(pending, Awaitable)
    model = await pending
    assert isinstance(model, GitHubCopilotModel)
    assert model.client.api_key == 'shell-token'
