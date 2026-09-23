"""Shared fixtures for ModalSandbox tests."""

from __future__ import annotations

import sys
import types
from collections.abc import Iterator

import pytest

from .fake_modal import FakeModal


class _PoisonedModal(types.ModuleType):
    """A `modal` stand-in that fails loudly on any attribute access.

    Real modal is installed in the dev venv for the live tier, so a unit test that
    forgets the `fake_modal` fixture would otherwise reach the real SDK and, with
    developer credentials configured, create real billed sandboxes. This is the
    `ALLOW_MODEL_REQUESTS = False` of the Modal seam.
    """

    def __getattr__(self, name: str) -> object:  # pragma: no cover - tripwire, hit only by a misbehaving test
        raise AssertionError(
            'A modal_sandbox unit test touched the real `modal` package. '
            'Use the `fake_modal` fixture, or mark the test `modal_live`.'
        )


@pytest.fixture(autouse=True)
def _no_real_modal(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Poison `modal` for every test here except the opt-in live tier."""
    if 'modal_live' in request.keywords:  # pragma: no cover - live tier runs without coverage
        yield
        return
    monkeypatch.setitem(sys.modules, 'modal', _PoisonedModal('modal'))
    yield


@pytest.fixture(autouse=True)
def _fresh_missing_tools_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    """Re-arm the once-per-process warning so each test sees it independently of test order."""
    monkeypatch.setattr('pydantic_ai_harness.modal_sandbox._capability._warned_no_workspace_tools', False)


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


@pytest.fixture
def fake_modal(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeModal]:
    """Inject a fake `modal` module and yield its control surface."""
    control = FakeModal()
    monkeypatch.setitem(sys.modules, 'modal', control.module)
    yield control
