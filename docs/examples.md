---
title: Examples
description: Complete, self-contained agents built from harness capabilities, written to be read and copied.
---

# Examples

The [`examples/`](https://github.com/pydantic/pydantic-ai-harness/tree/main/examples)
directory contains complete agents assembled from first-party capabilities. Each example starts
with a user task that needs several controls to work together. The corresponding tests run the
composition with deterministic models and local fixtures.

## Application patterns

| Example | Task | Composition |
|---|---|---|
| [`manage_long_context.py`](https://github.com/pydantic/pydantic-ai-harness/blob/main/examples/manage_long_context.py) | Finish a verbose, tool-heavy investigation without breaking tool-call history | Tiered tool-result clearing and history trimming, followed by context-usage reporting |
| [`protect_coding_agent_secrets.py`](https://github.com/pydantic/pydantic-ai-harness/blob/main/examples/protect_coding_agent_secrets.py) | Inspect a local project without exposing host credentials | File denial, shell environment stripping, tool-result redaction, and final-output redaction |
| [`recover_file_migration.py`](https://github.com/pydantic/pydantic-ai-harness/blob/main/examples/recover_file_migration.py) | Resume a partially applied file migration without writing completed targets twice | Step checkpoints, a tool-effect ledger, state reconciliation, and continuation from a settled snapshot |

### Keep a tool-heavy run within its context window

`manage_long_context.py` applies cheap compaction before destructive trimming. The record tool
carries important findings forward in typed run state and includes the accumulated list in later
results, so clearing an old verbose result does not discard the finding it contained. Recent
call/return pairs remain intact; if clearing is insufficient, history is trimmed only at a
provider-valid boundary. `ReportContextUsage` then reports the post-compaction request size,
including whether the context-window figure came from the model profile or the configured fallback.

Token estimation uses the configured tokenizer or a character heuristic. It is a budgeting signal,
not provider billing data. Registering the optional context observer consumes the agent's event stream,
so a custom model implementation must support streamed requests.

### Keep host secrets out of a coding agent

`protect_coding_agent_secrets.py` applies controls at four different boundaries:

1. `FileSystem.denied_patterns` keeps known secret paths out of file tools.
2. `Shell.env` starts its only allowed command (`env`) with a minimal environment, while
   `denied_env_patterns` removes common model-provider credential names if the allowlist expands.
3. `ToolGuardrail` redacts credentials returned by allowed file or shell tools.
4. `OutputGuardrail` redacts credentials in the final value returned to the caller.

File policy does not constrain shell commands, so the example does not expose a general-purpose
file-reading command through `Shell`. These controls are not an OS sandbox. Run untrusted commands
under a separate operating-system identity or an isolated execution environment.
Output redaction changes `result.output`; retain and protect the underlying model transcript according
to your data policy. The example uses `run_sync()` so the guard screens the complete output before it
is exposed. Do not stream partial text to callers when final-output screening is a requirement.

### Recover a partially applied migration

`recover_file_migration.py` records a checkpoint before tool execution and annotates each write with
an idempotency key and effect summary. After a failure, application code refuses to resume while an
effect remains unresolved, then continues from the latest settled snapshot. Failed effects are
reconciled by the idempotent migration tool: it re-reads each target and treats schema version 2 as
already complete.

`StepPersistence` records recovery facts; it does not make local files and SQLite checkpoints one
transaction. A hard process kill can leave a `started` effect whose outcome is unknown. Reconcile
such effects before calling `continue_run`.

## Packaged harnesses

These examples expand the capabilities used by the packaged harnesses so you can adjust their
composition:

| Example | What it does |
|---|---|
| [`coding_agent.py`](https://github.com/pydantic/pydantic-ai-harness/blob/main/examples/coding_agent.py) | A coding agent for the current repo, built from the blocks that make up [`Coder`](coder.md) |
| [`research_agent.py`](https://github.com/pydantic/pydantic-ai-harness/blob/main/examples/research_agent.py) | A web-research agent that cites every claim, built from the blocks that make up [`Researcher`](researcher.md) |

If you want the assembled version, every packaged harness ([`Coder`](coder.md),
[`Researcher`](researcher.md), ...) is one import, or zero, via the
[CLI](https://pydantic.dev/docs/ai/cli/#custom-agents):

```bash
uvx --with pydantic-ai-harness clai -a pydantic_ai_harness.coder:coder_agent
```

## Running an example

From the repository root:

```bash
make install
uv run examples/manage_long_context.py
```

Each example states its default model at the top and reads the corresponding API key
from the environment. Set `PYDANTIC_AI_MODEL=provider:model` to run it against a
different model. See the [model configuration docs](/ai/models/overview/) for provider
setup.

Every example exposes a `build_agent()` factory you can import and embed in your own
code, and a `main()` that runs a small demo or interactive session. See
[`examples/README.md`](https://github.com/pydantic/pydantic-ai-harness/blob/main/examples/README.md)
for the source-oriented index.
