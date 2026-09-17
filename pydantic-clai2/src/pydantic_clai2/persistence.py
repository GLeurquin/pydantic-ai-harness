"""The built-in `persistence` plugin: every turn is saved by the harness `StepPersistence` capability.

CLAI adds nothing to how turns are written. `StepPersistence` records a
`ContinuableSnapshot` at every settled boundary of a run and on failure,
grouped by the `conversation_id` the shell's `Session` passes to `Agent.run`.
The shell's `/resume` and `/sessions` read that store back through
`Sessions`; this module only decides where the store lives and tags each run
with the directory it was started from.
"""

from pathlib import Path

from pydantic import BaseModel
from pydantic_ai_harness.step_persistence import SqliteStepStore, StepPersistence

from .plugins import DepsT, PluginHost
from .settings_store import config_dir

CWD_KEY = 'cwd'
"""Run metadata key holding the workspace a conversation belongs to."""
TITLE_KEY = 'title'
"""Run metadata key holding a user-given conversation title, on the conversation's first run."""


class PersistenceSettings(BaseModel):
    """`database` overrides where the SQLite store lives; the default sits in CLAI's config directory."""

    database: Path | None = None


def activate(host: PluginHost[DepsT]) -> None:
    """Register `StepPersistence` over a SQLite store, stamping runs with the current directory."""
    settings = host.settings(PersistenceSettings)
    database = settings.database or config_dir() / 'sessions.db'
    host.add(StepPersistence(store=SqliteStepStore(database=database), metadata={CWD_KEY: str(Path.cwd().resolve())}))
