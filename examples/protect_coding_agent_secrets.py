"""Layer workspace policy and redaction around a local coding agent."""

import os
from pathlib import Path

from pydantic_ai import Agent
from pydantic_ai.models import Model

from pydantic_ai_harness import LLM_API_KEY_ENV_PATTERNS, FileSystem, Shell
from pydantic_ai_harness.guardrails import OutputGuardrail, ToolGuardrail
from pydantic_ai_harness.guardrails.detectors import for_text, for_tool_result_text, redact_secrets

DEFAULT_MODEL = os.environ.get('PYDANTIC_AI_MODEL', 'anthropic:claude-fable-5')

_SECRET_PATHS = ['.env', '.env.*', '*.pem', '*.key', '**/secrets*']


def build_agent(model: Model | str = DEFAULT_MODEL, *, workspace: Path | None = None) -> Agent[object, str]:
    """Build a local coding agent with layered secret controls."""
    root = (workspace or Path.cwd()).resolve()
    minimal_env = {'PATH': os.environ.get('PATH', '')}
    return Agent(
        model,
        name='secret_safe_coder',
        instructions=(
            'Inspect the project using the available file and shell tools. '
            'Do not expose credentials in tool results or your final answer.'
        ),
        capabilities=[
            FileSystem(
                root_dir=root,
                denied_patterns=_SECRET_PATHS,
                tools=['read_file', 'list_directory'],
            ),
            Shell(
                cwd=root,
                allowed_commands=['env'],
                env=minimal_env,
                denied_env_patterns=LLM_API_KEY_ENV_PATTERNS,
                tools=['run_command'],
            ),
            ToolGuardrail(result_guard=for_tool_result_text(redact_secrets)),
            OutputGuardrail(guard=for_text(redact_secrets)),
        ],
    )


def main() -> None:
    """Run one screened request without exposing partial streamed output."""
    request = input('What should the coding agent inspect? ')
    result = build_agent().run_sync(request)
    print(result.output)


if __name__ == '__main__':
    main()
