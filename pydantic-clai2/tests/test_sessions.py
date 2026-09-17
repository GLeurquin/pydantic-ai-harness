"""Sessions over the harness store: the plugin, listing, resume, rename, delete, and the shell end to end."""

import asyncio
import io
import signal
from pathlib import Path

import pytest
from prompt_script import inputs
from pydantic_ai import Agent, ModelRequestContext, RunContext
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, UserPromptPart
from pydantic_ai.models.test import TestModel
from pydantic_ai_harness.step_persistence import InMemoryStepStore, RunRecord, SqliteStepStore, StepPersistence
from rich.console import Console
from session_script import persisted, prompts, turns

from pydantic_clai2 import Session, chat
from pydantic_clai2.config import PluginSettings
from pydantic_clai2.persistence import CWD_KEY, activate
from pydantic_clai2.plugins import PluginHost
from pydantic_clai2.sessions import NEWEST, Sessions, find_store, first_prompt, last_reply
from pydantic_clai2.settings_store import config_dir
from pydantic_clai2.status import Status


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


def conversation(*prompts: str) -> list[ModelMessage]:
    messages: list[ModelMessage] = []
    for prompt in prompts:
        messages.append(ModelRequest(parts=[UserPromptPart(prompt)]))
        messages.append(ModelResponse(parts=[TextPart(f'reply to {prompt}')]))
    return messages


def persistence_plugin(database: Path) -> PluginSettings:
    return PluginSettings(
        id='persistence', factory='pydantic_clai2.persistence:activate', settings={'database': str(database)}
    )


def test_plugin_registers_step_persistence_over_sqlite(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    host: PluginHost[None] = PluginHost(name='persistence', console=Console(file=io.StringIO()), settings={})
    activate(host)
    (capability,) = host.capabilities
    assert isinstance(capability, StepPersistence) and isinstance(capability.store, SqliteStepStore)
    assert capability.metadata == {CWD_KEY: str(tmp_path.resolve())}
    assert find_store(host.capabilities) is capability.store
    assert find_store([]) is None
    assert config_dir() == tmp_path / 'config' / 'pydantic-clai2', 'the conftest points XDG_CONFIG_HOME at tmp_path'


async def test_default_database_lives_in_the_config_dir(tmp_path: Path) -> None:
    host: PluginHost[None] = PluginHost(name='persistence', console=Console(file=io.StringIO()), settings={})
    activate(host)
    await turns(InMemoryStepStore(), tmp_path, 'warm up')
    session = Session(Agent(TestModel()), deps=None, plugins=host.capabilities)
    await session.prompt('hello')
    assert (config_dir() / 'sessions.db').is_file()


def test_plugin_settings_override_the_database(tmp_path: Path) -> None:
    host: PluginHost[None] = PluginHost(
        name='persistence', console=Console(file=io.StringIO()), settings={'database': str(tmp_path / 'x.db')}
    )
    activate(host)
    assert isinstance(find_store(host.capabilities), SqliteStepStore)


def test_prompt_and_reply_helpers() -> None:
    assert first_prompt([]) is None and last_reply([]) is None
    history: list[ModelMessage] = [
        ModelRequest(parts=[UserPromptPart(['not', 'text'])]),
        ModelResponse(parts=[TextPart('')]),
        *conversation('hi'),
        ModelRequest(parts=[UserPromptPart('again')]),
        ModelResponse(parts=[TextPart('a'), TextPart('b')]),
        ModelResponse(parts=[TextPart('')]),
        ModelRequest(parts=[UserPromptPart('pending')]),
    ]
    assert first_prompt(history) == 'hi' and last_reply(history) == 'ab'


async def test_listing_is_per_workspace_newest_first(tmp_path: Path) -> None:
    store = InMemoryStepStore()
    here, elsewhere = tmp_path / 'here', tmp_path / 'elsewhere'
    older = await turns(store, here, 'older one', 'older two')
    newer = await turns(store, here, 'newer')
    await turns(store, elsewhere, 'not mine')
    await store.register_run(RunRecord(run_id='stray', conversation_id=None, metadata={CWD_KEY: str(here.resolve())}))
    sessions = Sessions(Session(Agent(TestModel()), deps=None), store=lambda: store, workspace=here)
    listed = await sessions.listing()
    assert [entry.id for entry in listed] == [newer, older]
    assert [entry.label for entry in listed] == ['newer', 'older one']
    assert listed[1].workspace == str(here.resolve()) and listed[1].title is None
    assert prompts(listed[1].messages) == ['older one', 'older two']
    assert listed[1].updated_at > listed[1].started_at, 'updated_at follows the newest run'


async def test_resume_by_id_prefix_or_newest_restores_history(tmp_path: Path) -> None:
    store = InMemoryStepStore()
    first = await turns(store, tmp_path, 'first')
    second = await turns(store, tmp_path, 'second')
    seen: list[list[str]] = []

    class Seen(AbstractCapability[None]):
        async def before_model_request(
            self, ctx: RunContext[None], request_context: ModelRequestContext
        ) -> ModelRequestContext:
            seen.append(prompts(list(ctx.messages)))
            return request_context

    switches: list[str] = []
    session = Session(Agent(TestModel()), deps=None, plugins=[persisted(store, tmp_path), Seen()])
    sessions = Sessions(session, store=lambda: store, workspace=tmp_path, on_switch=lambda: switches.append('x'))
    assert await sessions.resume(NEWEST) == f'Resumed session {second} (2 messages): second'
    assert sessions.id == second and switches == ['x']
    await session.prompt('continued')
    assert seen == [['second', 'continued']]
    assert prompts((await sessions.listing())[0].messages) == ['second', 'continued'], (
        'the turn joined the same session'
    )
    assert (await sessions.resume(first[:8])).startswith(f'Resumed session {first}')
    assert await sessions.resume(first) == f'Resumed session {first} (2 messages): first'
    with pytest.raises(ValueError, match='No session nope'):
        await sessions.resume('nope')
    with pytest.raises(ValueError, match='matches 2 sessions'):
        await sessions.resume('')


async def test_resume_by_id_ignores_workspace_but_newest_does_not(tmp_path: Path) -> None:
    store = InMemoryStepStore()
    other = await turns(store, tmp_path / 'other', 'far away')
    sessions = Sessions(Session(Agent(TestModel()), deps=None), store=lambda: store, workspace=tmp_path)
    with pytest.raises(ValueError, match='No saved sessions for this workspace'):
        await sessions.resume(NEWEST)
    assert (await sessions.resume(other)).startswith(f'Resumed session {other}')


async def test_conversation_without_a_snapshot_is_listed_but_not_resumable(tmp_path: Path) -> None:
    store = InMemoryStepStore()
    good = await turns(store, tmp_path, 'good')
    await store.register_run(RunRecord(run_id='r-empty', conversation_id='empty', metadata={CWD_KEY: str(tmp_path)}))
    sessions = Sessions(Session(Agent(TestModel()), deps=None), store=lambda: store, workspace=tmp_path)
    listed = await sessions.listing()
    assert [(entry.id, entry.label) for entry in listed] == [('empty', '(no saved turns)'), (good, 'good')]
    assert listed[0].messages == []
    with pytest.raises(ValueError, match='Session empty has no saved turns'):
        await sessions.resume('empty')
    assert (await sessions.resume(NEWEST)).startswith(f'Resumed session {good}')


async def test_rename_and_delete(tmp_path: Path) -> None:
    store = InMemoryStepStore()
    session = Session(Agent(TestModel()), deps=None, plugins=[persisted(store, tmp_path)])
    mine = await turns(store, tmp_path, 'mine', session=session)
    other = await turns(store, tmp_path, 'other')
    sessions = Sessions(session, store=lambda: store, workspace=tmp_path)
    assert await sessions.rename(other, 'Greeting') == f'Renamed session {other}.'
    assert [entry.title for entry in await sessions.listing()] == ['Greeting', None]
    assert (await sessions.listing())[0].label == 'Greeting'
    assert await sessions.rename(other, None) == f'Cleared the title of session {other}.'
    assert [entry.title for entry in await sessions.listing()] == [None, None]
    assert (await store.get_run(run_id=(await store.list_runs(conversation_id=other))[0].run_id)) is not None
    with pytest.raises(ValueError, match='No session nope'):
        await sessions.rename('nope', 'x')
    assert await sessions.delete(other) == f'Deleted session {other}.'
    assert [entry.id for entry in await sessions.listing()] == [mine]
    notice = await sessions.delete(mine)
    assert notice.startswith(f'Deleted session {mine}. Started session ') and sessions.id != mine
    assert await sessions.listing() == [] and await store.list_runs() == []


async def test_without_the_plugin_every_operation_explains(tmp_path: Path) -> None:
    sessions = Sessions(Session(Agent(TestModel()), deps=None), store=lambda: None, workspace=tmp_path)
    for action in (sessions.listing(), sessions.resume(NEWEST), sessions.rename('a', 'b'), sessions.delete('a')):
        with pytest.raises(ValueError, match='persistence plugin is not loaded'):
            await action
    assert sessions.new().startswith('Started session ')


async def test_new_starts_a_fresh_conversation_id() -> None:
    session = Session(Agent(TestModel()), deps=None)
    before = session.conversation_id
    switches: list[str] = []
    sessions = Sessions(session, store=lambda: None, on_switch=lambda: switches.append('x'))
    await session.prompt('one')
    assert sessions.new() == f'Started session {session.conversation_id}.'
    assert session.conversation_id != before and session.messages == [] and switches == ['x']


async def test_restore_rejects_a_running_conversation() -> None:
    session = Session(Agent(TestModel()), deps=None)

    class Restore(AbstractCapability[None]):
        async def before_run(self, ctx: RunContext[None]) -> None:
            with pytest.raises(RuntimeError, match='running'):
                session.restore(conversation('x'), conversation_id='other')

    session.plugins = [Restore()]
    await session.prompt('go')
    assert prompts(session.messages) == ['go']


async def test_shell_persists_turns_and_resumes_them(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """End to end against the SQLite store: two runs of `chat`, the second resuming the first's newest session."""
    monkeypatch.chdir(tmp_path)
    plugin = persistence_plugin(tmp_path / 'sessions.db')
    seen: list[list[str]] = []

    class Seen(AbstractCapability[None]):
        async def before_model_request(
            self, ctx: RunContext[None], request_context: ModelRequestContext
        ) -> ModelRequestContext:
            seen.append(prompts(list(ctx.messages)))
            return request_context

    output = io.StringIO()
    inputs(monkeypatch, ['first', '/new', 'fresh', '/exit'])
    await chat(Agent(TestModel()), deps=None, console=Console(file=output), builtin_plugins=[plugin])
    store = SqliteStepStore(database=tmp_path / 'sessions.db')
    listed = await Sessions(Session(Agent(TestModel()), deps=None), store=lambda: store).listing()
    assert [prompts(entry.messages) for entry in listed] == [['fresh'], ['first']]
    first_id = listed[1].id
    inputs(monkeypatch, ['second', f'/resume {first_id}', 'third', '/exit'])
    await chat(
        Agent(TestModel(), deps_type=type(None), capabilities=[Seen()]),
        deps=None,
        console=Console(file=output),
        builtin_plugins=[plugin],
        resume=NEWEST,
    )
    assert 'Resumed session' in output.getvalue()
    assert seen == [['fresh', 'second'], ['first', 'third']]
    resumed = await Sessions(Session(Agent(TestModel()), deps=None), store=lambda: store).resume(first_id)
    assert resumed == f'Resumed session {first_id} (4 messages): first'


async def test_interrupted_tool_call_is_persisted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Ctrl-C while a tool runs keeps the model's reply so far; the harness marks the snapshot interrupted."""
    monkeypatch.chdir(tmp_path)
    agent: Agent[None, str] = Agent(TestModel(), deps_type=type(None))

    @agent.tool_plain
    async def slow() -> str:
        signal.raise_signal(signal.SIGINT)
        await asyncio.sleep(1)
        return 'never'

    inputs(monkeypatch, ['interrupted prompt', '/exit'])
    await chat(
        agent, deps=None, console=Console(file=io.StringIO()), builtin_plugins=[persistence_plugin(tmp_path / 's.db')]
    )
    store = SqliteStepStore(database=tmp_path / 's.db')
    (listed,) = await Sessions(Session(Agent(TestModel()), deps=None), store=lambda: store).listing()
    assert listed.snapshot is not None and listed.snapshot.state == 'interrupted'
    assert prompts(listed.messages) == ['interrupted prompt']


@pytest.mark.parametrize('target', [NEWEST, 'missing'])
async def test_startup_resume_reports_and_continues(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, target: str
) -> None:
    monkeypatch.chdir(tmp_path)
    output = io.StringIO()
    inputs(monkeypatch, ['/resume missing', '/exit'])
    await chat(
        Agent(TestModel()),
        deps=None,
        console=Console(file=output),
        builtin_plugins=[persistence_plugin(tmp_path / 's.db')],
        resume=target,
    )
    text = output.getvalue()
    expected = 'No saved sessions for this workspace' if target == NEWEST else 'No session missing'
    assert expected in text and 'Starting a new session instead' in text
    assert text.count('No session missing') == (1 if target == NEWEST else 2)


async def test_shell_without_persistence_plugin_says_so(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    output = io.StringIO()
    inputs(monkeypatch, ['/resume', '/exit'])
    await chat(Agent(TestModel()), deps=None, console=Console(file=output), resume=NEWEST)
    assert output.getvalue().count('persistence plugin is not loaded') == 2


def test_status_reset_on_switch() -> None:
    status = Status(context_tokens=5, output_tokens=6, streamed_chars=7)
    status.reset()
    assert (status.context_tokens, status.output_tokens, status.streamed_chars) == (None, None, 0)
