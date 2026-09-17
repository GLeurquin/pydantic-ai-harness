"""Interactive application error, cancellation, and input boundaries."""

from pathlib import Path

import anyio
import pytest
from chat_driver import blocking_agent, run_chat
from prompt_toolkit.input import PipeInput
from pydantic_ai import Agent, ModelRequestContext, RunContext
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.models.test import TestModel

from pydantic_clai2._completion_adapter import COMPLETION_STYLE
from pydantic_clai2.command_context import CommandContext
from pydantic_clai2.commands import Command
from pydantic_clai2.config import Settings


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


def test_toolbar_style_is_brand_purple() -> None:
    for selector in ('class:bottom-toolbar', 'class:bottom-toolbar.text'):
        assert COMPLETION_STYLE.get_attrs_for_style_str(selector).color == '9B77FF'


@pytest.mark.parametrize('mode', ['eof', 'interrupt', 'error', 'structured'])
async def test_chat_boundaries(tmp_path: Path, mode: str) -> None:
    text = ' \n/bad\nrun\n/exit\n'
    if mode == 'eof':
        text = '\x04'
    elif mode == 'interrupt':
        text = '\x03\x03'

    class Behaviour(AbstractCapability[None]):
        async def before_model_request(
            self, ctx: RunContext[None], request_context: ModelRequestContext
        ) -> ModelRequestContext:
            if mode == 'error':
                raise ValueError('broken provider')
            return request_context

    if mode == 'structured':
        agent = Agent(TestModel(), output_type=list[int])
    else:
        agent = Agent(TestModel(), deps_type=type(None), capabilities=[Behaviour()])
    output = await run_chat(agent, tmp_path=tmp_path, text=text, width=20 if mode == 'eof' else 120)
    if mode == 'error':
        assert 'broken provider' in output
    elif mode == 'interrupt':
        assert 'Input cleared' in output
    elif mode == 'structured':
        assert '[' in output


@pytest.mark.parametrize('double', [False, True])
async def test_ctrl_c_during_a_turn_cancels_then_exits(tmp_path: Path, double: bool) -> None:
    started = anyio.Event()

    async def press(pipe: PipeInput) -> None:
        await started.wait()
        pipe.send_text('\x03\x03' if double else '\x03/exit\n')

    output = await run_chat(blocking_agent(started=started), tmp_path=tmp_path, text='run\n', script=press)
    assert 'Turn cancelled.' in output
    assert 'never' not in output
    assert ('Goodbye.' in output) is not double


async def test_model_string_and_non_command_plugin(tmp_path: Path) -> None:
    class Provider(AbstractCapability[None]):
        def get_commands(self, context: CommandContext) -> list[Command]:
            return [Command(name='legacy', description='Legacy command', handler=lambda args: 'ok')]

    output = await run_chat(
        Agent('test'),
        tmp_path=tmp_path,
        text='/set\n/set display.thinking\n/config show\n/plugins list\n/new\n/legacy\n/exit\n',
        plugins=[AbstractCapability(), Provider()],
        settings=Settings(model='test'),
    )
    assert 'ok' in output


@pytest.mark.parametrize('provider', ['openrouter', 'vllm'])
async def test_connected_provider_resolution(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, provider: str) -> None:
    def model(name: str) -> TestModel:
        assert name == f'{provider}:test'
        return TestModel(custom_output_text='Connected response')

    monkeypatch.setattr(f'pydantic_clai2.{provider}.model', model)
    output = await run_chat(
        Agent(TestModel()), tmp_path=tmp_path, text='hello\n/exit\n', settings=Settings(model=f'{provider}:test')
    )
    assert 'Connected response' in output
