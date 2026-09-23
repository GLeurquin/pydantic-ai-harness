"""Interactive opt-in before the editor or any telemetry exporter starts."""

import os
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

from keyring.errors import KeyringError
from pydantic import ValidationError
from pydantic_ai.exceptions import UserError
from rich.console import Console
from rich.prompt import Prompt

from .config import PluginSettings
from .logfire_credentials import (
    LogfireCredentials,
    load_logfire_credentials,
    logfire_directory,
    save_logfire_credentials,
)
from .settings_store import SettingsStore


def logfire_command(store: SettingsStore, args: list[str]) -> str:
    """Reconnect or decline without starting a chat session."""
    if args:
        raise ValueError('Usage: clai2 logfire')
    onboard_logfire(store=store, force=True)
    return ''


def onboard_logfire(
    *, store: SettingsStore, project_plugins: tuple[PluginSettings, ...] = (), force: bool = False
) -> None:
    """Remember login or decline as a normal plugin override, including on upgrades."""
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        if force:
            raise ValueError('Logfire setup requires an interactive terminal. Set LOGFIRE_TOKEN for headless use.')
        return
    saved = next((plugin for plugin in store.plugins() if plugin.id == 'logfire'), None)
    if not force and (
        saved is not None
        or any(plugin.id == 'logfire' for plugin in project_plugins)
        or (store.plugins_dir / 'logfire.py').is_file()
        or (store.plugins_dir / 'logfire' / '__init__.py').is_file()
    ):
        return
    if force and saved is not None and (saved.factory != 'pydantic_clai2.logfire' or saved.path is not None):
        raise ValueError('The logfire plugin has been replaced. Remove its override before running clai2 logfire.')
    console = Console()
    try:
        if not force and (os.getenv('LOGFIRE_TOKEN') or load_logfire_credentials() is not None):
            return
        console.print(
            'Connect CLAI to your Logfire project?\n'
            'Traces include prompts, responses, tool arguments/results, and images. '
            'They may contain source code, file contents, and screenshots.\n'
            'Declining disables the Logfire plugin. You can change this later with clai2 logfire.',
            markup=False,
        )
        choice = Prompt.ask('Logfire', choices=['login', 'decline'], default='decline', console=console)
        declaration = saved or PluginSettings(id='logfire', factory='pydantic_clai2.logfire')
        if choice == 'decline':
            store.save_plugin(declaration.model_copy(update={'enabled': False}))
            console.print('Logfire disabled. Run clai2 logfire to connect later.')
            return
        connect_logfire(console=console)
        store.save_plugin(declaration.model_copy(update={'enabled': True}))
    except (EOFError, KeyboardInterrupt):
        console.print('\nLogfire setup cancelled. Run clai2 logfire to try again.')
    except (OSError, subprocess.SubprocessError, KeyringError, ValidationError, UserError):
        console.print('Logfire setup did not complete. Run clai2 logfire to try again.')


def connect_logfire(*, console: Console) -> None:
    """Delegate browser auth and project selection to the installed Logfire CLI."""
    console.print(
        'Logfire manages your account login in ~/.logfire. CLAI stores the project write token in your OS keyring.',
        markup=False,
    )
    with TemporaryDirectory(prefix='clai-logfire-') as temporary:
        directory = Path(temporary)
        subprocess.run([sys.executable, '-I', '-m', 'logfire', 'auth'], cwd=directory, check=True, timeout=300)
        action = Prompt.ask('Logfire project', choices=['use', 'new'], default='use', console=console)
        subprocess.run(
            [sys.executable, '-I', '-m', 'logfire', 'projects', action, '--data-dir', str(directory)],
            cwd=directory,
            check=True,
            timeout=300,
        )
        path = directory / 'logfire_credentials.json'
        credentials = LogfireCredentials.model_validate_json(path.read_text(encoding='utf-8'))
        save_logfire_credentials(credentials)
    fallback = logfire_directory().parent / 'credentials-logfire.json'
    if fallback.exists():
        console.print(
            f'No OS keyring is available. Logfire credentials saved in a private plaintext file at {fallback}.'
        )
    else:
        console.print('Logfire connected. Project credentials saved in the OS keyring.')
    if os.getenv('LOGFIRE_TOKEN'):
        console.print('LOGFIRE_TOKEN is set and takes precedence over this saved project.')
