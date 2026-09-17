"""The built-in `diff` plugin: a ledger of the agent's file changes, shown on `/diff`."""

import io
from collections.abc import Callable
from pathlib import Path

import pytest
from pydantic_ai import Agent, RunContext
from pydantic_ai.capabilities import Capability
from pydantic_ai.models.test import TestModel
from pydantic_ai_harness.filesystem import FileChangeRequestEvent, FileOperation, FileWrittenEvent
from rich.console import Console
from test_app_edges import inputs

from pydantic_clai2 import DEFAULT_PLUGINS, Session, chat
from pydantic_clai2.plugins import HistoryClear, PluginHost, TurnEnd
from pydantic_clai2.session_diff import SessionDiff, activate, unified_diff
from pydantic_clai2.settings_store import SettingsStore


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


class Plugin:
    """The `diff` plugin on its own host, driven by synthetic filesystem events."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.output = io.StringIO()
        self.host: PluginHost[None] = PluginHost(name='diff', console=Console(file=self.output, width=120), settings={})
        activate(self.host)

    async def change(
        self,
        name: str,
        apply: Callable[[Path], None],
        *,
        operation: FileOperation = 'write',
        announce: bool = True,
        commit: bool = True,
    ) -> None:
        """One agent run whose tool announces a change, applies it, and reports it written."""
        emitter = Capability[None]()

        @emitter.tool
        async def edit(ctx: RunContext[None]) -> str:
            root = str(self.root)
            if announce:
                await ctx.emit(
                    FileChangeRequestEvent(path=name, root_dir=root, operation=operation, diff='', truncated=False)
                )
            apply(self.root / name)
            if commit:
                await ctx.emit(FileWrittenEvent(path=name, root_dir=root, content_hash='hash'))
            return 'ok'

        agent = Agent(TestModel(call_tools=['edit']), deps_type=type(None), capabilities=[emitter])
        await Session(agent, deps=None, plugins=self.host.capabilities).prompt('go')

    async def fire(self, event: TurnEnd | HistoryClear) -> None:
        for handler in self.host.handlers:
            await handler(event)

    def command(self, text: str) -> str:
        self.output.seek(0)
        self.output.truncate()
        result = self.host.commands.execute(text)
        assert isinstance(result, str)
        return self.output.getvalue()


def write(content: str | bytes) -> Callable[[Path], None]:
    def apply(path: Path) -> None:
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content)

    return apply


def remove(path: Path) -> None:
    path.unlink()


async def test_created_edited_and_deleted_files_diff_from_their_first_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    plugin = Plugin(tmp_path)
    (tmp_path / 'old.py').write_text('a = 1\n')
    (tmp_path / 'gone.py').write_text('y = 1\n')
    await plugin.change('new.py', write('x = 1\n'))
    await plugin.change('old.py', write('a = 2\n'))
    await plugin.change('old.py', write('a = 3\n'))
    await plugin.change('gone.py', remove)
    await plugin.change('brief.py', write('z = 1\n'))
    await plugin.change('brief.py', remove)

    text = plugin.command('/diff')
    assert '--- /dev/null\n+++ b/new.py\n' in text
    assert '+x = 1' in text
    assert '--- a/old.py\n+++ b/old.py\n' in text
    assert '-a = 1' in text and '+a = 3' in text and '+a = 2' not in text
    assert '--- a/gone.py\n+++ /dev/null\n' in text
    assert '-y = 1' in text
    assert 'brief.py' not in text

    stat = plugin.command('/diff --stat')
    assert 'old.py   +1 -1' in stat
    assert '3 files changed, 2 insertions(+), 2 deletions(-)' in stat
    completions = list(next(iter(plugin.host.commands)).complete([]))
    assert completions == ['--stat', 'new.py', 'old.py', 'gone.py', 'brief.py']


async def test_one_path_and_a_reverted_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    plugin = Plugin(tmp_path)
    (tmp_path / 'keep.txt').write_text('same\n')
    await plugin.change('keep.txt', write('changed\n'))
    await plugin.change('other.txt', write('hello\n'))
    assert '+hello' in plugin.command('/diff other.txt')
    assert 'keep.txt' not in plugin.command('/diff other.txt')
    assert plugin.command('/diff --stat other.txt').startswith('other.txt  +1 -0')
    assert plugin.command('/diff missing.txt') == 'No changes to missing.txt this conversation.\n'

    await plugin.change('keep.txt', write('same\n'))
    assert 'keep.txt' not in plugin.command('/diff')
    assert plugin.command('/diff keep.txt') == 'No changes to keep.txt this conversation.\n'


async def test_nothing_changed_unparseable_arguments_and_reset(tmp_path: Path) -> None:
    plugin = Plugin(tmp_path)
    assert plugin.command('/diff') == 'No files changed this conversation.\n'
    for bad in ('/diff a b', '/diff --nope'):
        with pytest.raises(ValueError, match='Usage: /diff'):
            plugin.host.commands.execute(bad)
    await plugin.change('a.txt', write('a\n'))
    assert '+a' in plugin.command('/diff')
    await plugin.fire(HistoryClear())
    assert plugin.command('/diff') == 'No files changed this conversation.\n'


async def test_unannounced_and_unapplied_changes(tmp_path: Path) -> None:
    plugin = Plugin(tmp_path)
    (tmp_path / 'silent.txt').write_text('first\n')
    await plugin.change('silent.txt', write('second\n'), announce=False)
    assert plugin.command('/diff') == 'No files changed this conversation.\n'
    await plugin.change('silent.txt', write('third\n'))
    assert '-second\n+third' in plugin.command('/diff')

    (tmp_path / 'refused.txt').write_text('before\n')
    await plugin.change('refused.txt', write('before\n'), commit=False)
    await plugin.fire(TurnEnd(text='go', outcome='completed'))
    (tmp_path / 'refused.txt').write_text('user edit\n')
    await plugin.change('refused.txt', write('agent edit\n'))
    assert '-user edit\n+agent edit' in plugin.command('/diff')
    assert 'before' not in plugin.command('/diff refused.txt')

    await plugin.change('dir', lambda path: path.mkdir(), operation='create_directory', commit=False)
    await plugin.change('<outside-workspace>', lambda path: None)
    assert '<outside-workspace>' not in plugin.command('/diff')


def test_unified_diff_keeps_byte_level_changes_visible() -> None:
    assert unified_diff(None, None, label='x') == ''
    assert unified_diff('a\n', 'a\n', label='x') == ''
    assert unified_diff('a\n', None, label='x').startswith('--- a/x\n+++ /dev/null\n')
    assert unified_diff('a\n', 'b\n', label='/abs/x').startswith('--- /abs/x\n+++ /abs/x\n')
    assert unified_diff(None, '', label='x') == '--- /dev/null\n+++ b/x'
    assert unified_diff('', None, label='x') == '--- a/x\n+++ /dev/null'
    assert unified_diff('a\n', 'a', label='x').endswith('-a\n+a\n\\ No newline at end of file')
    assert unified_diff('a\r\n', 'a\n', label='x').endswith('-a\r\n+a')
    assert '-\udcff\n+\ufffd' in unified_diff('\udcff\n', '\ufffd\n', label='x')


async def test_undecodable_bytes_and_line_endings_are_diffed_as_written(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    plugin = Plugin(tmp_path)
    (tmp_path / 'raw.bin').write_bytes(b'\xff\n')
    (tmp_path / 'crlf.txt').write_bytes(b'a\r\nb\r\n')
    (tmp_path / 'empty.txt').write_text('')
    await plugin.change('raw.bin', write('\ufffd\n'))
    await plugin.change('crlf.txt', write(b'a\nb\n'))
    await plugin.change('empty.txt', remove)
    await plugin.change('blank.txt', write(''))
    text = plugin.command('/diff')
    assert '-\\xdcff\n+\ufffd\n' in text
    assert '-a\\x0d\n-b\\x0d\n+a\n+b\n' in text
    assert '--- a/empty.txt\n+++ /dev/null\n' in text
    assert '--- /dev/null\n+++ b/blank.txt\n' in text
    assert 'empty.txt  +0 -0' in plugin.command('/diff --stat')


async def test_a_file_that_cannot_be_read_now_is_reported_not_hidden(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    plugin = Plugin(tmp_path)
    (tmp_path / 'swapped').write_text('text\n')
    await plugin.change('swapped', write('more\n'))
    await plugin.change('fine.txt', write('ok\n'))
    (tmp_path / 'swapped').unlink()
    (tmp_path / 'swapped').mkdir()
    text = plugin.command('/diff')
    assert text.startswith('swapped: cannot read it now (')
    assert '+ok' in text and '+++ /dev/null' not in text
    assert '1 files changed' in plugin.command('/diff --stat')
    assert plugin.command('/diff swapped').startswith('swapped: cannot read it now (')
    assert plugin.command('/diff --stat swapped').startswith('swapped: cannot read it now (')


def test_ledger_skips_paths_without_a_readable_baseline_and_is_keyed_by_resolved_path(tmp_path: Path) -> None:
    ledger = SessionDiff()
    (tmp_path / 'dir').mkdir()
    ledger.announce(tmp_path / 'dir')
    ledger.commit(tmp_path / 'dir')
    assert ledger.paths == []
    (tmp_path / 'f.txt').write_text('1\n')
    ledger.announce(tmp_path / 'sub' / '..' / 'f.txt')
    ledger.announce(tmp_path / 'f.txt')
    ledger.commit(tmp_path / 'f.txt')
    ledger.commit(tmp_path / 'f.txt')
    assert ledger.paths == [(tmp_path / 'f.txt').resolve()]
    assert list(ledger.changes()) == []
    (tmp_path / 'f.txt').write_text('2\n')
    assert [change.label for change in ledger.changes()] == [str((tmp_path / 'f.txt').resolve())]


async def test_new_resets_the_builtin_diff_plugin(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    inputs(monkeypatch, ['/plugins list', 'write it', '/diff --stat', '/new', '/diff', '/exit'])
    output = io.StringIO()
    (tmp_path / 'note.txt').write_text('old\n')

    emitter = Capability[None]()

    @emitter.tool
    async def edit(ctx: RunContext[None]) -> str:
        root = str(tmp_path)
        await ctx.emit(
            FileChangeRequestEvent(path='note.txt', root_dir=root, operation='edit', diff='', truncated=False)
        )
        (tmp_path / 'note.txt').write_text('new\n')
        await ctx.emit(FileWrittenEvent(path='note.txt', root_dir=root, content_hash='hash'))
        return 'ok'

    await chat(
        Agent(TestModel(call_tools=['edit']), deps_type=type(None), capabilities=[emitter]),
        deps=None,
        console=Console(file=output, width=120),
        store=SettingsStore(tmp_path / 'config.db'),
        builtin_plugins=DEFAULT_PLUGINS,
    )
    text = output.getvalue()
    assert 'diff: pydantic_clai2.session_diff (built-in) (enabled, loaded)' in text
    assert 'note.txt  +1 -1' in text
    assert 'Conversation cleared.' in text
    assert text.index('No files changed this conversation.') > text.index('Conversation cleared.')
