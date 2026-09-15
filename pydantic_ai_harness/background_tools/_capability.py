"""Background tools capability that runs selected tools concurrently."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any

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
Some tools run in the background: when you call them you'll get an immediate \
acknowledgment. If the run remains active, the result will be delivered \
automatically as a follow-up message when the task completes. Continue working on other \
things in the meantime; do not block waiting for the result. Some tools accept a \
`run_in_background` argument: pass `true` to run that call in the background when you have \
other useful work to do while waiting; otherwise omit it and the call runs normally.\
"""

_RUN_IN_BACKGROUND = 'run_in_background'

logger = logging.getLogger(__name__)


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

    Matching tools gain an optional boolean `run_in_background` argument; the tool function never
    receives it, and the call runs normally unless it is `true`. Tools that also match `tools`
    always run in the background and keep their schema, as do tools that cannot run in the
    background at all (sequential tools, sequential runs, realtime sessions).
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

    _tasks: set[asyncio.Task[None]] = field(default_factory=set[asyncio.Task[None]], init=False, repr=False)
    _optional_tool_names: set[str] = field(default_factory=set[str], init=False, repr=False)
    _background_calls: set[str] = field(default_factory=set[str], init=False, repr=False)
    _realtime: bool = field(default=False, init=False, repr=False)
    _completed: list[tuple[UserContent, ...]] = field(
        default_factory=list[tuple[UserContent, ...]], init=False, repr=False
    )
    _task_errors: list[BaseException] = field(default_factory=list[BaseException], init=False, repr=False)

    def get_instructions(self) -> AgentInstructions[AgentDepsT] | None:
        return None if self._realtime else _INSTRUCTIONS

    async def for_run(self, ctx: RunContext[AgentDepsT]) -> BackgroundTools[AgentDepsT]:
        run_capability = replace(self)
        run_capability._realtime = ctx.realtime
        return run_capability

    def _can_run_in_background(self, ctx: RunContext[AgentDepsT], tool_def: ToolDefinition) -> bool:
        run_sequential = ctx.tool_manager is not None and ctx.tool_manager.get_parallel_execution_mode() == 'sequential'
        return not (self._realtime or run_sequential or tool_def.sequential)

    async def prepare_tools(self, ctx: RunContext[AgentDepsT], tool_defs: list[ToolDefinition]) -> list[ToolDefinition]:
        self._optional_tool_names = set()
        prepared: list[ToolDefinition] = []
        for tool_def in tool_defs:
            if (
                not self._can_run_in_background(ctx, tool_def)
                or await matches_tool_selector(self.tools, ctx, tool_def)
                or not await matches_tool_selector(self.optional_tools, ctx, tool_def)
            ):
                prepared.append(tool_def)
                continue
            properties: dict[str, object] = {**tool_def.parameters_json_schema.get('properties', {})}
            if _RUN_IN_BACKGROUND in properties:
                raise UserError(
                    f"Tool '{tool_def.name}' already has a '{_RUN_IN_BACKGROUND}' parameter, "
                    'so it cannot be an optional background tool.'
                )
            schema = {
                **tool_def.parameters_json_schema,
                'properties': {
                    **properties,
                    _RUN_IN_BACKGROUND: {
                        'type': 'boolean',
                        'description': 'Set to true to run this call in the background and receive the result as a follow-up message. Omit it to wait for the result.',
                    },
                },
            }
            self._optional_tool_names.add(tool_def.name)
            prepared.append(replace(tool_def, parameters_json_schema=schema))
        return prepared

    async def before_tool_validate(
        self,
        ctx: RunContext[AgentDepsT],
        *,
        call: ToolCallPart,
        tool_def: ToolDefinition,
        args: RawToolArgs,
    ) -> RawToolArgs:
        if tool_def.name not in self._optional_tool_names:
            return args
        parsed: Any = args
        if isinstance(args, str):
            try:
                parsed = json.loads(args)
            except ValueError:
                return args  # Core turns malformed JSON into a retry.
        if not isinstance(parsed, dict):
            return args
        stripped: dict[str, Any] = {**parsed}
        flag = stripped.pop(_RUN_IN_BACKGROUND, False)
        # Validation has not run yet, so the flag's type is checked here; a retried call must not
        # inherit the choice from an earlier attempt with the same call id.
        self._background_calls.discard(call.tool_call_id)
        if not isinstance(flag, bool):
            raise ModelRetry(f'`{_RUN_IN_BACKGROUND}` must be true or false.')
        if flag:
            self._background_calls.add(call.tool_call_id)
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
        if not self._can_run_in_background(ctx, tool_def) or not (
            await matches_tool_selector(self.tools, ctx, tool_def) or call.tool_call_id in self._background_calls
        ):
            return await handler(args)

        task_id = call.tool_call_id
        tool_name = call.tool_name

        async def _run() -> None:
            try:
                result = await handler(args)
            except UnexpectedModelBehavior as e:
                # Core raises this when the tool's retry budget runs out; end the run as a sequential tool would.
                self._task_errors.append(e)
                raise
            except (ApprovalRequired, CallDeferred, ToolRetryError, ToolFailedError) as e:
                message = (f"Background tool '{tool_name}' (task {task_id}) failed: {_format_background_error(e)}",)
            except Exception as e:
                # Unexpected errors are logged in full; the model only learns the type.
                logger.exception('Background tool %s failed', tool_name)
                message = (f"Background tool '{tool_name}' (task {task_id}) failed: {type(e).__name__}",)
            except asyncio.CancelledError:
                raise
            except BaseException as e:
                self._task_errors.append(e)
                raise
            else:
                message = _format_background_result(tool_name, task_id, result)
            self._completed.append(message)

        def task_done(task: asyncio.Task[None]) -> None:
            self._tasks.discard(task)
            # Core counts a tool call when its handler returns, so hold the slot while the task runs.
            ctx.usage.tool_calls -= 1
            # Errors reach the run through `_task_errors`; mark them retrieved so asyncio does not log them.
            if not task.cancelled():
                task.exception()

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
            # Results are held here rather than enqueued directly so that a deferred-tool pause
            # is not turned into another model request by the end-of-run drain.
            return result

        # At the end of the run, wait for the first live task unless something is already
        # waiting to be delivered; the end-of-run drain then redirects the run to a new request.
        while (
            isinstance(result, End)
            and self._tasks
            and not self._completed
            and not self._task_errors
            and not ctx.pending_messages
        ):
            await asyncio.wait(tuple(self._tasks), return_when=asyncio.FIRST_COMPLETED)

        if self._task_errors:
            raise self._task_errors.pop(0)
        for message in self._completed:
            ctx.enqueue(*message)
        self._completed.clear()
        return result

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
        if self._task_errors:
            raise self._task_errors.pop(0)
        return result
