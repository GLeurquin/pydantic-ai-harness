"""Background tools capability that runs selected tools concurrently."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any, Literal

from pydantic_ai.capabilities import AbstractCapability, AgentNode, NodeResult, RawToolArgs
from pydantic_ai.exceptions import (
    ApprovalRequired,
    CallDeferred,
    ModelRetry,
    ToolFailedError,
    ToolRetryError,
    UnexpectedModelBehavior,
    UserError,
)
from pydantic_ai.messages import ToolCallPart, ToolReturn, ToolReturnPart, UserContent
from pydantic_ai.tools import (
    AgentDepsT,
    DeferredToolRequests,
    RunContext,
    ToolDefinition,
    ToolSelector,
    ToolSelectorFunc,
    matches_tool_selector,
)

if TYPE_CHECKING:
    from pydantic_ai._instructions import AgentInstructions
    from pydantic_ai.capabilities import WrapRunHandler, WrapToolExecuteHandler
    from pydantic_ai.run import AgentRunResult


_INSTRUCTIONS = """\
Some tools return right away and deliver their result later as a follow-up message. \
Pass `run_in_background=true` to a tool that accepts it when you want to keep working \
and get its result later.\
"""

_RUN_IN_BACKGROUND = 'run_in_background'


def _instructions(ctx: RunContext[Any]) -> str | None:
    # Realtime sessions run tools concurrently already; see `_background_mode`.
    return None if ctx.realtime else _INSTRUCTIONS


logger = logging.getLogger(__name__)


def _with_run_in_background(tool_def: ToolDefinition) -> ToolDefinition:
    """Add the optional `run_in_background` argument to a tool's schema."""
    properties = tool_def.parameters_json_schema.get('properties', {})
    if _RUN_IN_BACKGROUND in properties:
        raise UserError(
            f"Tool '{tool_def.name}' already has a '{_RUN_IN_BACKGROUND}' parameter, "
            'so it cannot be an optional background tool.'
        )
    flag = {
        'type': 'boolean',
        'description': 'Set to true to keep working and get the result later as a follow-up message.',
    }
    schema = {**tool_def.parameters_json_schema, 'properties': {**properties, _RUN_IN_BACKGROUND: flag}}
    return replace(tool_def, parameters_json_schema=schema)


def _any_of(selectors: Sequence[ToolSelector[AgentDepsT]]) -> ToolSelectorFunc[AgentDepsT]:
    """A selector that matches a tool if any of `selectors` does."""

    async def matches(ctx: RunContext[AgentDepsT], tool_def: ToolDefinition) -> bool:
        for selector in selectors:
            if await matches_tool_selector(selector, ctx, tool_def):
                return True
        return False

    return matches


def _format_background_error(error: ApprovalRequired | CallDeferred | ToolRetryError | ToolFailedError) -> str:
    """Describe a tool-signalled failure to the model."""
    if isinstance(error, (ApprovalRequired, CallDeferred)):
        return f'{type(error).__name__} was raised; background tools cannot defer a running task.'
    content = error.tool_retry.content if isinstance(error, ToolRetryError) else error.tool_failed.content
    return content if isinstance(content, str) and content else type(error).__name__


def _format_background_result(tool_name: str, task_id: str, result: Any) -> tuple[UserContent, ...]:
    """Format a tool result as model-visible user content without application metadata."""
    if isinstance(result, ToolReturn):
        return_value: object = result.return_value
        extra_content = result.content
    else:
        return_value = result
        extra_content = None

    return_part = ToolReturnPart(tool_name=tool_name, tool_call_id=task_id, content=return_value)
    return_text = return_part.model_response_str()
    content: list[UserContent] = [return_text, *return_part.files]
    if isinstance(extra_content, str):
        content.append(extra_content)
    elif extra_content is not None:
        content.extend(extra_content)

    prefix = f"Background tool '{tool_name}' (task {task_id}) completed.\nResult:"
    content[0] = f'{prefix} {content[0]}'

    if all(isinstance(item, str) for item in content):
        return ('\n'.join(item for item in content if isinstance(item, str)),)
    return tuple(content)


@dataclass
class BackgroundTools(AbstractCapability[AgentDepsT]):
    """Run selected tools concurrently with the current agent run.

    When the model calls a tool that matches the selector, the capability spawns the
    tool's handler in a run-owned task and immediately returns an acknowledgment
    string to the agent. When the task completes, its result (or error) is formatted as
    user content and enqueued via
    [`RunContext.enqueue`][pydantic_ai.tools.RunContext.enqueue] as an `'asap'` message.
    Pydantic AI's pending message queue delivers it on the next model request, or
    redirects the agent to a fresh request if it would otherwise end, so the model
    receives the result and can act on it while the run remains active.

    ```python
    import asyncio

    from pydantic_ai import Agent
    from pydantic_ai_harness import BackgroundTools

    # Default: any tool with `metadata={'background': True}` runs in the background.
    agent = Agent('openai:gpt-5.6-sol', capabilities=[BackgroundTools()])

    @agent.tool_plain(metadata={'background': True})
    async def slow_research(query: str) -> str:
        await asyncio.sleep(60)  # stand-in for a long-running job
        return f'Research findings for {query!r}'
    ```

    Combine with [`SetToolMetadata`][pydantic_ai.capabilities.SetToolMetadata] to mark
    several tools at once, or with `FunctionToolset.with_metadata(...)` to mark a whole
    toolset. Or pass a name list / predicate via `tools=...` to ignore metadata entirely.
    Use `optional_tools` to let the model choose per call whether a tool runs in the background.

    Warning:
        Run cleanup cancels live background tasks and waits for them, so async tools must
        propagate cancellation. A synchronous tool's worker thread cannot be stopped and
        runs concurrently with the agent: keep the state it touches thread-safe.

    Exceptions raised by the tool become failure messages; running out of retries ends the
    run, as it would for a sequential tool. Cancelling one background tool does not cancel
    its siblings. See the docs page for streaming, realtime and durable-execution limits.
    """

    tools: ToolSelector[AgentDepsT] = field(default_factory=lambda: {'background': True})
    """Which tools should run in the background.

    - `dict[str, Any]` (default `{'background': True}`): tools whose metadata deeply
      includes the given key-value pairs.
    - `'all'`: every tool in the agent's toolset (rarely what you want).
    - `Sequence[str]`: tools with matching names.
    - Callable `(ctx, tool_def) -> bool | Awaitable[bool]`: custom predicate.
    """

    optional_tools: ToolSelector[AgentDepsT] = field(default_factory=lambda: {'background': 'optional'})
    """Tools the model may run in the background per call.

    Matching tools gain an optional boolean `run_in_background` argument, which the tool function
    never receives; a call runs in the background only when the model passes `true`. Tools that
    also match `tools` always run in the background, and tools that cannot run in the background
    in this run (sequential tools, sequential runs, realtime sessions) are left unchanged.
    """

    id: str | None = 'background_tools'

    @classmethod
    def combine(cls, capabilities: Sequence[AbstractCapability[AgentDepsT]]) -> AbstractCapability[AgentDepsT]:
        """Combine selectors so each matching tool is scheduled exactly once."""
        merged = super().combine(capabilities)
        # Core only groups instances of the same capability class under one id.
        assert isinstance(merged, cls)

        instances: list[BackgroundTools[AgentDepsT]] = []
        for capability in capabilities:
            assert isinstance(capability, cls)
            instances.append(capability)
        return replace(
            merged,
            tools=_any_of([capability.tools for capability in instances]),
            optional_tools=_any_of([capability.optional_tools for capability in instances]),
        )

    _tasks: set[asyncio.Task[tuple[UserContent, ...]]] = field(
        default_factory=set[asyncio.Task[tuple[UserContent, ...]]], init=False, repr=False
    )
    """Live and finished background tasks; `after_node_run` sweeps the finished ones into the queue."""

    def get_instructions(self) -> AgentInstructions[AgentDepsT] | None:
        return _instructions

    async def for_run(self, ctx: RunContext[AgentDepsT]) -> BackgroundTools[AgentDepsT]:
        return replace(self)

    async def _background_mode(
        self, ctx: RunContext[AgentDepsT], tool_def: ToolDefinition
    ) -> Literal['always', 'optional'] | None:
        """Whether `tool_def` always runs in the background, may on request, or cannot in this run."""
        run_sequential = ctx.tool_manager is not None and ctx.tool_manager.get_parallel_execution_mode() == 'sequential'
        if ctx.realtime or run_sequential or tool_def.sequential:
            return None
        if await matches_tool_selector(self.tools, ctx, tool_def):
            return 'always'
        if await matches_tool_selector(self.optional_tools, ctx, tool_def):
            return 'optional'
        return None

    async def prepare_tools(self, ctx: RunContext[AgentDepsT], tool_defs: list[ToolDefinition]) -> list[ToolDefinition]:
        return [
            _with_run_in_background(tool_def) if await self._background_mode(ctx, tool_def) == 'optional' else tool_def
            for tool_def in tool_defs
        ]

    async def before_tool_validate(
        self,
        ctx: RunContext[AgentDepsT],
        *,
        call: ToolCallPart,
        tool_def: ToolDefinition,
        args: RawToolArgs,
    ) -> RawToolArgs:
        if await self._background_mode(ctx, tool_def) != 'optional':
            return args
        parsed: Any = args
        if isinstance(args, str):
            try:
                parsed = json.loads(args)
            except ValueError:
                return args  # Core turns malformed JSON into a retry.
        if not isinstance(parsed, dict):
            return args
        # The tool's validator rejects unknown arguments, so the flag is removed and checked here.
        stripped: dict[str, Any] = {**parsed}
        if not isinstance(stripped.pop(_RUN_IN_BACKGROUND, False), bool):
            raise ModelRetry(f'`{_RUN_IN_BACKGROUND}` must be true or false.')
        return stripped

    async def wrap_tool_execute(
        self,
        ctx: RunContext[AgentDepsT],
        *,
        call: ToolCallPart,
        tool_def: ToolDefinition,
        args: dict[str, Any],
        handler: WrapToolExecuteHandler,
    ) -> Any:
        mode = await self._background_mode(ctx, tool_def)
        # The flag was removed before validation, so it is read from the call as the model sent it.
        if mode is None or (mode == 'optional' and call.args_as_dict().get(_RUN_IN_BACKGROUND) is not True):
            return await handler(args)

        task_id = call.tool_call_id
        tool_name = call.tool_name

        async def _run() -> tuple[UserContent, ...]:
            try:
                result = await handler(args)
            except (ApprovalRequired, CallDeferred, ToolRetryError, ToolFailedError) as e:
                return (f"Background tool '{tool_name}' (task {task_id}) failed: {_format_background_error(e)}",)
            except UnexpectedModelBehavior:
                # Core raises this when the tool's retry budget runs out; end the run as a sequential tool would.
                raise
            except Exception as e:
                # Unexpected errors are logged in full; the model only learns the type.
                logger.exception('Background tool %s failed', tool_name)
                return (f"Background tool '{tool_name}' (task {task_id}) failed: {type(e).__name__}",)
            return _format_background_result(tool_name, task_id, result)

        def task_done(task: asyncio.Task[tuple[UserContent, ...]]) -> None:
            # Core counts a tool call when its handler returns, so hold the slot while the task runs.
            ctx.usage.tool_calls -= 1

        ctx.usage.tool_calls += 1
        task = asyncio.create_task(_run(), name=f'background tool {tool_name} ({task_id})')
        self._tasks.add(task)
        task.add_done_callback(task_done)
        return (
            f"Tool '{tool_name}' is running in background (task {task_id}). "
            f'If this run remains active, you will receive the result automatically when it completes. '
            f'Continue with other work in the meantime.'
        )

    async def after_node_run(
        self,
        ctx: RunContext[AgentDepsT],
        *,
        node: AgentNode[AgentDepsT],
        result: NodeResult[AgentDepsT],
    ) -> NodeResult[AgentDepsT]:
        from pydantic_graph import End

        if isinstance(result, End) and isinstance(result.data.output, DeferredToolRequests):
            # Finished tasks are left unswept so that a deferred-tool pause is not turned into
            # another model request by the end-of-run drain.
            return result

        while True:
            for task in [task for task in self._tasks if task.done()]:
                self._tasks.discard(task)
                if not task.cancelled():
                    ctx.enqueue(*task.result())
            # At the end of the run, wait for the first live task unless something is already
            # waiting to be delivered; the end-of-run drain then redirects the run to a new request.
            if not isinstance(result, End) or not self._tasks or ctx.pending_messages:
                return result
            await asyncio.wait(tuple(self._tasks), return_when=asyncio.FIRST_COMPLETED)

    async def wrap_run(
        self,
        ctx: RunContext[AgentDepsT],
        *,
        handler: WrapRunHandler,
    ) -> AgentRunResult[Any]:
        try:
            result = await handler()
        finally:
            tasks = tuple(self._tasks)
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
        for task in tasks:
            if not task.cancelled() and (error := task.exception()) is not None:
                raise error
        return result
