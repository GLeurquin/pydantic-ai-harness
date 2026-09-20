#!/usr/bin/env python3
"""Serve a coding agent over ACP, with the model chosen by clai2-web's model profiles.

Composed entirely from `pydantic_ai_harness` building blocks: `Coder` for file
edit/read/write and shell, `RepoContext` so the agent loads the workspace's own
instruction files, and a summarize-then-truncate compaction chain so a long
session degrades gracefully instead of blowing the model's context window.
Served over ACP via `run_acp_stdio_sync`, so clai2-web's backend can drive it
like any other ACP agent.

The model comes from the `CLAI_MODEL` environment variable, set by the
backend's model-profile system (`clai2-web/backend/server/src/models.rs`,
`ModelProfile::base_env`) to a `provider:model` string. Every provider prefix
resolves through `pydantic_ai.models.infer_model` except `google-vertex`:
selecting Vertex vs. the direct Gemini API is about *how*
`pydantic_ai.providers.google.GoogleProvider` is constructed (an explicit
`google.genai.Client(vertexai=True, ...)` vs. reading `GOOGLE_API_KEY`), not a
distinct provider name -- `GoogleProvider.name` is `'google'` either way -- so
`google-vertex` isn't a real `infer_model` prefix and is special-cased here.
"""

from __future__ import annotations

import json
import os
import sys
import warnings
from dataclasses import dataclass
from pathlib import Path

os.environ.setdefault('PYDANTIC_AI_NO_BANNER', '1')

import google.auth
from google import genai
from pydantic_ai import Agent
from pydantic_ai.exceptions import FallbackExceptionGroup, ModelAPIError, UsageLimitExceeded
from pydantic_ai.messages import ModelMessagesTypeAdapter
from pydantic_ai.models import Model, infer_model
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.tools import RunContext

from pydantic_ai_harness import Coder
from pydantic_ai_harness.compaction import (
    ContextUsageEvent,
    FallbackCompaction,
    ModelRequestReportedEvent,
    ReportContextUsage,
    ReportModelRequest,
    SlidingWindowCompaction,
    SummarizingCompaction,
)
from pydantic_ai_harness.experimental import HarnessExperimentalWarning
from pydantic_ai_harness.repo_context import RepoContext

warnings.filterwarnings('ignore', category=HarnessExperimentalWarning)

from pydantic_ai_harness.experimental.acp import AcpSession, AcpSessionConfig, run_acp_stdio_sync  # noqa: E402

_DEFAULT_MODEL = 'google-vertex:gemini-2.5-pro'
"""Used when no model profile is selected (`CLAI_MODEL` unset)."""


def _vertex_model(model_name: str) -> Model:
    """Build a Gemini model on Vertex AI, using Application Default Credentials.

    `GOOGLE_APPLICATION_CREDENTIALS`, written by the backend when a profile
    carries service-account JSON, is picked up by `google.auth.default()`
    automatically -- no extra wiring needed here for that case.
    """
    credentials, adc_project = google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])
    project = os.environ.get('GOOGLE_CLOUD_PROJECT') or adc_project
    if project is None:
        print(
            'error: could not determine a GCP project.\n'
            'Set GOOGLE_CLOUD_PROJECT on the model profile, or use credentials whose\n'
            'service-account key embeds a project_id.',
            file=sys.stderr,
        )
        raise SystemExit(1)
    location = os.environ.get('GOOGLE_CLOUD_LOCATION', 'us-central1')
    client = genai.Client(vertexai=True, credentials=credentials, project=project, location=location)
    return GoogleModel(model_name, provider=GoogleProvider(client=client))


def build_model() -> Model:
    """Resolve the model named by `CLAI_MODEL` (`provider:model`)."""
    clai_model = os.environ.get('CLAI_MODEL', _DEFAULT_MODEL)
    provider, _, model_name = clai_model.partition(':')
    if provider == 'google-vertex':
        return _vertex_model(model_name)
    return infer_model(clai_model)


def _compaction() -> FallbackCompaction[ClaiDeps]:
    """Summarize, and truncate when the summary fails or the run is still over budget.

    Mirrors `pydantic_clai2.compaction.build_chain`'s default chain: compact
    once history exceeds 85% of the context window, protecting the most
    recent ~50k tokens from being touched either way.
    """
    protected_tokens = 50_000
    sliding: SlidingWindowCompaction[ClaiDeps] = SlidingWindowCompaction(max_messages=1, keep_tokens=protected_tokens)
    summarizer: SummarizingCompaction[ClaiDeps] = SummarizingCompaction(max_messages=1, keep_tokens=protected_tokens)
    return FallbackCompaction(
        fallback_chain=[summarizer, sliding],
        max_fraction=0.85,
        fallback_on=(ModelAPIError, FallbackExceptionGroup, UsageLimitExceeded),
    )


@dataclass(frozen=True, kw_only=True)
class ClaiDeps:
    """Identifies the running agent process and ACP session to the debug-context listener."""

    agent_id: str
    session_id: str


def session_config(session: AcpSession) -> AcpSessionConfig[ClaiDeps]:
    """Give each ACP session the identity the debug-context listener needs to name its snapshot file."""
    return AcpSessionConfig(deps=ClaiDeps(agent_id=os.environ['CLAI_AGENT_ID'], session_id=session.session_id))


def mark_goal_complete(summary: str) -> str:
    """Call this when, and only when, you were given an autonomous goal to work toward across multiple turns and it is now fully met.

    clai2-web's backend watches for this call to stop auto-continuing the
    conversation; it has no effect otherwise, so ignore it in an ordinary
    chat where no goal was given.

    Args:
        summary: A short summary of what was done to meet the goal.
    """
    return f'Goal marked complete: {summary}'


def build_agent() -> Agent[ClaiDeps, str]:
    """Build a coding agent from harness capabilities, with the model chosen by `CLAI_MODEL`."""
    workspace = Path.cwd()
    agent = Agent(
        build_model(),
        deps_type=ClaiDeps,
        capabilities=[
            Coder(unrestricted_filesystem=True),
            RepoContext(workspace_dir=workspace),
            _compaction(),
            # Both listed after `_compaction()`: `before_model_request` hooks apply in list
            # order, so both observe the compacted history, not what triggered the compaction.
            ReportModelRequest(),
            ReportContextUsage(),
        ],
        tools=[mark_goal_complete],
    )

    @agent.on_event(ModelRequestReportedEvent)
    async def write_debug_context(ctx: RunContext[ClaiDeps], event: ModelRequestReportedEvent) -> None:
        """Snapshot the post-compaction request for clai2-web's debug view.

        Written to `<CLAI_DEBUG_CONTEXT_DIR>/<agent_id>/<session_id>.json` on every model request,
        so the backend can read it on demand (`GET .../debug-context`) rather than the agent
        pushing updates -- a stale read just means no model request has happened yet since the
        last one. The file is whatever shape `ModelMessagesTypeAdapter` serializes to; the backend
        passes it through as opaque JSON.
        """
        directory = Path(os.environ['CLAI_DEBUG_CONTEXT_DIR']) / ctx.deps.agent_id
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f'{ctx.deps.session_id}.json').write_bytes(ModelMessagesTypeAdapter.dump_json(event.messages))

    @agent.on_event(ContextUsageEvent)
    async def write_context_usage(ctx: RunContext[ClaiDeps], event: ContextUsageEvent) -> None:
        """Snapshot how full the context is, for clai2-web's live context gauge.

        Shares `write_debug_context`'s directory and on-demand-read design, with a distinct
        filename suffix rather than a second env var. Written in camelCase (unlike the debug
        context file, which passes through `ModelMessagesTypeAdapter`'s own snake_case
        untouched) since the backend parses these four fields itself rather than treating them
        as opaque content.
        """
        directory = Path(os.environ['CLAI_DEBUG_CONTEXT_DIR']) / ctx.deps.agent_id
        directory.mkdir(parents=True, exist_ok=True)
        payload = {
            'usedTokens': event.used_tokens,
            'windowTokens': event.window_tokens,
            'resolved': event.resolved,
            'fraction': event.fraction,
        }
        (directory / f'{ctx.deps.session_id}.context-usage.json').write_text(json.dumps(payload))

    return agent


if __name__ == '__main__':
    # `deps` here is only the fallback for a session that skips `session_config`, which never
    # happens with `PydanticAIACPAgent` -- it's always used, so this value never runs.
    run_acp_stdio_sync(
        build_agent(),
        deps=ClaiDeps(agent_id='unset', session_id='unset'),
        session_config=session_config,
    )
