"""Recover a file migration after a tool fails partway through its side effect."""

import asyncio
import json
import os
import stat
import tempfile
from pathlib import Path
from uuid import uuid4

from pydantic_ai import Agent, AgentRunResult, RunContext
from pydantic_ai.models import Model

from pydantic_ai_harness.step_persistence import (
    SqliteStepStore,
    StepPersistence,
    StepStore,
    annotate_tool_effect,
    continue_run,
)
from pydantic_ai_harness.step_persistence.recovery import inspect_recovery

DEFAULT_MODEL = os.environ.get('PYDANTIC_AI_MODEL', 'anthropic:claude-fable-5')


def build_agent(
    model: Model | str = DEFAULT_MODEL,
    *,
    workspace: Path | None = None,
    store: StepStore | None = None,
) -> Agent[object, str]:
    """Build an agent that migrates JSON-compatible YAML files idempotently."""
    root = (workspace or Path.cwd()).resolve()
    step_store = store or SqliteStepStore(database=root / '.migration-steps.db')
    agent: Agent[object, str] = Agent(
        model,
        name='config_migrator',
        instructions=(
            'Migrate every requested configuration file to schema version 2. '
            'Call migrate_file once per path and report files already at version 2 as reconciled.'
        ),
        capabilities=[StepPersistence(store=step_store, capture_frontier=True)],
    )

    @agent.tool
    async def migrate_file(ctx: RunContext[object], path: str) -> str:
        """Atomically migrate one JSON-compatible YAML file to schema version 2."""
        target = (root / path).resolve()
        if not target.is_relative_to(root):
            return f'Refused path outside workspace: {path}'

        data = json.loads(target.read_text())
        if data.get('schema_version') == 2:
            return f'{path} is already at schema version 2; no write performed.'

        await annotate_tool_effect(
            step_store,
            ctx,
            idempotency_key=f'config-v2:{target.relative_to(root)}',
            effect_summary=f'Atomically replace {path} with schema version 2.',
        )
        data['schema_version'] = 2
        descriptor, temporary_name = tempfile.mkstemp(prefix=f'.{target.name}.', dir=target.parent)
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, 'w') as file:
                file.write(json.dumps(data, indent=2) + '\n')
            temporary.chmod(stat.S_IMODE(target.stat().st_mode))
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
        return f'Migrated {path} to schema version 2.'

    return agent


async def resume_migration(
    agent: Agent[object, str],
    store: StepStore,
    *,
    failed_run_id: str,
) -> AgentRunResult[str]:
    """Inspect a failed run and resume from its latest settled checkpoint."""
    recovery = await inspect_recovery(store=store, run_id=failed_run_id)
    if recovery.unresolved:
        details = ', '.join(f'{effect.tool_name}:{effect.effect_summary}' for effect in recovery.unresolved)
        raise RuntimeError(f'Reconcile unresolved side effects before resuming: {details}')

    history = await continue_run(store, run_id=failed_run_id)
    failed = ', '.join(recovery.failed_tools) or 'none recorded'
    return await agent.run(
        f'Resume the migration. Re-read each target before retrying; failed tools: {failed}.',
        message_history=history,
        run_id=f'{failed_run_id}-recovery',
    )


async def main() -> None:
    """Run a new migration whose checkpoints can be inspected after failure."""
    workspace = Path.cwd()
    store = SqliteStepStore(database=workspace / '.migration-steps.db')
    agent = build_agent(workspace=workspace, store=store)
    run_id = f'config-migration-{uuid4().hex[:12]}'
    print(f'Migration run id: {run_id}')
    try:
        result = await agent.run(
            'Migrate configs/api.yaml and configs/worker.yaml.',
            run_id=run_id,
        )
    except Exception:
        recovery = await inspect_recovery(store=store, run_id=run_id)
        if recovery.settled is None:
            raise
        result = await resume_migration(agent, store, failed_run_id=run_id)
    print(result.output)


if __name__ == '__main__':
    asyncio.run(main())
