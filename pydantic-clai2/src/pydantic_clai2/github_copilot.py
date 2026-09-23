"""GitHub device login and model discovery through Pydantic AI's Copilot provider."""

import os
import time
import webbrowser

import httpx2
from anyio import to_thread
from openai import APIError
from pydantic import BaseModel, Field, ValidationError
from pydantic_ai.exceptions import UserError
from pydantic_ai.models.github_copilot import GitHubCopilotModel
from pydantic_ai.providers.github_copilot import GitHubCopilotCredentials, GitHubCopilotOAuthFlow, GitHubCopilotProvider
from rich.console import Console
from termflow.tui import MenuBuilder, MenuItem  # pyright: ignore[reportMissingTypeStubs]
from termflow.tui.menu import Menu  # pyright: ignore[reportMissingTypeStubs]

from ._rendering import markdown_style
from .command_context import CommandContext
from .credential_store import credentials_path, load_codex_credentials, save_codex_credentials
from .field_menu import TERMINAL, Runners
from .menu_worker import menu_key, run_worker


class Connection(BaseModel):
    """Keep issuance time with core's token lifetime metadata."""

    credentials: GitHubCopilotCredentials
    issued_at: float = Field(ge=0, allow_inf_nan=False)


async def login(*, console: Console) -> str:
    """Display core's device challenge and save only a completed authorization."""
    client_id = os.getenv('GITHUB_COPILOT_CLIENT_ID', '').strip()
    if not client_id:
        raise UserError('Set GITHUB_COPILOT_CLIENT_ID to your OAuth application client ID with device flow enabled.')
    flow = GitHubCopilotOAuthFlow(client_id=client_id)
    authorization = await flow.start()
    console.print(f'Open {authorization.verification_uri}', markup=False, highlight=False)
    console.print(f'Enter code: {authorization.user_code}', markup=False, highlight=False)
    console.print('Approve only the code shown here. Ctrl-C cancels. You can open the link on another device.')
    await to_thread.run_sync(webbrowser.open, authorization.verification_uri)
    credentials = await flow.wait_for_authorization()
    connection = Connection(credentials=credentials, issued_at=time.time())
    await to_thread.run_sync(
        lambda: save_codex_credentials(account='github-copilot', value=connection.model_dump_json())
    )
    path = credentials_path(account='github-copilot')
    storage = (
        f'No OS keyring is available; credentials are saved in plaintext at {path}.'
        if path.exists()
        else 'Credentials saved in the OS credential store.'
    )
    return f'GitHub login saved. {storage} Use /add_model > github-copilot to check Copilot access and choose a model.'


def token() -> str:
    """Prefer the saved login; retain Copilot-specific environment tokens when no login exists."""
    raw = load_codex_credentials(account='github-copilot')
    if raw is not None:
        try:
            connection = Connection.model_validate_json(raw)
        except ValidationError:
            raise UserError('Stored Copilot credentials are invalid. Run /login github-copilot.') from None
        lifetime = connection.credentials.expires_in
        if lifetime is not None and time.time() >= connection.issued_at + lifetime:
            raise UserError('Copilot credentials expired. Run /login github-copilot.')
        return connection.credentials.access_token
    for name in ('GITHUB_COPILOT_API_KEY', 'GITHUB_COPILOT_API_TOKEN', 'COPILOT_GITHUB_TOKEN'):
        if value := os.getenv(name):
            return value
    raise UserError('Copilot is not connected. Run /login github-copilot or set GITHUB_COPILOT_API_KEY.')


def model(name: str) -> GitHubCopilotModel:
    """Use core's Copilot model profiles and request semantics."""
    return GitHubCopilotModel(name.removeprefix('github-copilot:'), provider=GitHubCopilotProvider(api_key=token()))


class ServedModel(BaseModel):
    """Copilot's endpoint allowlist determines which models core can use."""

    id: str = Field(min_length=1)
    supported_endpoints: list[str] = Field(default_factory=list)


class ModelList(BaseModel):
    """Validate discovery before presenting identifiers for selection."""

    data: list[ServedModel]


async def discover(*, transport: httpx2.AsyncBaseTransport | None = None) -> list[str]:
    """Use core's endpoint, authentication and headers, without following redirects."""
    async with httpx2.AsyncClient(transport=transport, timeout=20, follow_redirects=False) as client:
        copilot = GitHubCopilotProvider(api_key=await to_thread.run_sync(token), http_client=client)
        try:
            response = await copilot.client.with_options(max_retries=0).models.with_raw_response.list()
        except APIError:
            raise UserError(
                'Copilot model discovery failed. Check connectivity, your subscription and organization policy, '
                'or run /login github-copilot again.'
            ) from None
        try:
            models = ModelList.model_validate_json(response.content)
        except ValidationError:
            raise UserError('Copilot returned an invalid model list.') from None
    names = sorted({model.id for model in models.data if '/chat/completions' in model.supported_endpoints})
    if not names:
        raise UserError('Copilot returned no Chat Completions models for this account.')
    return names


def model_menu(names: list[str]) -> Menu:
    """Offer only models returned by the authenticated Copilot catalog."""
    return (
        MenuBuilder('GitHub Copilot models')
        .style(markdown_style())
        .items([MenuItem(name, value=name) for name in names])
        .searchable()
        .footer_hint('type to filter - Enter add and use model - Esc close')
        .key_source(menu_key)
        .build()
    )


async def connect(context: CommandContext, args: list[str], *, runners: Runners = TERMINAL) -> str:
    """Sign in when needed, then select a model from the account's live catalog."""
    if args:
        raise ValueError('Use /add_model > github-copilot to connect.')
    try:
        await to_thread.run_sync(token)
    except UserError:
        console = Console()
        console.print(await login(console=console), markup=False)
    names = await discover()
    selected = await run_worker(lambda: runners.run_list(model_menu(names)))
    if selected.cancelled or selected.item is None or not isinstance(selected.item.value, str):
        return 'Connection cancelled.'
    return context.set_setting(['model', f'github-copilot:{selected.item.value}'])
