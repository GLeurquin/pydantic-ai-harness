"""Local browser entry point using CLAI's noninteractive session lifecycle."""

from anyio import sleep_forever

from .config import Settings
from .headless import headless_session
from .project_settings import ProjectSettings
from .settings_store import SettingsStore
from .web_transport import serve_chat


async def run_web(
    *, settings: Settings, store: SettingsStore, project: ProjectSettings, resume: str | None = None, port: int = 0
) -> None:
    """Serve one conversation until interrupted, then close its plugins."""
    async with headless_session(settings=settings, store=store, project=project, resume=resume) as turn:
        async with serve_chat(turn, port=port) as url:
            print(f'CLAI2 browser: {url}', flush=True)
            print('Keep this link private. Tools run with your local permissions. Ctrl-C stops the server.', flush=True)
            await sleep_forever()
