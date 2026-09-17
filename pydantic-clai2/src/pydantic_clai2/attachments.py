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
MAX_TEXT_BYTES = 1_000_000
"""Larger text files are left as plain text; the coding tools read those in pages."""
MAX_IMAGE_BYTES = 10_000_000
"""Applies to `@image` and `/paste`; a full-screen Retina screenshot is a few MB of PNG."""
MAX_PROMPT_BYTES = 20_000_000
"""Everything attached to one prompt, referenced files and pasted images together."""

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
        if len(data) > MAX_IMAGE_BYTES:
            return f'Clipboard image not attached: {len(data)} bytes exceeds the {MAX_IMAGE_BYTES} byte limit.'
        if len(data) > MAX_PROMPT_BYTES - self._queued_bytes():
            return f'Clipboard image not attached: the {MAX_PROMPT_BYTES} byte prompt budget is used up. Send a prompt first.'
        self.pending.append(BinaryContent(data, media_type='image/png'))
        return f'Attached a {len(data) / 1024:.1f} KB PNG image to the next prompt ({len(self.pending)} queued).'

    def resolve(self, text: str) -> Resolved:
        """Attach every readable `@path` once and drain pasted images; the text itself is left untouched."""
        resolved = Resolved(content=text)
        items: list[UserContent] = []
        seen: set[str] = set()
        budget = MAX_PROMPT_BYTES - self._queued_bytes()
        for match in _REFERENCE.finditer(text):
            reference = match.group(1) or match.group(2)
            if reference in seen:
                continue
            seen.add(reference)
            try:
                item = _load(reference, self.root / Path(reference).expanduser())
            except (OSError, ValueError, RuntimeError) as exc:
                resolved.warnings.append(f'@{reference} left as text: {exc}')
                continue
            size = len(item.data) if isinstance(item, BinaryContent) else len(item.encode())
            if size > budget:
                resolved.warnings.append(
                    f'@{reference} left as text: the {MAX_PROMPT_BYTES} byte prompt budget is used up'
                )
                continue
            budget -= size
            items.append(item)
        items.extend(self.pending)
        self.pending.clear()
        if items:
            resolved.content = [text, *items]
        return resolved

    def _queued_bytes(self) -> int:
        return sum(len(image.data) for image in self.pending)


def _load(reference: str, path: Path) -> str | BinaryContent:
    """Read one reference; `ValueError` (including a decode error) or `OSError` says why it stays text."""
    if not path.is_file():
        raise ValueError('it is a directory' if path.is_dir() else 'no such file')
    media_type = IMAGE_MEDIA_TYPES.get(path.suffix.lower())
    size = path.stat().st_size
    limit = MAX_TEXT_BYTES if media_type is None else MAX_IMAGE_BYTES
    if size > limit:
        raise ValueError(f'{size} bytes exceeds the {limit} byte limit')
    if media_type is not None:
        return BinaryContent(path.read_bytes(), media_type=media_type)
    return _fenced(reference, path.read_text(encoding='utf-8'))


def _fenced(reference: str, content: str) -> str:
    longest = max((len(run) for run in _FENCE.findall(content)), default=2)
    fence = '`' * (longest + 1)
    newline = '' if content.endswith('\n') else '\n'
    return f'{reference}:\n{fence}\n{content}{newline}{fence}'
