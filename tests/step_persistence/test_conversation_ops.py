"""`update_run_metadata` and `delete_conversation` on the in-memory, file, and SQLite stores."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from contextlib import closing
from pathlib import Path

import pytest

from pydantic_ai_harness.step_persistence import FileStepStore, InMemoryStepStore, SqliteStepStore, StepStore
from tests.step_persistence._conversation_ops import (  # pyright: ignore[reportMissingTypeStubs]
    exercise_conversation_ops,
    populate,
)

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


def _memory(_: Path) -> StepStore:
    return InMemoryStepStore()


def _file(tmp_path: Path) -> StepStore:
    return FileStepStore(tmp_path / 'runs', media_store=None)


def _sqlite(tmp_path: Path) -> StepStore:
    return SqliteStepStore(database=tmp_path / 'steps.db', media_store=None)


@pytest.mark.parametrize('build', [_memory, _file, _sqlite], ids=['memory', 'file', 'sqlite'])
async def test_conversation_ops(build: Callable[[Path], StepStore], tmp_path: Path) -> None:
    await exercise_conversation_ops(build(tmp_path))


async def test_file_store_delete_removes_run_directories(tmp_path: Path) -> None:
    store = FileStepStore(tmp_path / 'runs', media_store=None)
    await populate(store)
    await store.delete_conversation(conversation_id='a')
    assert sorted(child.name for child in (tmp_path / 'runs').iterdir()) == ['r3']


async def test_sqlite_store_delete_leaves_no_child_rows(tmp_path: Path) -> None:
    database = tmp_path / 'steps.db'
    store = SqliteStepStore(database=database, media_store=None)
    await populate(store)
    await store.delete_conversation(conversation_id='a')
    with closing(sqlite3.connect(database)) as connection:
        for table in ('runs', 'events', 'snapshots', 'snapshot_idempotency_keys', 'tool_effects'):
            rows = connection.execute(f'SELECT DISTINCT run_id FROM {table}').fetchall()
            assert rows == [('r3',)], table
