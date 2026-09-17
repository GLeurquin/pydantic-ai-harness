"""Multiline keys, `@path` completion and attachment, and `/paste` through a fake clipboard."""

import io
from pathlib import Path

import pytest
from prompt_toolkit import PromptSession
from prompt_toolkit.completion import CompleteEvent
from prompt_toolkit.document import Document
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.output import DummyOutput
from pydantic_ai import Agent
from pydantic_ai.messages import BinaryContent, ModelRequest, UserPromptPart
from pydantic_ai.models.test import TestModel
from rich.console import Console
from test_app_edges import inputs

from pydantic_clai2 import Session, chat
from pydantic_clai2.attachments import MAX_ATTACHMENT_BYTES, Attachments
from pydantic_clai2.commands import Command, Commands
from pydantic_clai2.prompt_input import PathReferenceCompleter, prompt_completer, prompt_key_bindings
from pydantic_clai2.settings_store import SettingsStore

PNG = b'\x89PNG\r\n\x1a\n' + bytes(16)


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


class FakeClipboard:
    def __init__(self, data: bytes | None) -> None:
        self.data = data

    def image(self) -> bytes | None:
        return self.data


@pytest.mark.parametrize(
    ('keys', 'expected'),
    [
        ('one\x1b\rtwo\r', 'one\ntwo'),
        ('one\ntwo\r', 'one\ntwo'),
        ('\x1b[200~one\ntwo\x1b[201~ three\r', 'one\ntwo three'),
        ('plain\r', 'plain'),
    ],
)
async def test_newline_keys_and_block_paste(keys: str, expected: str) -> None:
    with create_pipe_input() as pipe:
        session = PromptSession[str](input=pipe, output=DummyOutput(), key_bindings=prompt_key_bindings())
        pipe.send_text(keys)
        assert await session.prompt_async('> ') == expected


def test_path_completion(tmp_path: Path) -> None:
    (tmp_path / 'file.py').touch()
    (tmp_path / 'other.txt').touch()
    (tmp_path / 'sub').mkdir()
    (tmp_path / 'sub' / 'inner.md').touch()
    completer = PathReferenceCompleter(root=tmp_path)

    def complete(text: str) -> list[str]:
        return [item.text for item in completer.get_completions(Document(text), CompleteEvent())]

    assert complete('look at @') == ['file.py', 'other.txt', 'sub/']
    assert complete('@fi') == ['le.py']
    assert complete('@sub/') == ['inner.md']
    assert complete('@sub/in') == ['ner.md']
    assert complete('@missing/') == []
    assert complete('/set @') == []
    assert complete('no reference') == []
    commands = Commands()
    commands.register(Command(name='hello', description='hi', handler=lambda _: 'ok'))
    merged = prompt_completer(commands, root=tmp_path)
    assert [c.text for c in merged.get_completions(Document('/he'), CompleteEvent())] == ['hello']
    assert [c.text for c in merged.get_completions(Document('see @oth'), CompleteEvent())] == ['er.txt']


def test_resolve_references(tmp_path: Path) -> None:
    (tmp_path / 'notes.md').write_text('# Notes\n```py\nprint(1)\n```\n', encoding='utf-8')
    (tmp_path / 'shot.PNG').write_bytes(PNG)
    (tmp_path / 'binary.dat').write_bytes(b'\xff\xfe\x00')
    (tmp_path / 'big.txt').write_bytes(b'x' * (MAX_ATTACHMENT_BYTES + 1))
    (tmp_path / 'sub').mkdir()
    attachments = Attachments(root=tmp_path, clipboard=FakeClipboard(None))
    plain = attachments.resolve('nothing to attach, mail me@example.com')
    assert plain.content == 'nothing to attach, mail me@example.com'
    assert plain.warnings == []
    resolved = attachments.resolve('read @notes.md and @shot.PNG')
    assert isinstance(resolved.content, list)
    text, block, image = resolved.content
    assert text == 'read @notes.md and @shot.PNG'
    assert block == 'notes.md:\n````\n# Notes\n```py\nprint(1)\n```\n````'
    assert isinstance(image, BinaryContent) and image.media_type == 'image/png' and image.data == PNG
    problems = attachments.resolve('@missing.txt @sub @binary.dat @big.txt')
    assert problems.content == '@missing.txt @sub @binary.dat @big.txt'
    assert [warning.split(':')[0] for warning in problems.warnings] == [
        '@missing.txt left as text',
        '@sub left as text',
        '@binary.dat left as text',
        '@big.txt left as text',
    ]


def test_resolve_unreadable_file(tmp_path: Path) -> None:
    secret = tmp_path / 'secret.txt'
    secret.write_text('hidden', encoding='utf-8')
    secret.chmod(0)
    try:
        resolved = Attachments(root=tmp_path, clipboard=FakeClipboard(None)).resolve('@secret.txt')
    finally:
        secret.chmod(0o600)
    assert resolved.content == '@secret.txt'
    assert resolved.warnings and resolved.warnings[0].startswith('@secret.txt left as text: ')


def test_paste_queues_until_next_prompt(tmp_path: Path) -> None:
    empty = Attachments(root=tmp_path, clipboard=FakeClipboard(None))
    assert empty.paste() == 'No image on the clipboard.'
    assert empty.pending == []
    attachments = Attachments(root=tmp_path, clipboard=FakeClipboard(PNG))
    assert attachments.paste() == 'Attached a 0.0 KB PNG image to the next prompt (1 queued).'
    assert attachments.paste().endswith('(2 queued).')
    resolved = attachments.resolve('what is this?')
    assert isinstance(resolved.content, list)
    assert resolved.content[0] == 'what is this?'
    assert all(isinstance(item, BinaryContent) for item in resolved.content[1:])
    assert len(resolved.content) == 3
    assert attachments.pending == []
    assert attachments.resolve('again').content == 'again'


async def test_session_accepts_multimodal_content() -> None:
    session = Session(Agent(TestModel(custom_output_text='seen')), deps=None)
    content = ['describe', BinaryContent(PNG, media_type='image/png')]
    assert (await session.prompt(content)).output == 'seen'
    request = session.messages[0]
    assert isinstance(request, ModelRequest)
    part = request.parts[0]
    assert isinstance(part, UserPromptPart) and part.content == content


async def test_chat_attaches_paste_and_references(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'readme.txt').write_text('hello', encoding='utf-8')
    inputs(monkeypatch, ['/paste', 'summarise @readme.txt and @nope.txt', '/exit'])
    output = io.StringIO()
    await chat(
        Agent(TestModel(custom_output_text='done')),
        deps=None,
        console=Console(file=output, width=200),
        store=SettingsStore(tmp_path / 'config.db'),
        clipboard=FakeClipboard(PNG),
    )
    text = output.getvalue()
    assert 'Attached a 0.0 KB PNG image' in text
    assert '@nope.txt left as text: no such file' in text
    assert 'done' in text
