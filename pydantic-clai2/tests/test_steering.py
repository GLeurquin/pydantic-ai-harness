"""Steering: user text delivered into a running turn at its next model request."""

from collections.abc import Awaitable

import anyio
import pytest
from pydantic_ai import Agent, AgentRunResult, ModelRequestContext, RunContext, UsageLimitExceeded
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.messages import ModelMessage, ModelRequest, ToolReturnPart, UserPromptPart
from pydantic_ai.models import Model
from pydantic_ai.models.test import TestModel
from pydantic_ai.usage import UsageLimits

from pydantic_clai2 import Session
from pydantic_clai2.commands import steer_command


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


def user_prompts(messages: list[ModelMessage]) -> list[str]:
    return [
        part.content
        for message in messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, UserPromptPart) and isinstance(part.content, str)
    ]


class ModelView(AbstractCapability[None]):
    """Record the user prompts each model request carries, as the model sees them."""

    def __init__(self) -> None:
        self.requests: list[list[str]] = []

    async def before_model_request(
        self, ctx: RunContext[None], request_context: ModelRequestContext
    ) -> ModelRequestContext:
        self.requests.append(user_prompts(request_context.messages))
        return request_context


async def test_steer_reaches_the_next_model_request_without_cancelling_tools() -> None:
    started = anyio.Event()
    release = anyio.Event()
    agent = Agent(TestModel(custom_output_text='done'))

    @agent.tool_plain
    async def wait() -> str:
        started.set()
        await release.wait()
        return 'ok'

    view = ModelView()
    session = Session(agent, deps=None, plugins=[view])
    assert not session.running

    async def turn() -> None:
        await session.prompt('first')

    async with anyio.create_task_group() as tasks:
        tasks.start_soon(turn)
        await started.wait()
        assert session.running
        assert await session.steer('also this') is None
        release.set()

    assert view.requests == [['first'], ['first', 'also this']]
    history = session.messages
    assert user_prompts(history) == ['first', 'also this']
    tool_returns = [part for message in history if isinstance(message, ModelRequest) for part in message.parts]
    assert any(isinstance(part, ToolReturnPart) and part.content == 'ok' for part in tool_returns)
    assert not session.running


async def test_steer_before_the_run_streams_is_held_until_it_does() -> None:
    resolving = anyio.Event()
    resolved = anyio.Event()
    view = ModelView()
    session = Session(Agent(TestModel(custom_output_text='done')), deps=None, plugins=[view])
    session.model = 'test'

    def resolve(name: str) -> Awaitable[Model | str]:
        async def wait() -> Model | str:
            resolving.set()
            await resolved.wait()
            return name

        return wait()

    session.resolve_model = resolve

    async def turn() -> None:
        await session.prompt('first')

    async with anyio.create_task_group() as tasks:
        tasks.start_soon(turn)
        await resolving.wait()
        await session.steer('early')
        resolved.set()

    assert view.requests == [['first'], ['first', 'early']]
    assert user_prompts(session.messages) == ['first', 'early']


class Late(AbstractCapability[None]):
    """Steer once the queue has closed but before `prompt` has returned."""

    def __init__(self) -> None:
        self.session: Session[None, str] | None = None
        self.runs = 0

    async def after_run(self, ctx: RunContext[None], *, result: AgentRunResult[str]) -> AgentRunResult[str]:
        self.runs += 1
        if self.runs == 1:
            assert self.session is not None
            await self.session.steer('late one')
            await self.session.steer('late two')
        return result


async def test_steer_after_the_last_model_request_becomes_a_follow_up_run() -> None:
    late = Late()
    view = ModelView()
    session = Session(Agent(TestModel(custom_output_text='done')), deps=None, plugins=[late, view])
    late.session = session
    result = await session.prompt('first')
    assert late.runs == 2
    assert result.output == 'done'
    assert result.usage.requests == 2
    assert view.requests == [['first'], ['first', 'late one\n\nlate two']]
    assert user_prompts(session.messages) == ['first', 'late one\n\nlate two']


async def test_follow_up_run_counts_against_the_prompt_limits() -> None:
    late = Late()
    session = Session(
        Agent(TestModel(custom_output_text='done')),
        deps=None,
        plugins=[late],
        usage_limits=UsageLimits(request_limit=1),
    )
    late.session = session
    with pytest.raises(UsageLimitExceeded):
        await session.prompt('first')
    assert not session.running


async def test_steer_while_idle_is_a_normal_prompt() -> None:
    view = ModelView()
    session = Session(Agent(TestModel(custom_output_text='done')), deps=None, plugins=[view])
    result = await session.steer('hello')
    assert result is not None and result.output == 'done'
    assert view.requests == [['hello']]
    assert user_prompts(session.messages) == ['hello']
    assert (await session.prompt('again')).output == 'done'
    assert user_prompts(session.messages) == ['hello', 'again']


async def test_steer_command_routes_into_the_running_turn_only() -> None:
    started = anyio.Event()
    release = anyio.Event()
    agent = Agent(TestModel(custom_output_text='done'))

    @agent.tool_plain
    async def wait() -> str:
        started.set()
        await release.wait()
        return 'ok'

    session = Session(agent, deps=None)
    with pytest.raises(ValueError, match='Usage'):
        await steer_command(session, [])
    assert (await steer_command(session, ['hello'])).startswith('No turn is running')
    assert session.messages == []

    async def turn() -> None:
        await session.prompt('first')

    async with anyio.create_task_group() as tasks:
        tasks.start_soon(turn)
        await started.wait()
        assert (await steer_command(session, ['look', 'here'])).startswith('Queued')
        release.set()
    assert user_prompts(session.messages) == ['first', 'look here']
