"""Route subscription logins without changing the active model."""

import asyncio

from pydantic_ai.models import Model
from rich.console import Console

from . import openrouter, vllm
from .auth import CodexAuth
from .copilot_auth import CopilotAuth


class SubscriptionAuth:
    """Keep subscription authentication scoped to the conversation."""

    def __init__(self, console: Console) -> None:
        """Construct providers without reading credentials."""
        self.codex = CodexAuth(console)
        self.copilot = CopilotAuth(console)

    async def login(self, args: list[str]) -> str:
        """Keep bare `/login` compatible with Codex."""
        if args == ['github-copilot']:
            return await self.copilot.login()
        if args in ([], ['openai-codex']):
            return await self.codex.login(args)
        raise ValueError('Usage: /login [openai-codex|github-copilot]')

    async def resolve_model(self, name: str) -> Model | str:
        """Resolve saved credentials off the terminal's event loop."""
        if name.startswith('github-copilot:'):
            return await asyncio.to_thread(self.copilot.model, name)
        if name.startswith('openrouter:'):
            return await asyncio.to_thread(openrouter.model, name)
        if name.startswith('vllm:'):
            return await asyncio.to_thread(vllm.model, name)
        return self.codex.model(name) if name.startswith('openai-codex:') else name
