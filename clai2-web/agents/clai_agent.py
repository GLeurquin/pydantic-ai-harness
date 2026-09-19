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

import os
import sys
import warnings
from pathlib import Path

os.environ.setdefault('PYDANTIC_AI_NO_BANNER', '1')

import google.auth
from google import genai
from pydantic_ai import Agent
from pydantic_ai.exceptions import FallbackExceptionGroup, ModelAPIError, UsageLimitExceeded
from pydantic_ai.models import Model, infer_model
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.providers.google import GoogleProvider

from pydantic_ai_harness import Coder
from pydantic_ai_harness.compaction import FallbackCompaction, SlidingWindowCompaction, SummarizingCompaction
from pydantic_ai_harness.experimental import HarnessExperimentalWarning
from pydantic_ai_harness.repo_context import RepoContext

warnings.filterwarnings('ignore', category=HarnessExperimentalWarning)

from pydantic_ai_harness.experimental.acp import run_acp_stdio_sync  # noqa: E402

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


def _compaction() -> FallbackCompaction[None]:
    """Summarize, and truncate when the summary fails or the run is still over budget.

    Mirrors `pydantic_clai2.compaction.build_chain`'s default chain: compact
    once history exceeds 85% of the context window, protecting the most
    recent ~50k tokens from being touched either way.
    """
    protected_tokens = 50_000
    sliding: SlidingWindowCompaction[None] = SlidingWindowCompaction(max_messages=1, keep_tokens=protected_tokens)
    summarizer: SummarizingCompaction[None] = SummarizingCompaction(max_messages=1, keep_tokens=protected_tokens)
    return FallbackCompaction(
        fallback_chain=[summarizer, sliding],
        max_fraction=0.85,
        fallback_on=(ModelAPIError, FallbackExceptionGroup, UsageLimitExceeded),
    )


def build_agent() -> Agent[None, str]:
    """Build a coding agent from harness capabilities, with the model chosen by `CLAI_MODEL`."""
    workspace = Path.cwd()
    return Agent(
        build_model(),
        capabilities=[
            Coder(unrestricted_filesystem=True),
            RepoContext(workspace_dir=workspace),
            _compaction(),
        ],
    )


if __name__ == '__main__':
    run_acp_stdio_sync(build_agent())
