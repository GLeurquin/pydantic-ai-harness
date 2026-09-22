"""Keep a tool-heavy investigation within a bounded context window."""

import os
from collections.abc import Callable
from dataclasses import dataclass, field

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


@dataclass
class InvestigationState:
    """Findings that must survive destructive history compaction."""

    findings: list[int] = field(default_factory=list[int])


def build_agent(
    model: Model | str = DEFAULT_MODEL,
    *,
    observe_context: ContextObserver | None = None,
    target_fraction: float = 0.75,
    fallback_context_window: int = 200_000,
) -> Agent[InvestigationState, str]:
    """Build an investigator that clears old tool output before trimming history."""
    agent: Agent[InvestigationState, str] = Agent(
        model,
        name='bounded_investigator',
        deps_type=InvestigationState,
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
    async def read_record(ctx: RunContext[InvestigationState], record_id: int) -> str:
        """Read one record and carry important findings into later results."""
        needs_attention = record_id in {3, 7}
        if needs_attention and record_id not in ctx.deps.findings:
            ctx.deps.findings.append(record_id)
        status = 'needs attention' if needs_attention else 'healthy'
        retained = ', '.join(str(item) for item in ctx.deps.findings) or 'none'
        return f'Record {record_id}: status={status}; retained findings={retained}; details=' + (
            'diagnostic context ' * 80
        )

    if observe_context is not None:

        @agent.on_event(ContextUsageEvent)
        async def observe(ctx: RunContext[InvestigationState], event: ContextUsageEvent) -> None:
            del ctx
            observe_context(event)

    return agent


def main() -> None:
    """Start an interactive bounded-context investigation."""

    def report(event: ContextUsageEvent) -> None:
        source = 'model profile' if event.resolved else 'configured fallback'
        print(f'context: {event.used_tokens}/{event.window_tokens} tokens ({source})')

    build_agent(observe_context=report).to_cli_sync(deps=InvestigationState())


if __name__ == '__main__':
    main()
