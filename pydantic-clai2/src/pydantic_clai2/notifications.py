"""Best-effort native desktop notifications without conversation content."""

import os
from subprocess import DEVNULL
from sys import platform

from anyio import create_task_group, move_on_after, run_process
from pydantic_ai import RunContext
from pydantic_ai_harness.ask_user import AskUserRequestedEvent

from .plugins import PluginHost, TurnEnd


def activate(host: PluginHost[None]) -> None:
    """Notify on completed or failed turns and when `AskUser` requests an answer."""

    @host.on('turn_end')
    async def turn_ended(event: TurnEnd) -> None:
        if event.outcome == 'completed':
            await _notify('Turn completed.')
        elif event.outcome == 'failed':
            await _notify('Turn failed. Return to CLAI2 for details.')

    @host.on(AskUserRequestedEvent)
    async def attention(ctx: RunContext[None], event: AskUserRequestedEvent) -> None:
        await _notify('Your input is needed. Return to CLAI2 to answer.')


async def _notify(message: str) -> None:
    if platform == 'darwin':
        command = [
            '/usr/bin/osascript',
            '-e',
            'on run argv\ndisplay notification (item 1 of argv) with title "CLAI2"\nend run',
            message,
        ]
    elif platform == 'linux':
        command = ['/usr/bin/notify-send', '--app-name=CLAI2', '--', 'CLAI2', message]
    else:
        return

    environment = {
        name: os.environ[name]
        for name in ('DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XAUTHORITY')
        if name in os.environ
    }

    async def deliver() -> None:
        try:
            await run_process(command, stdin=DEVNULL, stdout=DEVNULL, stderr=DEVNULL, env=environment, check=False)
        except OSError:
            pass

    # Level cancellation ensures run_process reaps its child after a shell Task.cancel().
    with move_on_after(2):
        async with create_task_group() as workers:
            workers.start_soon(deliver)
