"""`ReportModelRequest` -- report the exact messages about to be sent to the model, for a host application."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from pydantic_ai._run_context import AgentDepsT
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.tools import RunContext

from pydantic_ai_harness.compaction._report_model_request_events import ModelRequestReportedEvent

if TYPE_CHECKING:
    from pydantic_ai.models import ModelRequestContext


@dataclass
class ReportModelRequest(AbstractCapability[AgentDepsT]):
    """Report the exact messages about to be sent to the model, for a host application.

    A compaction strategy rewrites history in place and the `compact_messages` span it emits
    records only counts and token estimates, so an application that wants the real content -- a
    debug view of what the agent actually sees, an audit log, a support tool reconstructing a
    session -- has nowhere to read it from. This capability closes that gap: it only observes,
    never edits the history, and emits a `ModelRequestReportedEvent` your application subscribes
    to with `@agent.on_event`.

    Order matters: register it *after* a compaction capability to see the compacted history, or
    before it to see what triggered the compaction -- the same rule as `ReportContextUsage`.

    The event carries full message content, unlike everything else this package emits to
    OpenTelemetry (which core's `trace_include_content` gates, since a trace has a wider audience
    than the application that produced it). Route it deliberately -- a debug artifact, an
    authenticated operator endpoint, a store your own access control protects -- not a wide
    telemetry sink or a client-visible channel.

    Adds no OpenTelemetry spans of its own: core's own model-request span already records that a
    request happened, and the content this capability reports travels on the event, not a trace
    attribute.

    Example:
        ```python
        from pydantic_ai import Agent
        from pydantic_ai_harness import ReportModelRequest, SummarizingCompaction
        from pydantic_ai_harness.compaction import ModelRequestReportedEvent

        agent = Agent(
            'anthropic:claude-sonnet-5',
            capabilities=[
                SummarizingCompaction(max_fraction=0.9, keep_messages=20),
                ReportModelRequest(),
            ],
        )

        @agent.on_event(ModelRequestReportedEvent)
        async def log_request(ctx, event):
            print(f'sending {len(event.messages)} messages to {event.model_id}')
        ```
    """

    async def before_model_request(
        self,
        ctx: RunContext[AgentDepsT],
        request_context: ModelRequestContext,
    ) -> ModelRequestContext:
        """Emit the pending request's messages and model id, unchanged."""
        await ctx.emit(
            ModelRequestReportedEvent(
                messages=list(request_context.messages),
                model_id=request_context.model_id,
            )
        )
        return request_context
