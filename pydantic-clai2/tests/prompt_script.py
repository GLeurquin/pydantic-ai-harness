"""Scripted prompt input so the shell can be driven without a terminal."""

from typing import Generic, TypeVar

import pytest
from prompt_toolkit.styles import BaseStyle

PromptT = TypeVar('PromptT')


def inputs(monkeypatch: pytest.MonkeyPatch, values: list[str | BaseException]) -> None:
    """Replace the prompt with one that returns (or raises) each value in turn."""

    class Prompt(Generic[PromptT]):
        def __init__(self, **kwargs: object) -> None:
            style = kwargs['style']
            assert isinstance(style, BaseStyle)
            for selector in ('class:bottom-toolbar', 'class:bottom-toolbar.text'):
                assert style.get_attrs_for_style_str(selector).color == '9B77FF'

        async def prompt_async(self, label: str) -> str:
            value = values.pop(0)
            if isinstance(value, BaseException):
                raise value
            return value

    monkeypatch.setattr('pydantic_clai2._app.PromptSession', Prompt)
