"""Keep a tool-heavy investigation within a bounded context window."""

import os
from collections.abc import Callable

from pydantic_ai import Agent, RunContext
from pydantic_ai.models import Model

from pydantic_ai_harness.compaction import (
    ClearToolResults,
    ContextUsageEvent,
    ReportContextUsage,
    SlidingWindowCompaction,
    TieredCompaction,
)

DEFAULT_MODEL = os.environ.get('PYDANTIC_AI_MODEL', 'anthropic:claude-fable-5')

ContextObserver = Callable[[ContextUsageEvent], None]


def build_agent(
    model: Model | str = DEFAULT_MODEL,
    *,
    observe_context: ContextObserver | None = None,
    target_fraction: float = 0.75,
    fallback_context_window: int = 200_000,
) -> Agent[object, str]:
    """Build an investigator that clears old tool output before trimming history."""
    agent: Agent[object, str] = Agent(
        model,
        name='bounded_investigator',
        instructions=(
            'Inspect records one at a time. Keep the original investigation goal in view, '
            'and finish with a concise list of the records that need attention.'
        ),
        capabilities=[
            TieredCompaction(
                tiers=[
                    ClearToolResults(max_tokens=1, keep_pairs=2),
                    SlidingWindowCompaction(max_tokens=1, keep_messages=10),
                ],
                target_fraction=target_fraction,
                fallback_context_window=fallback_context_window,
            ),
            ReportContextUsage(fallback_context_window=fallback_context_window),
        ],
    )

    @agent.tool
    async def read_record(ctx: RunContext[object], record_id: int) -> str:
        """Read one verbose local diagnostic record."""
        del ctx
        status = 'needs attention' if record_id in {3, 7} else 'healthy'
        return f'Record {record_id}: status={status}; details=' + ('diagnostic context ' * 80)

    if observe_context is not None:

        @agent.on_event(ContextUsageEvent)
        async def observe(ctx: RunContext[object], event: ContextUsageEvent) -> None:
            del ctx
            observe_context(event)

    return agent


def main() -> None:
    """Start an interactive bounded-context investigation."""

    def report(event: ContextUsageEvent) -> None:
        source = 'model profile' if event.resolved else 'configured fallback'
        print(f'context: {event.used_tokens}/{event.window_tokens} tokens ({source})')

    build_agent(observe_context=report).to_cli_sync()


if __name__ == '__main__':
    main()
