#!/usr/bin/env bash
# Build and run CLAI Web against a repository.
#
# Usage:
#   clai2-web/run.sh [--repo <path>] [--port <port>] [--agent-cmd "<cmd>"]
#
# With no --agent-cmd, the bundled deterministic stub agent is used, so you can
# click through the UI with no model or API key. Point --agent-cmd at any
# program that serves an agent over ACP to drive real agents.
#
# Examples:
#   clai2-web/run.sh                       # stub agent, manage the current repo
#   clai2-web/run.sh --repo ~/code/myproj  # stub agent, manage another repo
#   clai2-web/run.sh --agent-cmd "python serve_agent.py"

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

repo="$(pwd)"
port="8787"
agent_cmd=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --agent-cmd) agent_cmd="$2"; shift 2 ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

for tool in cargo pnpm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 1; }
done

echo "==> Building backend"
cargo build --manifest-path "$here/backend/Cargo.toml" --bins

echo "==> Building frontend"
( cd "$here/frontend" && pnpm install --frozen-lockfile && pnpm build )

server="$here/backend/target/debug/clai2-web-server"
args=(--repo "$repo" --static-dir "$here/frontend/dist" --port "$port")
if [[ -n "$agent_cmd" ]]; then
  args+=(--agent-cmd "$agent_cmd")
else
  echo "==> No --agent-cmd given; using the bundled stub agent"
  args+=(--stub)
fi

echo "==> Open http://127.0.0.1:${port}"
exec "$server" "${args[@]}"
