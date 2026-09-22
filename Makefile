.DEFAULT_GOAL := all

.PHONY: .uv .prek install format lint typecheck test testcov integration-localstack integration-mongodb integration-redis integration-redis-cluster integration-redis-cluster-up integration-redis-cluster-down all

.uv:
	@uv --version || echo 'Please install uv: https://docs.astral.sh/uv/getting-started/installation/'

.prek:
	@prek --version || echo 'Please install prek: https://github.com/j178/pre-commit-rs'

install: .uv .prek
	uv sync --frozen --all-packages --all-extras --group lint
	prek install --install-hooks

format:
	uv run ruff format
	uv run ruff check --fix --fix-only

lint:
	uv run ruff format --check
	uv run ruff check

typecheck:
	uv run --all-packages --group lint pyright

test:
	uv run pytest

testcov:
	uv run coverage run -m pytest
	uv run coverage report

integration-localstack:
	uv run pytest integration_tests/localstack/test_live_localstack.py

# Needs a reachable mongod (`docker run -d -p 27017:27017 mongo:8`); without one
# the tests skip. Set MONGODB_TEST_URL to point at a server elsewhere.
integration-mongodb:
	uv run pytest integration_tests/mongodb/test_live_mongodb.py

# Needs a reachable Redis (`docker run -d -p 6379:6379 redis:8`); without one the
# tests skip. Set REDIS_TEST_URL to point at a server elsewhere.
integration-redis:
	uv run pytest integration_tests/redis/test_live_redis.py

integration-redis-cluster:
	uv run pytest integration_tests/redis/test_live_cluster.py

# Dedicated disposable cluster. Run down before up to create a fresh topology.
integration-redis-cluster-up:
	docker compose -f integration_tests/redis/compose.yaml up -d --wait --wait-timeout 60
	docker compose -f integration_tests/redis/compose.yaml exec -T redis-0 redis-cli --cluster create \
		127.0.0.1:7000 127.0.0.1:7001 127.0.0.1:7002 --cluster-replicas 0 --cluster-yes
	docker compose -f integration_tests/redis/compose.yaml exec -T redis-0 sh -c \
		'for attempt in $$(seq 1 30); do redis-cli -p 7000 cluster info | grep -q cluster_state:ok && exit 0; sleep 1; done; exit 1'

integration-redis-cluster-down:
	docker compose -f integration_tests/redis/compose.yaml down --volumes

all: format lint typecheck testcov
