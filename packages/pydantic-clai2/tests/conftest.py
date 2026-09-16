"""Isolate settings and provider access for every CLAI test."""

from pathlib import Path

import pytest
from pydantic_ai import models


@pytest.fixture(autouse=True)
def isolated_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Redirect default databases, including subprocesses, away from user data."""
    monkeypatch.setenv('XDG_CONFIG_HOME', str(tmp_path / 'config'))
    monkeypatch.setenv('HOME', str(tmp_path / 'home'))
    monkeypatch.delenv('CLAI_MODEL', raising=False)
    monkeypatch.setattr(models, 'ALLOW_MODEL_REQUESTS', False)
