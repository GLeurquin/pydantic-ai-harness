"""A once-a-day PyPI check for a newer CLAI. Runs off the startup path and stays silent on any failure."""

import asyncio
import re
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from importlib.metadata import version
from typing import Protocol

import httpx
from prompt_toolkit.application import run_in_terminal
from pydantic import BaseModel
from rich.console import Console

from . import theme
from .settings_store import SettingsStore

PACKAGE = 'pydantic-clai2'
CHECK_INTERVAL = timedelta(days=1)
TIMEOUT_SECONDS = 3.0
STATE_KEY = 'last_update_check'


class VersionSource(Protocol):
    """Where the newest published version comes from: PyPI for real, a stub in tests."""

    async def latest(self, package: str) -> str:
        """Return the newest published version string, or raise."""
        ...


class _Info(BaseModel):
    version: str


class _Release(BaseModel):
    info: _Info


class PyPI:
    """The JSON API at pypi.org."""

    async def latest(self, package: str) -> str:  # pragma: no cover -- the real network call.
        """Fetch `info.version` from the package's JSON page."""
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
            response = await client.get(f'https://pypi.org/pypi/{package}/json')
            response.raise_for_status()
            return _Release.model_validate_json(response.content).info.version


def installed_version() -> str:
    """The version of this very package, as installed."""
    return version(PACKAGE)


def utc_now() -> datetime:
    """Injectable clock for the daily interval."""
    return datetime.now(UTC)


async def check_for_update(
    *,
    store: SettingsStore,
    console: Console,
    source: VersionSource,
    current: str,
    enabled: bool,
    now: Callable[[], datetime] = utc_now,
) -> str | None:
    """Print one muted line when PyPI has a newer release; return it for callers that care."""
    if not enabled:
        return None
    moment = now()
    try:
        if not _due(await asyncio.to_thread(store.state, STATE_KEY), moment):
            return None
        await asyncio.to_thread(store.save_state, STATE_KEY, moment.isoformat())
        latest = await asyncio.wait_for(source.latest(PACKAGE), TIMEOUT_SECONDS)
    except Exception:  # noqa: BLE001 -- an update hint must never surface network or database trouble.
        return None
    newest, installed = _numbers(latest), _numbers(current)
    if newest is None or installed is None or newest <= installed:
        return None
    notice = f'{PACKAGE} {latest} is available (you have {current}): pip install -U {PACKAGE}'
    await run_in_terminal(lambda: console.print(notice, style=theme.MUTED))
    return notice


def _due(last: str | None, moment: datetime) -> bool:
    if last is None:
        return True
    try:
        return moment - datetime.fromisoformat(last) >= CHECK_INTERVAL
    except ValueError:
        return True


def _numbers(release: str) -> tuple[int, ...] | None:
    """Plain `X.Y.Z` releases compare as integers, `1.0` equal to `1.0.0`; pre-releases and dev builds are not compared."""
    if re.fullmatch(r'\d+(\.\d+)*', release) is None:
        return None
    numbers = [int(number) for number in release.split('.')]
    while len(numbers) > 1 and numbers[-1] == 0:
        numbers.pop()
    return tuple(numbers)
