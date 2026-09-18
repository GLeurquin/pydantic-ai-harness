#!/usr/bin/env python3
"""Serve a real coding agent over ACP, backed by Gemini on Vertex AI.

Entirely composed from `pydantic_ai_harness` and `pydantic_ai` building
blocks -- no bespoke tool or agent-loop code:

- `pydantic_ai_harness.Coder` is the harness's batteries-included coding
  capability (file edit/read/write, shell, repo-context instructions), the
  same one `pydantic-clai2` runs by default.
- `pydantic_ai_harness.experimental.acp.run_acp_stdio_sync` serves the agent
  over ACP -- streaming text, tool calls with diffs, and permission requests
  -- so `clai2-web-server` can drive it as one more managed agent.

`clai2-web-server` spawns this script with its process `cwd` set to the
agent's worktree, so `Coder()`'s default `workspace='.'` is already rooted
there for the life of the process, including any side-conversation sessions
opened on it later.

Credentials: standard Google Application Default Credentials. Point
`GOOGLE_APPLICATION_CREDENTIALS` at a service-account key before launching
`clai2-web-server`, e.g.:

    export GOOGLE_APPLICATION_CREDENTIALS=~/Documents/tokens/vertex-service-token.json
    clai2-web/run.sh --repo /path/to/project --agent-cmd \
      "/path/to/pydantic-ai-harness/.venv/bin/python3 /path/to/pydantic-ai-harness/clai2-web/agents/vertex_coder.py"

Model and region are configurable via `CLAI_VERTEX_MODEL` (default
`gemini-2.5-pro`) and `CLAI_VERTEX_LOCATION` (default `us-central1`).
"""

from __future__ import annotations

import os
import sys
import warnings

# Always spawned as a subprocess, never an interactive terminal; pydantic-ai's
# own isatty check already skips the startup banner here, but this is cheap
# insurance and keeps the server's inherited stderr log quiet.
os.environ.setdefault('PYDANTIC_AI_NO_BANNER', '1')

import google.auth
from google import genai
from pydantic_ai import Agent
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.providers.google import GoogleProvider

from pydantic_ai_harness import Coder
from pydantic_ai_harness.experimental import HarnessExperimentalWarning

warnings.filterwarnings('ignore', category=HarnessExperimentalWarning)

from pydantic_ai_harness.experimental.acp import run_acp_stdio_sync  # noqa: E402


def build_agent() -> Agent[None, str]:
    """Build a coding agent on Gemini via Vertex AI, using Application Default Credentials."""
    credentials, project = google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])
    if project is None:
        print(
            'error: could not determine a GCP project from Application Default Credentials.\n'
            'Set GOOGLE_APPLICATION_CREDENTIALS to a service-account key that embeds a project_id.',
            file=sys.stderr,
        )
        raise SystemExit(1)

    location = os.environ.get('CLAI_VERTEX_LOCATION', 'us-central1')
    model_name = os.environ.get('CLAI_VERTEX_MODEL', 'gemini-2.5-pro')

    client = genai.Client(vertexai=True, credentials=credentials, project=project, location=location)
    provider = GoogleProvider(client=client)
    model = GoogleModel(model_name, provider=provider)

    return Agent(model, capabilities=[Coder(unrestricted_filesystem=True)])


if __name__ == '__main__':
    run_acp_stdio_sync(build_agent())
