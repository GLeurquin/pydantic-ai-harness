"""Streaming terminal conversations with lazy exports for import-time branding."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ._app import DEFAULT_PLUGINS, chat, create_agent
    from ._one_shot import one_shot
    from ._rendering import StreamRenderer
    from ._session import Session

__all__ = ['DEFAULT_PLUGINS', 'Session', 'StreamRenderer', 'chat', 'create_agent', 'one_shot']


def __getattr__(name: str) -> object:
    if name in ('chat', 'create_agent', 'DEFAULT_PLUGINS'):
        from . import _app

        return getattr(_app, name)
    if name == 'Session':
        from ._session import Session

        return Session
    if name == 'StreamRenderer':
        from ._rendering import StreamRenderer

        return StreamRenderer
    if name == 'one_shot':
        from ._one_shot import one_shot

        return one_shot
    raise AttributeError(name)
