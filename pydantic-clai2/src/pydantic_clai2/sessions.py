"""Listing, resuming, renaming, and deleting conversations kept by `StepPersistence`.

A conversation is a group of runs sharing a `conversation_id`. Its first run
carries the metadata the capability stamped when it started (the workspace,
and a title once the user gives one); its newest run with a snapshot is where
it left off. Nothing here writes turns: `StepPersistence` does that inside
every `Agent.run`.
"""

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Final, Protocol, TypeVar

from pydantic_ai.capabilities import AgentCapability
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, UserPromptPart
from pydantic_ai_harness.step_persistence import ContinuableSnapshot, RunRecord, StepPersistence, StepStore

from .persistence import CWD_KEY, TITLE_KEY

NEWEST: Final = 'newest'
"""Resume target meaning the most recently active conversation for this workspace."""
LISTING_LIMIT: Final = 20
"""How many conversations the menus show; each one costs a snapshot read."""

Runs = dict[str, list[RunRecord]]
"""Runs by conversation id, chronological within each conversation."""
DepsT = TypeVar('DepsT')


class Conversation(Protocol):
    """What `Sessions` needs from the shell's `Session`."""

    conversation_id: str

    def clear(self) -> None:
        """Start an empty conversation under a new id."""
        ...

    def restore(self, messages: Sequence[ModelMessage], *, conversation_id: str) -> None:
        """Replace the history and continue under `conversation_id`."""
        ...


@dataclass(frozen=True, kw_only=True)
class SessionSummary:
    """One conversation as the menus and `--resume` see it."""

    id: str
    workspace: str | None
    title: str | None
    started_at: datetime
    updated_at: datetime
    snapshot: ContinuableSnapshot | None
    """Where the conversation left off; `None` when no turn reached a model response."""

    @property
    def messages(self) -> list[ModelMessage]:
        """The history a resume would restore; empty without a snapshot."""
        return self.snapshot.messages if self.snapshot is not None else []

    @property
    def label(self) -> str:
        """The title, or the first prompt on one line, or a placeholder for a conversation with nothing saved."""
        return self.title or ' '.join((first_prompt(self.messages) or '').split()) or '(no saved turns)'


def find_store(capabilities: Iterable[AgentCapability[DepsT]]) -> StepStore | None:
    """The store behind the first `StepPersistence` among the loaded plugins, if any."""
    return next((capability.store for capability in capabilities if isinstance(capability, StepPersistence)), None)


class Sessions:
    """The shell's view of saved conversations for one workspace."""

    def __init__(
        self,
        conversation: Conversation,
        *,
        store: Callable[[], StepStore | None],
        workspace: Path | None = None,
        on_switch: Callable[[], None] = lambda: None,
    ) -> None:
        """`store` is looked up on every call so a plugin enabled or disabled mid-session is honoured."""
        self._conversation = conversation
        self._store = store
        self.workspace = str((workspace or Path.cwd()).resolve())
        self._on_switch = on_switch

    @property
    def id(self) -> str:
        """The active conversation's id."""
        return self._conversation.conversation_id

    def new(self) -> str:
        """Start an empty conversation; its first turn creates the store rows."""
        self._conversation.clear()
        self._on_switch()
        return f'Started session {self.id}.'

    async def listing(self) -> list[SessionSummary]:
        """This workspace's conversations, most recently active first, at most `LISTING_LIMIT`."""
        store = self._require_store()
        groups = await _grouped(store)
        mine = [(cid, runs) for cid, runs in groups.items() if runs[0].metadata.get(CWD_KEY) == self.workspace]
        mine.sort(key=lambda entry: entry[1][-1].started_at, reverse=True)
        return [await _summarise(store, cid, runs) for cid, runs in mine[:LISTING_LIMIT]]

    async def resume(self, target: str) -> str:
        """Load `NEWEST` or a conversation id (a unique prefix will do). Raises `ValueError` when it cannot.

        Any conversation can be resumed by id, whichever directory it started in.
        """
        summary = await self._newest() if target == NEWEST else await self._find(target)
        if summary.snapshot is None:
            raise ValueError(f'Session {summary.id} has no saved turns to resume.')
        self._conversation.restore(summary.snapshot.messages, conversation_id=summary.id)
        self._on_switch()
        return f'Resumed session {summary.id} ({len(summary.messages)} messages): {summary.label}'

    async def rename(self, session_id: str, title: str | None) -> str:
        """Set or clear a title on the conversation's first run, where its metadata lives."""
        store = self._require_store()
        runs = await store.list_runs(conversation_id=session_id)
        if not runs:
            raise ValueError(f'No session {session_id}.')
        first = runs[0]
        metadata = {key: value for key, value in first.metadata.items() if key != TITLE_KEY}
        if title is not None:
            metadata[TITLE_KEY] = title
        await store.update_run_metadata(run_id=first.run_id, metadata=metadata)
        return f'Renamed session {session_id}.' if title else f'Cleared the title of session {session_id}.'

    async def delete(self, session_id: str) -> str:
        """Forget a conversation; deleting the active one starts a new one."""
        await self._require_store().delete_conversation(conversation_id=session_id)
        if session_id == self.id:
            return f'Deleted session {session_id}. {self.new()}'
        return f'Deleted session {session_id}.'

    def _require_store(self) -> StepStore:
        store = self._store()
        if store is None:
            raise ValueError('Sessions are not being saved: the persistence plugin is not loaded.')
        return store

    async def _newest(self) -> SessionSummary:
        for summary in await self.listing():
            if summary.snapshot is not None:
                return summary
        raise ValueError('No saved sessions for this workspace.')

    async def _find(self, target: str) -> SessionSummary:
        store = self._require_store()
        groups = await _grouped(store)
        if target in groups:
            return await _summarise(store, target, groups[target])
        matches = [cid for cid in groups if cid.startswith(target)]
        if len(matches) == 1:
            return await _summarise(store, matches[0], groups[matches[0]])
        if matches:
            raise ValueError(f'{target} matches {len(matches)} sessions; give more of the id.')
        raise ValueError(f'No session {target}.')


async def _grouped(store: StepStore) -> Runs:
    groups: Runs = {}
    for record in await store.list_runs():
        if record.conversation_id is not None:
            groups.setdefault(record.conversation_id, []).append(record)
    return groups


async def _summarise(store: StepStore, conversation_id: str, runs: list[RunRecord]) -> SessionSummary:
    """The newest run with a snapshot is where the conversation stands; older runs are only history."""
    snapshot = None
    for run in reversed(runs):
        snapshot = await store.latest_snapshot(run_id=run.run_id, include_interrupted=True)
        if snapshot is not None:
            break
    first = runs[0]
    return SessionSummary(
        id=conversation_id,
        workspace=first.metadata.get(CWD_KEY),
        title=first.metadata.get(TITLE_KEY),
        started_at=first.started_at,
        updated_at=runs[-1].started_at,
        snapshot=snapshot,
    )


def first_prompt(messages: Sequence[ModelMessage]) -> str | None:
    """The first user prompt in a history, if any."""
    for message in messages:
        if isinstance(message, ModelRequest):
            for part in message.parts:
                if isinstance(part, UserPromptPart) and isinstance(part.content, str):
                    return part.content
    return None


def last_reply(messages: Sequence[ModelMessage]) -> str | None:
    """The last assistant text in a history, if any."""
    for message in reversed(messages):
        if isinstance(message, ModelResponse):
            texts = [part.content for part in message.parts if isinstance(part, TextPart) and part.content]
            if texts:
                return ''.join(texts)
    return None
