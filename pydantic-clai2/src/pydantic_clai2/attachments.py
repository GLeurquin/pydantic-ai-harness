"""Turn prompt text with `@path` references and pasted images into a multimodal user prompt."""

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from pydantic_ai.messages import BinaryContent, UserContent

from .clipboard import Clipboard

IMAGE_MEDIA_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
}
MAX_ATTACHMENT_BYTES = 1_000_000
"""Larger files are left as plain text; the coding tools read those in pages."""

_REFERENCE = re.compile(r'(?<![\w@])@(?:"([^"\n]+)"|(\S+?))[.,;:!?)\]}"\']*(?=\s|$)')
"""`@path` or `@"path with spaces"`. An `@` after a word character is an email or handle, and punctuation
closing the sentence is not part of the path."""
_FENCE = re.compile(r'`{3,}')


@dataclass(kw_only=True)
class Resolved:
    """What a prompt becomes: the content core receives, plus what could not be attached."""

    content: str | Sequence[UserContent]
    warnings: list[str] = field(default_factory=list[str])


@dataclass(kw_only=True)
class Attachments:
    """Resolve `@path` tokens per prompt and hold clipboard images until the next one."""

    root: Path
    clipboard: Clipboard
    pending: list[BinaryContent] = field(default_factory=list[BinaryContent])

    def paste(self) -> str:
        """The `/paste` command: queue the clipboard image for the next prompt."""
        data = self.clipboard.image()
        if data is None:
            return 'No image on the clipboard.'
        self.pending.append(BinaryContent(data, media_type='image/png'))
        return f'Attached a {len(data) / 1024:.1f} KB PNG image to the next prompt ({len(self.pending)} queued).'

    def resolve(self, text: str) -> Resolved:
        """Attach every readable `@path` and drain pasted images; the text itself is left untouched."""
        resolved = Resolved(content=text)
        items: list[UserContent] = []
        for match in _REFERENCE.finditer(text):
            reference = match.group(1) or match.group(2)
            try:
                items.append(_load(reference, self.root / Path(reference).expanduser()))
            except (OSError, ValueError) as exc:
                resolved.warnings.append(f'@{reference} left as text: {exc}')
        items.extend(self.pending)
        self.pending.clear()
        if items:
            resolved.content = [text, *items]
        return resolved


def _load(reference: str, path: Path) -> str | BinaryContent:
    """Read one reference; `ValueError` (including a decode error) or `OSError` says why it stays text."""
    if not path.is_file():
        raise ValueError('it is a directory' if path.is_dir() else 'no such file')
    size = path.stat().st_size
    if size > MAX_ATTACHMENT_BYTES:
        raise ValueError(f'{size} bytes exceeds the {MAX_ATTACHMENT_BYTES} byte limit')
    media_type = IMAGE_MEDIA_TYPES.get(path.suffix.lower())
    if media_type is not None:
        return BinaryContent(path.read_bytes(), media_type=media_type)
    return _fenced(reference, path.read_text(encoding='utf-8'))


def _fenced(reference: str, content: str) -> str:
    longest = max((len(run) for run in _FENCE.findall(content)), default=2)
    fence = '`' * (longest + 1)
    newline = '' if content.endswith('\n') else '\n'
    return f'{reference}:\n{fence}\n{content}{newline}{fence}'
