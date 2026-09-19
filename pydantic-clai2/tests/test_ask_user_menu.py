"""Inline questions driven through real prompt-toolkit input and the agent tool."""

import asyncio
import io
import signal
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import anyio
import pytest
from prompt_toolkit.application import create_app_session
from prompt_toolkit.data_structures import Size
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.output import DummyOutput
from prompt_toolkit.output.vt100 import Vt100_Output
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai_harness.ask_user import (
    DECLINED,
    AskUser,
    AskUserAnswer,
    AskUserAnsweredEvent,
    AskUserRequest,
    AskUserResponse,
    Question,
    QuestionOption,
)
from rich.console import Console

from pydantic_clai2 import DEFAULT_PLUGINS
from pydantic_clai2.ask_user_menu import QuestionMenu, TerminalAnswerer, activate, render_answer
from pydantic_clai2.interrupts import Interrupts
from pydantic_clai2.plugins import PluginHost

APPROACH = Question(
    header='Approach',
    question='How should we do it?',
    options=(QuestionOption(label='Refactor', description='Rewrite the module'), QuestionOption(label='Patch')),
)
TARGETS = Question(
    header='Targets',
    question='Which files?',
    options=(QuestionOption(label='api.py'), QuestionOption(label='db.py')),
    multi_select=True,
)


class ScreenLog:
    """Track ownership without replacing terminal input."""

    def __init__(self) -> None:
        self.events: list[str] = []
        self.entered: asyncio.Queue[None] = asyncio.Queue()

    @asynccontextmanager
    async def __call__(self) -> AsyncGenerator[None]:
        self.events.append('taken')
        self.entered.put_nowait(None)
        try:
            yield
        finally:
            self.events.append('released')


@pytest.mark.parametrize(
    ('question', 'keys', 'expected'),
    [
        (APPROACH, '\r', ('Refactor',)),
        (APPROACH, '2', ('Patch',)),
        (APPROACH, '\x1b[B\r', ('Patch',)),
        (APPROACH, '\x1b[A\r', ('Patch',)),
        (TARGETS, '12\x1b[B\r', ('api.py', 'db.py')),
        (TARGETS, '112\x1b[B\r', ('db.py',)),
        (TARGETS, '\x1b[A\r\x1b[B\r\x1b[A\r', ('api.py',)),
    ],
)
async def test_selection_without_space(question: Question, keys: str, expected: tuple[str, ...]) -> None:
    screen = ScreenLog()
    with create_pipe_input() as pipe, create_app_session(input=pipe, output=DummyOutput()):
        pipe.send_text(keys)
        response = await TerminalAnswerer(full_screen=screen)(AskUserRequest(questions=(question,)))
    assert response == AskUserResponse(answers=(AskUserAnswer(header=question.header, selected=expected),))
    assert screen.events == ['taken', 'released']


@pytest.mark.parametrize('key', ['\x1b', '\x03', '\x04'])
async def test_decline(key: str) -> None:
    with create_pipe_input() as pipe, create_app_session(input=pipe, output=DummyOutput()):
        pipe.send_text(key)
        response = await TerminalAnswerer(full_screen=ScreenLog())(AskUserRequest(questions=(APPROACH,)))
    assert response == AskUserResponse(cancelled=True)


async def test_questions_leave_scrollback_and_show_position() -> None:
    screen = ScreenLog()
    output = io.StringIO()
    terminal = Vt100_Output(output, lambda: Size(rows=30, columns=100), term='xterm-256color', enable_cpr=False)
    with create_pipe_input() as pipe, create_app_session(input=pipe, output=terminal):
        questions = (APPROACH, TARGETS)
        for position, question in enumerate(questions, 1):
            app = QuestionMenu(question=question, position=position, total=2).build()
            pipe.send_text('2' if position == 1 else '1\x1b[A\r')
            async with screen():
                assert await app.run_async() == (('Patch',) if position == 1 else ('api.py',))
    text = output.getvalue()
    assert 'Approach (question 1 of 2)' in text
    assert 'Targets (question 2 of 2)' in text
    assert 'How should we do it?' in text
    assert 'Rewrite the module' in text
    assert 'Space' not in text
    assert '\x1b[?1049h' not in text
    assert '\x1b[2J' not in text


@pytest.mark.parametrize('decline_second', [False, True])
async def test_request_with_multiple_questions(decline_second: bool) -> None:
    class Output(io.StringIO):
        sent = False

        def write(self, text: str) -> int:
            if 'Targets' in text and not self.sent:
                self.sent = True
                pipe.send_text('\x1b' if decline_second else '12\x1b[B\r')
            return super().write(text)

    output = Output()
    terminal = Vt100_Output(output, lambda: Size(rows=24, columns=80), term='xterm-256color', enable_cpr=False)
    with create_pipe_input() as pipe, create_app_session(input=pipe, output=terminal):
        pipe.send_text('2')
        response = await TerminalAnswerer(full_screen=ScreenLog())(AskUserRequest(questions=(APPROACH, TARGETS)))
    if decline_second:
        assert response == AskUserResponse(cancelled=True)
    else:
        assert response.answers == (
            AskUserAnswer(header='Approach', selected=('Patch',)),
            AskUserAnswer(header='Targets', selected=('api.py', 'db.py')),
        )


async def test_parallel_requests_take_the_terminal_one_at_a_time() -> None:
    screen = ScreenLog()
    answerer = TerminalAnswerer(full_screen=screen)
    second_started = asyncio.Event()

    async def second_request() -> AskUserResponse:
        second_started.set()
        return await answerer(AskUserRequest(questions=(APPROACH,)))

    with create_pipe_input() as pipe, create_app_session(input=pipe, output=DummyOutput()):
        async with asyncio.TaskGroup() as tasks:
            first = tasks.create_task(answerer(AskUserRequest(questions=(APPROACH,))))
            await screen.entered.get()
            second = tasks.create_task(second_request())
            await second_started.wait()
            assert screen.events == ['taken']
            pipe.send_text('2')
            assert (await first).answers == (AskUserAnswer(header='Approach', selected=('Patch',)),)
            await screen.entered.get()
            pipe.send_text('1')
            assert (await second).answers == (AskUserAnswer(header='Approach', selected=('Refactor',)),)
    assert screen.events == ['taken', 'released', 'taken', 'released']


async def test_outer_cancellation_releases_input_and_terminal() -> None:
    screen = ScreenLog()
    answerer = TerminalAnswerer(full_screen=screen)
    with create_pipe_input() as pipe, create_app_session(input=pipe, output=DummyOutput()):
        async with anyio.create_task_group() as tasks:
            tasks.start_soon(answerer, AskUserRequest(questions=(APPROACH,)))
            await screen.entered.get()
            tasks.cancel_scope.cancel()
        assert screen.events == ['taken', 'released']
        pipe.send_text('2')
        response = await answerer(AskUserRequest(questions=(APPROACH,)))
    assert response.answers == (AskUserAnswer(header='Approach', selected=('Patch',)),)


async def test_process_sigint_cancels_the_turn_while_question_is_open() -> None:
    class Output(io.StringIO):
        sent = False

        def write(self, text: str) -> int:
            if 'Approach' in text and not self.sent:
                self.sent = True
                signal.raise_signal(signal.SIGINT)
            return super().write(text)

    output = Output()
    terminal = Vt100_Output(output, lambda: Size(rows=24, columns=80), term='xterm-256color', enable_cpr=False)
    screen = ScreenLog()
    original = signal.getsignal(signal.SIGINT)

    async def ask() -> None:
        await TerminalAnswerer(full_screen=screen)(AskUserRequest(questions=(APPROACH,)))
        pytest.fail('SIGINT must cancel the turn, not complete the question')

    with create_pipe_input() as pipe, create_app_session(input=pipe, output=terminal), anyio.fail_after(15):
        assert not await Interrupts().run(ask())
    assert output.sent
    assert screen.events == ['taken', 'released']
    assert signal.getsignal(signal.SIGINT) == original


def test_render_answer_lists_picks_or_the_decline() -> None:
    answered = AskUserAnsweredEvent(
        request_id='r1',
        response=AskUserResponse(
            answers=(
                AskUserAnswer(header='Approach', selected=('Patch',)),
                AskUserAnswer(header='Targets', selected=('api.py', 'db.py')),
            )
        ),
    )
    output = io.StringIO()
    console = Console(file=output, width=80)
    console.print(render_answer(answered))
    console.print(render_answer(AskUserAnsweredEvent(request_id='r2', response=AskUserResponse(cancelled=True))))
    text = output.getvalue()
    assert '● Approach: Patch\n● Targets: api.py, db.py\n' in text
    assert '● You declined to answer' in text


async def test_activate_registers_capability_and_renderer() -> None:
    host: PluginHost[None] = PluginHost(name='ask_user', console=Console(file=io.StringIO()), settings={})
    activate(host)
    (capability,) = host.capabilities
    assert isinstance(capability, AskUser)
    (renderer,) = host.renderers
    assert renderer(AskUserAnsweredEvent(request_id='r', response=AskUserResponse(cancelled=True))) is not None
    assert any(plugin.id == 'ask_user' for plugin in DEFAULT_PLUGINS)


@pytest.mark.parametrize('keys', ['2', '\x1b'])
async def test_answers_reach_the_model_through_the_plugin(keys: str) -> None:
    host: PluginHost[None] = PluginHost(name='ask_user', console=Console(file=io.StringIO()), settings={})
    activate(host)

    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(parts=[ToolCallPart('ask_user_question', {'questions': [APPROACH.model_dump()]})])
        return ModelResponse(parts=[TextPart('done')])

    agent = Agent(FunctionModel(respond), deps_type=type(None), capabilities=host.capabilities)
    with create_pipe_input() as pipe, create_app_session(input=pipe, output=DummyOutput()):
        pipe.send_text(keys)
        result = await agent.run('go')
    assert result.output == 'done'
    returns = [part for message in result.all_messages() for part in message.parts if isinstance(part, ToolReturnPart)]
    assert len(returns) == 1
    assert returns[0].content == (DECLINED if keys == '\x1b' else {'Approach': ['Patch']})
