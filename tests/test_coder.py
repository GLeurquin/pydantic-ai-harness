import subprocess
import sys
from pathlib import Path

import pytest
from pydantic_ai import Agent
from pydantic_ai.capabilities import Capability
from pydantic_ai.models.test import TestModel
from pydantic_ai.workspaces import LocalWorkspace, ReadOnlyWorkspace, Workspace

import pydantic_ai_harness.coder
from pydantic_ai_harness.coder import FILE_TOOL_NAMES, Coder, coder_agent
from pydantic_ai_harness.filesystem import FileSystem
from pydantic_ai_harness.repo_context import RepoContext
from pydantic_ai_harness.shell import LLM_API_KEY_ENV_PATTERNS, Shell

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


def test_coder_agent_is_model_less_and_composed() -> None:
    assert isinstance(coder_agent, Agent)
    assert coder_agent.model is None
    assert coder_agent.name == 'coder'


async def test_bundled_coder_agent_supplies_current_workspace(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)

    result = await coder_agent.run('go', model=TestModel(call_tools=[], custom_output_text='done'))

    assert result.output == 'done'
    assert await result.workspace.working_dir() == tmp_path.as_posix()


async def test_bundled_coder_agent_preserves_explicit_workspace_identity(tmp_path: Path) -> None:
    backend = LocalWorkspace(root=tmp_path)
    workspace = ReadOnlyWorkspace(Workspace(backend))
    result = await coder_agent.run('go', model=TestModel(call_tools=[], custom_output_text='done'), workspace=workspace)

    assert result.workspace is workspace


def test_coder_agent_export_is_lazy() -> None:
    result = subprocess.run(
        [
            sys.executable,
            '-c',
            'import sys; import pydantic_ai_harness.coder; '
            "assert 'pydantic_ai_harness.coder._agent' not in sys.modules",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_coder_unknown_export() -> None:
    with pytest.raises(AttributeError, match='has no attribute'):
        pydantic_ai_harness.coder.__getattr__('missing')


def test_coder_members_and_parameters(tmp_path: Path) -> None:
    coder = Coder(tmp_path, instructions='Custom instructions')
    assert [type(capability).__name__ for capability in coder.capabilities] == [
        'Capability',
        'FileSystem',
        'Shell',
        'RepoContext',
        'ClearToolResults',
        'WarnNearLimits',
        '_BoundToolOutputs',
        'RepairToolArguments',
    ]
    files = next(item for item in coder.capabilities if isinstance(item, FileSystem))
    assert (files.root_dir, files.cwd, files.content_hashes, files.tools) == (tmp_path, None, False, FILE_TOOL_NAMES)
    shell = next(item for item in coder.capabilities if isinstance(item, Shell))
    assert (shell.cwd, shell.tools, shell.denied_commands, shell.allow_interactive) == (tmp_path, ['shell'], [], True)
    assert shell.denied_env_patterns == LLM_API_KEY_ENV_PATTERNS
    context = next(item for item in coder.capabilities if isinstance(item, RepoContext))
    assert context.workspace_dir == tmp_path
    guidance = next(item for item in coder.capabilities if isinstance(item, Capability))
    instructions = str(guidance.get_instructions())
    for text in ('Custom instructions', 'DRY', 'YAGNI', 'SOLID', 'Zen of Python'):
        assert text in instructions
    limits = next(item for item in coder.capabilities if type(item).__name__ == '_BoundToolOutputs')
    assert limits.id is None
    assert isinstance(coder.for_agent(Agent(TestModel())), Coder)
