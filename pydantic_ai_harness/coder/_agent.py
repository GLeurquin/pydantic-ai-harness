"""Runnable agent instance for the `Coder` harness."""

from pathlib import Path

from pydantic_ai import Agent
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.tools import RunContext
from pydantic_ai.workspaces import LocalWorkspaceBackend, WorkspaceRef

from pydantic_ai_harness.coder._capability import Coder


class _CoderWorkspace(AbstractCapability[object]):
    """Provide the checkout workspace for the bundled agent when no ref is supplied."""

    def get_workspace(self, ctx: RunContext[object], *, ref: WorkspaceRef | None) -> LocalWorkspaceBackend | None:
        return None if ref is not None else LocalWorkspaceBackend(working_dir=Path.cwd())


coder_agent = Agent[object](
    name='coder',
    capabilities=[Coder[object](), _CoderWorkspace()],
)
"""Model-less coding agent for CLIs that load `module:variable` targets."""
