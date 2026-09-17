"""Read an image from the system clipboard through whichever tool the desktop provides."""

import os
import shutil
import subprocess
import sys
from typing import Protocol


class Clipboard(Protocol):
    """The one operation CLAI needs: PNG bytes from the clipboard, or `None` when it holds no image."""

    def image(self) -> bytes | None:
        """Return the clipboard image as PNG bytes, or `None`."""
        ...


class SystemClipboard:
    """macOS via `pngpaste` or `osascript`; Linux via `wl-paste` or `xclip`. Other platforms report no image."""

    def image(self) -> bytes | None:  # pragma: no cover -- talks to the desktop; tests inject a fake.
        """Try each available tool in turn; the first PNG wins."""
        for command in _commands():
            try:
                completed = subprocess.run(command, capture_output=True, timeout=10, check=False)
            except (OSError, subprocess.SubprocessError):
                continue
            data = _decode(completed.stdout) if completed.returncode == 0 else b''
            if data.startswith(_PNG_SIGNATURE):
                return data
        return None


_PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
_OSASCRIPT = ['osascript', '-e', 'the clipboard as \u00abclass PNGf\u00bb']
_OSASCRIPT_PREFIX = '\u00abdata PNGf'.encode()
_OSASCRIPT_SUFFIX = '\u00bb'.encode()


def _commands() -> list[list[str]]:  # pragma: no cover -- platform dispatch.
    if sys.platform == 'darwin':
        return [['pngpaste', '-']] if shutil.which('pngpaste') else [_OSASCRIPT]
    if sys.platform.startswith('linux'):
        commands: list[list[str]] = []
        if os.environ.get('WAYLAND_DISPLAY') and shutil.which('wl-paste'):
            commands.append(['wl-paste', '--no-newline', '--type', 'image/png'])
        if shutil.which('xclip'):
            commands.append(['xclip', '-selection', 'clipboard', '-t', 'image/png', '-o'])
        return commands
    return []


def _decode(stdout: bytes) -> bytes:  # pragma: no cover -- exercised only by the real clipboard.
    """`osascript` prints the PNG as hex between the markers; every other tool prints the PNG itself."""
    text = stdout.strip()
    if text.startswith(_OSASCRIPT_PREFIX) and text.endswith(_OSASCRIPT_SUFFIX):
        try:
            return bytes.fromhex(text[len(_OSASCRIPT_PREFIX) : -len(_OSASCRIPT_SUFFIX)].decode())
        except ValueError:
            return b''
    return stdout
