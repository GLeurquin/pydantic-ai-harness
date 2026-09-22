"""Redis 8 cluster hash-tag regression tests.

Run `make integration-redis-cluster-up`, then `make integration-redis-cluster`.
Stop the test cluster with `make integration-redis-cluster-down`.
`REDIS_CLUSTER_TEST_URL` overrides the seed URL; without a cluster tests skip
unless `REDIS_REQUIRE_LIVE=1` (CI). A reachable standalone node is not a cluster.

Redis Cluster requires every key of an EVAL to share a slot. Hash tags select
that slot from the substring in braces. Re-check with the positive and negative
controls here: https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncGenerator
from datetime import timedelta
from decimal import Decimal

import pytest
from redis.asyncio import Redis, RedisCluster
from redis.exceptions import ClusterCrossSlotError, RedisError

from pydantic_ai_harness.spend import RedisSpendStore, SpendEntry, Spent

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    """redis-py's asynchronous client requires asyncio."""
    return 'asyncio'


@pytest.fixture(params=[True, False], ids=['decoded', 'bytes'])
async def cluster(request: pytest.FixtureRequest) -> AsyncGenerator[RedisCluster, None]:
    """Require a healthy three-primary cluster in both response decoding modes."""
    url = os.environ.get('REDIS_CLUSTER_TEST_URL', 'redis://127.0.0.1:7000')
    # Check the seed directly so the negative control below reaches Redis itself,
    # rather than redis-py's client-side cross-slot validation.
    async with Redis.from_url(url, socket_connect_timeout=2, socket_timeout=2) as seed:
        try:
            info = await seed.cluster('INFO')
        except (RedisError, OSError):
            message = 'No reachable cluster at REDIS_CLUSTER_TEST_URL; run make integration-redis-cluster-up'
            if os.environ.get('REDIS_REQUIRE_LIVE', '').lower() in {'1', 'true', 'yes'}:
                pytest.fail(message)
            pytest.skip(message)
        assert info['cluster_state'] == 'ok'
        assert int(info['cluster_slots_assigned']) == 16384
        assert int(info['cluster_size']) >= 3

    async with RedisCluster.from_url(
        url, decode_responses=request.param, socket_connect_timeout=2, socket_timeout=2
    ) as client:
        await client.initialize()
        yield client


class TestRedisSpendStoreCluster:
    """Exercise the server's slot restriction, not just key formatting."""

    async def test_day_and_month_land_in_one_script(self, cluster: RedisCluster) -> None:
        """One response updates both windows through the real multi-key Lua script."""
        prefix = f'harness-cluster-test:{uuid.uuid4().hex}'
        # Passing the concrete client checks RedisClient protocol compatibility in Pyright.
        store = RedisSpendStore(cluster, prefix=prefix)
        entries = [
            SpendEntry(key='day', usd=Decimal('0.5'), tokens=5, requests=1, ttl=timedelta(days=2)),
            SpendEntry(key='month', usd=Decimal('0.5'), tokens=5, requests=1, ttl=timedelta(days=62)),
        ]
        expected = {entry.key: Spent(usd=Decimal('0.5'), tokens=5, requests=1) for entry in entries}
        try:
            assert await store.add_many(entries) == expected
            assert await store.get_many(['day', 'month']) == expected
        finally:
            # Delete separately so cleanup still works if a regression removes the tag.
            for key in ('day', 'month'):
                await cluster.delete(f'{{{prefix}}}:{key}')
                await cluster.delete(f'{prefix}:{key}')

    async def test_untagged_windows_are_rejected_by_the_server(self, cluster: RedisCluster) -> None:
        """Removing the braces makes Redis itself reject the same window keys."""
        prefix = f'harness-cluster-test:{uuid.uuid4().hex}'
        day, month = f'{prefix}:day', f'{prefix}:month'
        node = cluster.get_node_from_key(day)
        assert node is not None
        async with Redis(host=node.host, port=int(node.port), socket_connect_timeout=2, socket_timeout=2) as direct:
            assert await direct.cluster('KEYSLOT', day) != await direct.cluster('KEYSLOT', month)
            assert await direct.cluster('KEYSLOT', f'{{{prefix}}}:day') == await direct.cluster(
                'KEYSLOT', f'{{{prefix}}}:month'
            )
            with pytest.raises(ClusterCrossSlotError, match="Keys in request don't hash to the same slot"):
                await direct.eval('return {KEYS[1], KEYS[2]}', 2, day, month)
