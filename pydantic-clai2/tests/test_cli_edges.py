"""Exercise the installed entry point in isolated subprocesses."""

import os
import pty
import subprocess
import sys
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

import pytest

from pydantic_clai2.settings_store import SettingsStore


@contextmanager
def terminal_stdin(text: bytes = b'/exit\n') -> Generator[int, None, None]:
    """A pty with `text` already typed: stdin is a terminal, so CLAI starts the shell rather than a one-shot."""
    leader, follower = pty.openpty()
    os.write(leader, text)
    try:
        yield follower
    finally:
        os.close(leader)
        os.close(follower)


@pytest.mark.parametrize('args', [[], ['--model', 'test', '--request-limit', '12'], ['--request-limit', '0']])
def test_cli_startup(tmp_path: Path, args: list[str]) -> None:
    env = dict(os.environ, CLAI_NO_SPLASH='1')
    env.pop('CLAI_MODEL', None)
    with terminal_stdin() as stdin:
        result = subprocess.run(
            [sys.executable, '-m', 'pydantic_clai2', '--database', str(tmp_path / 'config.db'), *args],
            stdin=stdin,
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
    with terminal_stdin() as stdin:
        result = subprocess.run(
            [sys.executable, '-c', script, '--database', str(tmp_path / 'config.db')],
            stdin=stdin,
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
    with terminal_stdin() as stdin:
        result = subprocess.run(
            [sys.executable, '-m', 'pydantic_clai2'],
            stdin=stdin,
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
        )
    assert result.returncode == (1 if state == 'corrupt' else 0), result.stderr
