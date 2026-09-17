"""Exercise the installed entry point in isolated subprocesses."""

import os
import pty
import subprocess
import sys
from pathlib import Path

import pytest

from pydantic_clai2.settings_store import SettingsStore


@pytest.mark.parametrize('args', [[], ['--model', 'test', '--request-limit', '12'], ['--request-limit', '0']])
def test_cli_startup(tmp_path: Path, args: list[str]) -> None:
    """An empty stdin is not a prompt: the shell starts and exits on EOF."""
    env = dict(os.environ, CLAI_NO_SPLASH='1')
    env.pop('CLAI_MODEL', None)
    result = subprocess.run(
        [sys.executable, '-m', 'pydantic_clai2', '--database', str(tmp_path / 'config.db'), *args],
        stdin=subprocess.DEVNULL,
        text=True,
        capture_output=True,
        env=env,
        timeout=15,
        check=False,
    )
    assert result.returncode == (2 if args == ['--request-limit', '0'] else 0), result.stderr


def test_cli_startup_interrupt(tmp_path: Path) -> None:
    script = """
import asyncio
import runpy

def interrupted(coroutine):
    coroutine.close()
    raise KeyboardInterrupt

asyncio.run = interrupted
runpy.run_module('pydantic_clai2', run_name='__main__')
"""
    result = subprocess.run(
        [sys.executable, '-c', script, '--database', str(tmp_path / 'config.db')],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=False,
        timeout=15,
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize('state', ['enabled', 'disabled', 'corrupt'])
def test_startup_saved_splash(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, state: str) -> None:
    monkeypatch.setenv('XDG_CONFIG_HOME', str(tmp_path))
    monkeypatch.delenv('CLAI_NO_SPLASH', raising=False)
    monkeypatch.setenv('CLAI_MODEL', 'test')
    path = tmp_path / 'pydantic-clai2' / 'config.db'
    store = SettingsStore(path)
    if state == 'corrupt':
        path.write_text('not sqlite')
    else:
        store.set('display.splash', state == 'enabled')
    # The splash only consults the database when stdin is a terminal; a pty keeps the shell interactive.
    leader, follower = pty.openpty()
    os.write(leader, b'/exit\n')
    try:
        result = subprocess.run(
            [sys.executable, '-m', 'pydantic_clai2'],
            stdin=follower,
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
        )
    finally:
        os.close(leader)
        os.close(follower)
    assert result.returncode == (1 if state == 'corrupt' else 0), result.stderr
