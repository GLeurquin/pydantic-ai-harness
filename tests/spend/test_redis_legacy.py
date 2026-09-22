"""Persistent pre-hash-tag counters remain part of budget enforcement."""

from decimal import Decimal

import pytest
from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel

from pydantic_ai_harness.spend import Budget, RedisSpendStore, SpendEntry, SpendLimitExceeded, SpendLimits, Spent

from .test_spend import FakeRedis

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


class TestRedisLegacyCounters:
    @pytest.mark.parametrize(
        'budget',
        [
            Budget(window='total', usd=Decimal('5')),
            Budget(window='day', retain='forever', usd=Decimal('5')),
        ],
        ids=['total', 'day-retained-forever'],
    )
    @pytest.mark.parametrize('bytes_keys', [False, True])
    async def test_persistent_legacy_spend_survives_worker_replacement_and_enforces_budget(
        self, budget: Budget, bytes_keys: bool
    ) -> None:
        client = FakeRedis(bytes_keys=bytes_keys)
        store = RedisSpendStore(client)
        limits = SpendLimits(budgets=[budget], store=store)
        (status,) = await limits.status()
        key = status.key
        legacy_name = f'{store.prefix}:{key}'
        legacy = {'usd_nanos': 3_000_000_000, 'tokens': 8, 'requests': 2, 'unpriced': 1}
        client.hashes[legacy_name] = legacy.copy()

        expected = Spent(usd=Decimal('3'), tokens=8, requests=2, unpriced_requests=1)
        assert await store.get_many([key]) == {key: expected}
        for amount in (4, 5):
            expected = Spent(usd=Decimal(amount), tokens=8, requests=amount - 1, unpriced_requests=1)
            assert await store.add_many([SpendEntry(key=key, usd=Decimal('1'), requests=1)]) == {key: expected}
            store = RedisSpendStore(client)
            assert await store.get_many([key]) == {key: expected}

        assert client.hashes[legacy_name] == legacy
        assert legacy_name not in client.expiries
        limits = SpendLimits(budgets=[budget], store=store)
        with pytest.raises(SpendLimitExceeded):
            await Agent(TestModel(), capabilities=[limits]).run('This request must not reach the model.')
