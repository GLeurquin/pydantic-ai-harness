"""GitHub device authorization and application-owned Copilot credentials."""

import asyncio
import json
import webbrowser
from collections.abc import Callable
from typing import Literal

import httpx
from pydantic import BaseModel, Field, SecretStr, TypeAdapter, ValidationError
from pydantic_ai.exceptions import UserError
from pydantic_ai.models.github_copilot import GitHubCopilotModel
from pydantic_ai.providers.github_copilot import GitHubCopilotProvider
from rich.console import Console

from .auth import ReadLine, read_line
from .credential_store import credentials_path, load_codex_credentials, save_codex_credentials

# Public device-flow client used by OpenCode for direct Copilot bearer authentication.
# https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/github-copilot/copilot.ts
_CLIENT_ID = 'Ov23li8tweQw6odWQebz'
_ACCOUNT = 'github-copilot'
_VERIFY_URL = 'https://github.com/login/device'


class DeviceCode(BaseModel):
    """Required fields of GitHub's device authorization response."""

    device_code: SecretStr = Field(min_length=1)
    user_code: str = Field(min_length=1)
    verification_uri: Literal['https://github.com/login/device']
    expires_in: int = Field(gt=0)
    interval: int = Field(default=5, gt=0)


class AccessToken(BaseModel):
    """A successful authorization, also used to validate stored credentials."""

    access_token: SecretStr = Field(min_length=1)


class PendingToken(BaseModel):
    """An OAuth polling outcome, without displaying server-provided text."""

    error: str
    interval: int | None = Field(default=None, gt=0)


_TOKEN: TypeAdapter[AccessToken | PendingToken] = TypeAdapter(AccessToken | PendingToken)


class CopilotAuth:
    """Run a bounded browser login without reading other applications' credentials."""

    def __init__(
        self,
        console: Console,
        *,
        read_line: ReadLine = read_line,
        open_browser: Callable[[str], bool] = webbrowser.open,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 900,
    ) -> None:
        """Defer HTTP and credential access until requested."""
        self.console = console
        self.read_line = read_line
        self.open_browser = open_browser
        self.transport = transport
        self.timeout = timeout

    async def login(self) -> str:
        """Save only completed authorizations; failures leave the previous login intact."""
        try:
            async with asyncio.timeout(self.timeout):
                token = await self._authorize()
        except TimeoutError:
            raise UserError('Copilot login timed out. Run /login github-copilot again.') from None
        except (httpx.HTTPError, ValidationError):
            raise UserError('Copilot authorization failed. Run /login github-copilot again.') from None
        await asyncio.to_thread(
            save_codex_credentials,
            account=_ACCOUNT,
            value=json.dumps({'access_token': token.get_secret_value()}),
        )
        path = credentials_path(account=_ACCOUNT)
        if path.exists():
            return f'Copilot connected. No OS keyring is available; credentials are saved in plaintext at {path}.'
        return 'Copilot connected. Credentials saved in the OS credential store.'

    async def _authorize(self) -> SecretStr:
        async with httpx.AsyncClient(
            transport=self.transport, timeout=30, follow_redirects=False, headers={'Accept': 'application/json'}
        ) as client:
            response = await client.post(
                'https://github.com/login/device/code', json={'client_id': _CLIENT_ID, 'scope': 'read:user'}
            )
            response.raise_for_status()
            device = DeviceCode.model_validate_json(response.content)
            async with asyncio.timeout(device.expires_in):
                self.console.print(
                    f'Open {_VERIFY_URL} and enter code: {device.user_code}', markup=False, highlight=False
                )
                self.console.print('A GitHub Copilot subscription is required. Press Ctrl-C to cancel.')
                try:
                    opened = await asyncio.to_thread(self.open_browser, _VERIFY_URL)
                except webbrowser.Error:
                    opened = False
                if not opened:
                    self.console.print('Open the URL above manually, including from another machine over SSH.')
                poll = asyncio.create_task(self._poll(client=client, device=device))
                cancel = asyncio.create_task(self._cancel())
                try:
                    done, _ = await asyncio.wait({poll, cancel}, return_when=asyncio.FIRST_COMPLETED)
                    if cancel in done:
                        return cancel.result()
                    return poll.result()
                finally:
                    poll.cancel()
                    cancel.cancel()
                    await asyncio.gather(poll, cancel, return_exceptions=True)

    async def _cancel(self) -> SecretStr:
        try:
            while True:
                await self.read_line('Waiting for GitHub authorization (Ctrl-C to cancel): ')
        except (EOFError, KeyboardInterrupt):
            raise UserError('Copilot login cancelled.') from None

    async def _poll(self, *, client: httpx.AsyncClient, device: DeviceCode) -> SecretStr:
        interval = device.interval
        while True:
            await asyncio.sleep(interval)
            response = await client.post(
                'https://github.com/login/oauth/access_token',
                json={
                    'client_id': _CLIENT_ID,
                    'device_code': device.device_code.get_secret_value(),
                    'grant_type': 'urn:ietf:params:oauth:grant-type:device_code',
                },
            )
            response.raise_for_status()
            result = _TOKEN.validate_json(response.content)
            if isinstance(result, AccessToken):
                return result.access_token
            if result.error == 'slow_down':
                interval = max(interval + 5, result.interval or 0)
            elif result.error != 'authorization_pending':
                raise UserError('Copilot authorization denied or expired. Run /login github-copilot again.')

    def model(self, name: str) -> GitHubCopilotModel:
        """Use core's native Copilot model and preserve environment auth when not logged in."""
        raw = load_codex_credentials(account=_ACCOUNT)
        if raw is None:
            return GitHubCopilotModel(name.removeprefix('github-copilot:'))
        try:
            token = AccessToken.model_validate_json(raw).access_token.get_secret_value()
        except ValidationError:
            raise UserError('Stored Copilot credentials are invalid. Run /login github-copilot.') from None
        provider = GitHubCopilotProvider(api_key=token, base_url='https://api.githubcopilot.com')
        return GitHubCopilotModel(name.removeprefix('github-copilot:'), provider=provider)
