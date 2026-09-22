# Examples

Complete agents assembled from first-party Harness capabilities. The task-led examples have
deterministic tests that exercise the capability composition, not only agent construction.

If you want an assembled harness, use [`Coder`](../docs/coder.md) or
[`Researcher`](../docs/researcher.md), or run one with zero setup:
`uvx --with pydantic-ai-harness clai -a pydantic_ai_harness.coder:coder_agent`.

## Setup

From the repository root:

```bash
make install
uv run examples/manage_long_context.py
```

Each example states its default model at the top and reads that provider's API key from the
environment. Set `PYDANTIC_AI_MODEL=provider:model` to choose another model.

## Task-led examples

| Example | What it demonstrates | Default model |
|---|---|---|
| [`manage_long_context.py`](manage_long_context.py) | Tiered compaction that preserves valid tool-call history and reports post-compaction context use | `anthropic:claude-fable-5` |
| [`protect_coding_agent_secrets.py`](protect_coding_agent_secrets.py) | File, subprocess, tool-result, and final-output controls around a local coding agent | `anthropic:claude-fable-5` |
| [`recover_file_migration.py`](recover_file_migration.py) | Reconciliation and continuation after a file migration tool fails after applying a write | `anthropic:claude-fable-5` |

## Packaged harness compositions

| Example | What it does | Default model |
|---|---|---|
| [`coding_agent.py`](coding_agent.py) | A coding agent for the current repo, built from the blocks that make up `Coder` | `anthropic:claude-fable-5` |
| [`research_agent.py`](research_agent.py) | A web-research agent that cites every claim, built from the blocks that make up `Researcher` | `openai:gpt-5.6-sol` |

Every example exposes a `build_agent()` factory for embedding and a `main()` entry point.
