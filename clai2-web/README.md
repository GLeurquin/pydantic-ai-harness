# CLAI Web

A browser control surface for running and supervising up to 50 CLAI coding
agents at once. A Rust backend orchestrates agent processes over the Agent
Client Protocol (ACP); a React frontend presents them in one dashboard.

This is a standalone application, not a harness capability. It composes with
the harness by speaking ACP to any agent the harness can serve
(`pydantic_ai_harness.experimental.acp.run_acp_stdio`), including the bundled
CLAI coder launcher.

`PLAN.md` holds the architecture and the rationale behind it.

## What it does

- Start, stop, and supervise up to 50 agents from one tab.
- Give each agent its own git worktree and branch on creation, so parallel
  agents never write into each other's checkouts.
- Per-agent approval modes, changeable live: ask for every tool call, accept
  file edits automatically, or auto-approve everything.
- Fork a running agent into a new worktree, carrying the parent's uncommitted
  changes and conversation history.
- Open side conversations: additional sessions against the same agent process
  and worktree, for questions that should not disturb the main thread.
- Review each agent's work as a diff against its base branch.
- Configure model profiles (provider, model, and credentials) in the browser
  and choose which one each agent runs under, switchable per agent.

## Layout

```text
clai2-web/
  backend/    Rust workspace: the axum server and the ACP client
    server/     clai2-web-server (lib + binary) and the stub-agent binary
  frontend/   Vite + React + TypeScript UI, themed with the Pydantic palette
  e2e/        Playwright suite driving the built UI against the real backend
```

## Running it

Build the pieces and run the server against a repository. The server is an ACP
client: it spawns one agent process per managed agent and talks to it over
stdio. Point `--agent-cmd` at any program that serves an agent over ACP, or use
`--stub` for the bundled deterministic agent (no model, no network).

```bash
# Backend and the stub agent
cargo build --manifest-path backend/Cargo.toml --bins

# Frontend
cd frontend && pnpm install && pnpm build && cd ..

# Serve the UI and manage agents in <repo>, using the stub agent
./backend/target/debug/clai2-web-server \
  --repo /path/to/repo \
  --static-dir frontend/dist \
  --port 8787 \
  --stub
```

Open `http://127.0.0.1:8787`. For a real coding agent, replace `--stub` with,
for example, `--agent-cmd "python serve_agent.py"`, where the script calls
`run_acp_stdio_sync` on your `Agent`.

The server binds to localhost for a single operator. It adds no auth,
sandboxing, or approval layer beyond the approval modes described here; agents
run as local subprocesses with your permissions.

## Model profiles

A model profile names a provider, a model, and the credentials to run it with.
The "Models" button in the header manages them; the New Agent dialog and an
agent's Settings tab pick which profile an agent uses. When an agent starts,
the backend applies the profile's environment to that agent's process alone and
sets `CLAI_MODEL` to the provider-qualified model string (for example
`google-vertex:gemini-2.5-pro`), which the agent launcher passes to its
`Agent(...)`. Anthropic, OpenAI, and Google (Gemini API) profiles set the
provider's API-key variable; a Vertex profile sets `GOOGLE_CLOUD_PROJECT`,
`GOOGLE_CLOUD_LOCATION`, and, when given service-account JSON, writes it to a
per-agent file referenced by `GOOGLE_APPLICATION_CREDENTIALS`. A profile can
also carry arbitrary extra environment variables. Switching an agent's profile
restarts its process and replays the conversation so far to the new model.

Secrets entered in the UI are stored in `models.json` (and Vertex credentials
files) under the server's data directory, written with owner-only permissions
on Unix, and are never returned to the browser once saved: a read reports only
whether a secret is present. Because the file holds provider secrets in
plaintext on the host, run the server on a machine you trust, and prefer
referencing existing credentials over pasting long-lived keys where you can.

### Server options

| Flag | Meaning |
| --- | --- |
| `--repo <path>` | repository agents work in (default: current directory) |
| `--port <port>` | port on 127.0.0.1 (default: 8787) |
| `--data-dir <path>` | roster and transcript store (default: `<repo>/.clai2-web`) |
| `--worktrees-dir <path>` | where agent worktrees are created |
| `--max-agents <n>` | concurrent agent cap (default: 50) |
| `--agent-cmd <cmd>` | agent command line, whitespace-split |
| `--static-dir <path>` | serve the built frontend from here |
| `--stub` | use the bundled deterministic stub agent |

## Development

```bash
# Backend: format, lint, test, coverage
cd backend
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo llvm-cov --all-targets --ignore-filename-regex 'src/(main\.rs|bin/)'

# Frontend: typecheck, test with coverage, build, component catalog
cd frontend
pnpm typecheck
pnpm coverage
pnpm build
pnpm ladle          # browse components locally

# End to end (needs a backend build and a frontend build)
cd e2e
pnpm install
pnpm exec playwright install chromium
pnpm test
```

The frontend proxies `/api` to `http://127.0.0.1:8787` in dev, so
`pnpm dev` in `frontend/` works against a separately running server.

## Testing

- Backend unit and integration tests run against the stub agent and temporary
  git repositories, so they need no model and no network. Line coverage is
  gated in CI (excluding `main.rs` argument wiring and the stub binary). The
  merged coverage view leaves three lines uncovered: two WebSocket send
  failures in `api.rs` and one auto-approval response in `manager.rs`, each an
  error-logging branch reachable only by a client-disconnect or process-death
  race that cannot be reproduced deterministically in a hermetic test.
- Frontend logic and components are covered to 100% with vitest; every
  component also has Ladle stories, and `pnpm ladle:build` runs in CI.
- The Playwright suite drives the built UI against a real backend in stub mode
  inside a fresh git repository, covering agent creation with a worktree, chat,
  every approval mode, cancellation, forking, side conversations, the diff
  view, and archiving.
- Mutation testing runs on a schedule: `cargo-mutants` for the backend
  services and Stryker for the frontend state and API modules.

## The stub agent

`stub-agent` is a small ACP agent that scripts deterministic behavior from the
prompt text, so every layer above the protocol can be tested without a model:

| Prompt contains | Behavior |
| --- | --- |
| `think: <text>` | emit a thought chunk, then echo |
| `approve:<kind>` | announce a tool call of `<kind>`, request permission, then complete or fail it per the answer |
| `slow` | stream one chunk, then wait for cancellation |
| `fail` | answer the turn with a JSON-RPC error |
| `env:<NAME>` | echo the value of environment variable `<NAME>` |
| anything else | echo the prompt back |
