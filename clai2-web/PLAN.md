# CLAI Web: agent management UI

A web control surface for running and supervising up to 100 concurrent CLAI
coding agents. A Rust backend orchestrates agent processes over the Agent
Client Protocol (ACP); a React frontend presents them in a single dashboard.

This document is the build plan and the architecture record. It describes what
exists under `clai2-web/` and why each piece is shaped the way it is.

## Goals

- Start, stop, and supervise up to 100 agents from one browser tab.
- Give each agent an isolated git worktree and branch on creation, so parallel
  agents can never overwrite each other's files.
- Per-agent approval modes, changeable live, that decide which tool calls run
  unattended and which wait for a human.
- Fork a running agent into a new worktree: the fork carries the parent's
  branch state, uncommitted changes, and conversation history.
- Side conversations: additional ACP sessions against the same agent process
  and worktree, for asking questions without disturbing the main thread.
- Review agent output as diffs against the base branch, not just as chat.

## Non-goals (v1)

- Multi-user auth. The server binds to localhost for a single operator.
- Remote/cloud execution. Agents run as local subprocesses.
- Editing files from the browser. The diff view is read-only; the agent or the
  operator's editor makes changes.

## Why this architecture

### ACP as the seam

The harness already exposes any Pydantic AI agent over ACP
(`pydantic_ai_harness.experimental.acp.run_acp_stdio`): a stdio JSON-RPC
protocol with streamed assistant/thought chunks, structured tool calls with
diff content, permission requests, multiple sessions per connection, and
cancellation. That is precisely the contract a management UI needs, and it
keeps the backend agent-agnostic: anything that serves ACP -- the bundled CLAI
coder launcher, or a custom agent script -- plugs in unchanged.

The backend is therefore an ACP *client* (the "editor" role): it spawns one
agent subprocess per managed agent and multiplexes every ACP session over that
process's stdio. No agent code runs in the backend process.

### Rust backend

The backend fans 50 stdio streams, WebSocket clients, and git subprocesses
into one event loop. Rust + tokio + axum gives predictable latency and memory
under that fan-in, a single static binary to ship, and a type system that
keeps the protocol layer honest. The backend holds no ML logic; it is pure
orchestration, which is exactly the work Rust is good at.

### Process-per-agent

Each agent is its own OS process. A crashed or wedged agent cannot take down
its neighbors; killing it is `SIGKILL`, not cooperative cancellation; and its
resource usage is visible to the OS. Side conversations reuse the parent
process (one more ACP session) so they share model context configuration and
worktree without paying process startup.

## System shape

```text
+------------------------------- browser -------------------------------+
| React UI: sidebar (agents) | chat/tools | approvals | diff | settings  |
+---------------------- REST + WebSocket (axum) ------------------------+
| Rust backend (clai2-web-server)                                        |
|   AgentManager  -- registry, lifecycle, status                         |
|   AcpClient     -- JSON-RPC over child stdio, one per agent process    |
|   WorktreeService - create/fork/remove worktrees, diff, branch naming  |
|   ApprovalService - per-agent mode, pending requests, responses        |
|   EventHub      -- broadcast of typed events to WS subscribers         |
|   Store         -- JSON persistence of agent metadata + transcripts    |
+------------------------------------------------------------------------+
      | spawn + stdio (ACP)                | git worktree ...
+---------------------+  +---------------------+
| agent process #1    |  | agent process #N    |   (up to 100)
| serve.py (ACP stdio)|  |                     |
| cwd = worktree #1   |  | cwd = worktree #N   |
+---------------------+  +---------------------+
```

## Backend design (`clai2-web/backend`)

Cargo workspace with two crates:

- `clai2-web-server`: the axum server and all services.
- `stub-agent`: a minimal ACP agent used by tests, e2e runs, and `--stub`
  dev mode. It scripts deterministic responses (text chunks, thought chunks,
  tool calls, permission requests) from directives embedded in the prompt, so
  every layer above the protocol can be exercised hermetically, with no model,
  no network, and no Python.

### Modules

- `acp::transport`: newline-delimited JSON-RPC 2.0 over the child's
  stdin/stdout. Owns request-id allocation, response correlation, inbound
  request dispatch (the agent calls the client too), and shutdown.
- `acp::client`: typed wrappers for `initialize`, `session/new`,
  `session/prompt`, `session/cancel`, `session/load`; handlers for
  `session/update` notifications and `session/request_permission` requests.
  Declines `fs/*` and `terminal/*` capabilities in v1 (the agent's own tools
  do file IO in the worktree).
- `agents`: `AgentManager` holds `Agent` records: id, name, status
  (`starting | idle | working | waiting_approval | error | archived`),
  worktree info, approval mode, sessions (main + side), usage counters, and
  the process handle. Enforces the 50-agent cap. Status transitions are
  driven only by protocol events, never guessed.
- `worktrees`: creates `<worktrees_dir>/<agent-slug>` via
  `git worktree add -b <branch>`; forking snapshots the parent worktree's
  uncommitted state (tracked and untracked) and replays it onto the child;
  removal prunes the worktree and optionally deletes the branch. Also serves
  `git status`/`git diff` for the review panel. All git access is through one
  audited module.
- `approvals`: `ApprovalMode` = `always_ask | accept_edits | auto` plus
  per-kind overrides. An incoming permission request is either answered
  immediately by policy or parked as a pending approval, surfaced over the
  event hub, and resolved by a UI response (or by cancellation).
- `events`: one broadcast channel of serde-tagged events
  (`agent_added`, `status_changed`, `message_chunk`, `thought_chunk`,
  `tool_call`, `tool_call_update`, `approval_requested`, `approval_resolved`,
  `turn_ended`, `agent_removed`, ...). The WS endpoint replays a snapshot on
  connect, then streams.
- `store`: append-only JSONL transcript per agent plus a JSON metadata file,
  written under a data dir. Restarting the backend restores the roster and
  history; processes are re-spawned lazily on the next prompt.
- `api`: REST + WS surface (below), thin over the services.

### HTTP surface

| Route | Purpose |
| --- | --- |
| `GET /api/agents` | roster with status, worktree, mode, usage |
| `POST /api/agents` | create: name, repo, base branch, worktree on/off, approval mode, agent command |
| `GET /api/agents/{id}` | detail incl. sessions |
| `DELETE /api/agents/{id}` | archive; optional worktree removal |
| `POST /api/agents/{id}/prompt` | send a prompt to the main session |
| `POST /api/agents/{id}/cancel` | cancel the in-flight turn |
| `POST /api/agents/{id}/fork` | new agent in a new worktree, carrying state + history |
| `POST /api/agents/{id}/sessions` | open a side conversation |
| `POST /api/agents/{id}/sessions/{sid}/prompt` | prompt a side conversation |
| `PATCH /api/agents/{id}/approval-mode` | change mode live |
| `GET /api/agents/{id}/approvals` | pending approvals |
| `POST /api/approvals/{approval_id}` | resolve with an option id |
| `GET /api/agents/{id}/transcript` | replay transcript (paged) |
| `GET /api/agents/{id}/diff` | worktree diff vs base branch |
| `GET /api/health` | liveness |
| `GET /api/ws` | WebSocket event stream |

### Concurrency rules

- One tokio task owns each child's stdout read loop; it publishes protocol
  events and never blocks on consumers (bounded channels, slow WS clients are
  disconnected rather than back-pressuring the agent).
- All registry mutation goes through `AgentManager` behind an async mutex;
  protocol IO never happens under the lock.
- Every spawned task is tied to the owning agent and aborted on archive.

## Fork semantics

Fork is "duplicate my situation, not my process":

1. Create a new worktree/branch at the parent's current `HEAD`.
2. Copy the parent worktree's uncommitted changes (tracked modifications and
   untracked files) into the child worktree.
3. Spawn a fresh agent process with cwd = child worktree.
4. Replay the parent's main-session transcript into the child's new session
   context (ACP `session/load` when the agent advertises it, otherwise a
   history preamble on the first prompt).
5. The parent keeps running untouched.

## Model profiles

A model profile is an environment overlay plus a provider-qualified model
string, defined and edited in the browser. Agents reference a profile by id;
the process for an agent is spawned with that profile's environment applied on
top of the server's own, isolating provider configuration per agent.

- `models::ModelProfile` derives the spawn environment from the provider and
  fields: `CLAI_MODEL` always, the provider's API-key variable for key-based
  providers, `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION` for Vertex, and any
  explicit extra variables. Vertex service-account JSON is written to a
  per-agent file at spawn and referenced by `GOOGLE_APPLICATION_CREDENTIALS`;
  the file is removed when the agent is archived.
- Profiles persist in `models.json` under the data dir, written owner-only on
  Unix because they hold secrets. Reads return a redacted view: secret values
  are replaced by presence flags, and an edit that omits a secret keeps the
  stored one, so the browser never has to round-trip a secret it was never
  shown.
- Deleting a profile in use by a live agent is refused. Switching an idle
  agent's profile restarts its process (reusing the history-replay path) so the
  new environment takes effect; switching is refused while a turn is running.
- The stub agent's `env:<NAME>` directive echoes an environment variable, which
  lets the tests assert that a profile's environment actually reached the
  process without a real provider.

## Approval modes

ACP permission requests carry option kinds (`allow_once`, `allow_always`,
`reject_once`, `reject_always`). Policy maps them:

- `always_ask`: every request is parked for the UI.
- `accept_edits`: file-edit tool calls auto-approve (`allow_once`); execute
  and other kinds park for the UI.
- `auto`: everything auto-approves (`allow_once`). The mode the UI labels
  loudly and styles in warning colors.

A mode change applies to requests arriving after the change; parked requests
stay parked. Cancelling a turn resolves its parked requests as `cancelled`.

## Frontend design (`clai2-web/frontend`)

Vite + React 18 + TypeScript strict. State in zustand slices (`agents`,
`transcripts`, `approvals`, `connection`). No component framework; hand-rolled
CSS on design tokens.

### Layout

- Left sidebar (resizable, virtualized beyond ~20 rows): agent list grouped by
  status -- needs attention first, then working, idle, archived. Each row:
  name, status dot, branch, pending-approval badge, live activity summary.
  Filter box, "New agent" button showing remaining capacity (n/50).
- Main pane, per selected agent, tabbed: **Conversation** (main session),
  one tab per **side conversation**, **Changes** (diff viewer), **Settings**
  (approval mode, worktree info, danger zone).
- Conversation view: streamed markdown text, collapsed thought chunks, tool
  call cards with status and diff previews, an approval banner pinned above
  the composer when the agent is waiting.
- Global approval inbox in the header: every pending approval across all 50
  agents, one click away.

### Pydantic branding

Design tokens mirror `pydantic_clai2.theme` (the brand palette CLAI already
ships): Lithium `#E520E9` as the primary accent, Calcium `#FF6550` for errors,
Purple `#9B77FF` for reasoning, Aqua `#77FFD8` / AI Cyan `#00FFEB` for links
and info, Sugar `#FBFFEA` headline text, Dark Purple `#36182D` background,
Element Purple `#49353F` outlines, Grey `#8F888E` muted text. Dark theme
first; tokens defined once as CSS custom properties.

## Testing strategy

Test the contract at every seam; keep everything hermetic.

- **Backend unit tests**: protocol framing, approval policy truth table,
  worktree branch naming, event serialization, store round-trips.
- **Backend integration tests**: spawn the real server against `stub-agent`
  and a temp git repo; drive create/prompt/approve/fork/side-session/diff
  through the public HTTP+WS surface.
- **Coverage**: `cargo llvm-cov` with a 100% line gate for the server crate
  (pragma'd exclusions only for `main()` wiring).
- **Mutation tests (backend)**: `cargo-mutants`, scoped to the services
  (protocol + policy + worktrees), run as a scheduled/manual CI job.
- **Frontend unit/component tests**: vitest + Testing Library; store logic and
  every component behavior (approval flows, status grouping, streaming
  renders). Coverage gate 100% (v8) over `src/`, excluding only bootstrap and
  stories.
- **Mutation tests (frontend)**: Stryker with the vitest runner, scoped to
  store and protocol-mapping modules, scheduled/manual in CI.
- **Component catalog**: Ladle stories for every leaf component and each
  agent-status/approval-state variant; `ladle build` runs in CI so stories
  can't rot.
- **E2E**: Playwright drives the built frontend against the real backend in
  stub-agent mode inside a temp git repo: create agent (worktree appears),
  chat round-trip, approval flow in each mode, fork (worktree + history
  carried), side conversation isolation, diff panel.

## CI

One workflow (`clai2-web.yml`), path-filtered to `clai2-web/**`:

1. `backend`: rustfmt check, clippy `-D warnings`, tests, llvm-cov gate.
2. `frontend`: typecheck, vitest with coverage gate, production build,
   Ladle build.
3. `e2e`: Playwright suite on the built artifacts.
4. `mutation` (scheduled + manual dispatch): cargo-mutants and Stryker with
   thresholds, kept off the PR critical path for runtime reasons.

## Milestones

1. **M1 -- skeleton**: crates, transport, stub agent, health endpoint, CI.
2. **M2 -- core loop**: create agent (+worktree), prompt, stream to WS,
   cancel; sidebar + conversation UI.
3. **M3 -- supervision**: approval modes end to end, global inbox, status
   grouping, transcript persistence and replay.
4. **M4 -- worktree power tools**: fork, side conversations, diff panel.
5. **M5 -- hardening**: 50-agent load test, mutation-test debt burn-down,
   docs.
