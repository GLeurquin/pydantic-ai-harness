//! End-to-end tests: real HTTP server, real WebSocket, real git worktrees,
//! and the stub ACP agent as the process behind every agent.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use clai2_web_server::manager::{AgentManager, ManagerConfig};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

const STUB_AGENT: &str = env!("CARGO_BIN_EXE_stub-agent");

struct World {
    base_url: String,
    ws_url: String,
    http: reqwest::Client,
    repo: PathBuf,
    /// The project bootstrapped from `repo` on manager startup.
    project_id: String,
    manager: Arc<AgentManager>,
    _dir: tempfile::TempDir,
}

async fn run(repo: &Path, args: &[&str]) {
    let output = tokio::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

async fn init_repo(repo: &Path) {
    tokio::fs::create_dir_all(repo).await.unwrap();
    run(repo, &["init", "-b", "main"]).await;
    run(repo, &["config", "user.email", "test@example.com"]).await;
    run(repo, &["config", "user.name", "Test"]).await;
    tokio::fs::write(repo.join("README.md"), "# demo\n").await.unwrap();
    run(repo, &["add", "."]).await;
    run(repo, &["commit", "-m", "init"]).await;
}

async fn world_with(max_agents: usize, agent_command: Vec<String>) -> World {
    world_with_github(max_agents, agent_command, "https://api.github.com".to_owned()).await
}

/// Like [`world_with`], but pointing GitHub REST calls at a caller-supplied
/// base URL -- a local mock server for tests that exercise the GitHub-issue
/// or CI-polling integration without ever depending on the real network.
async fn world_with_github(max_agents: usize, agent_command: Vec<String>, github_api_base_url: String) -> World {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    init_repo(&repo).await;
    let config = ManagerConfig {
        repo_root: repo.clone(),
        worktrees_dir: dir.path().join("worktrees"),
        data_dir: dir.path().join("data"),
        agent_command,
        max_agents,
        github_api_base_url,
    };
    let manager = AgentManager::new(config).await.unwrap();
    let project_id = manager.list_projects().await[0].id.clone();
    let router = clai2_web_server::build_router(Arc::clone(&manager));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    World {
        base_url: format!("http://{addr}"),
        ws_url: format!("ws://{addr}/api/ws"),
        http: reqwest::Client::new(),
        repo,
        project_id,
        manager,
        _dir: dir,
    }
}

async fn world() -> World {
    world_with(50, vec![STUB_AGENT.to_owned()]).await
}

impl World {
    async fn post(&self, path: &str, body: Value) -> (reqwest::StatusCode, Value) {
        let response = self
            .http
            .post(format!("{}{path}", self.base_url))
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = response.status();
        let value = response.json().await.unwrap_or(Value::Null);
        (status, value)
    }

    async fn get(&self, path: &str) -> (reqwest::StatusCode, Value) {
        let response = self.http.get(format!("{}{path}", self.base_url)).send().await.unwrap();
        let status = response.status();
        let value = response.json().await.unwrap_or(Value::Null);
        (status, value)
    }

    async fn create_agent(&self, name: &str, use_worktree: bool, mode: &str) -> Value {
        let (status, agent) = self
            .post(
                "/api/agents",
                json!({
                    "name": name,
                    "projectId": self.project_id,
                    "useWorktree": use_worktree,
                    "approvalMode": mode,
                }),
            )
            .await;
        assert_eq!(status, 200, "create agent failed: {agent}");
        agent
    }

    async fn patch(&self, path: &str, body: Value) -> (reqwest::StatusCode, Value) {
        let response = self
            .http
            .patch(format!("{}{path}", self.base_url))
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = response.status();
        let value = response.json().await.unwrap_or(Value::Null);
        (status, value)
    }

    async fn delete(&self, path: &str) -> reqwest::StatusCode {
        self.http
            .delete(format!("{}{path}", self.base_url))
            .send()
            .await
            .unwrap()
            .status()
    }

    async fn prompt(&self, agent_id: &str, session_id: &str, text: &str) {
        let (status, body) = self
            .post(
                &format!("/api/agents/{agent_id}/sessions/{session_id}/prompt"),
                json!({"text": text}),
            )
            .await;
        assert_eq!(status, 200, "prompt failed: {body}");
    }

    async fn ws(&self) -> Ws {
        let (stream, _) = tokio_tungstenite::connect_async(&self.ws_url).await.unwrap();
        let mut ws = Ws { stream };
        let snapshot = ws.next_event().await;
        assert_eq!(snapshot["type"], "snapshot");
        ws
    }
}

struct Ws {
    stream: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
}

impl Ws {
    async fn next_event(&mut self) -> Value {
        loop {
            let message = tokio::time::timeout(Duration::from_secs(30), self.stream.next())
                .await
                .expect("timed out waiting for event")
                .expect("stream ended")
                .expect("stream error");
            if let Message::Text(text) = message {
                return serde_json::from_str(&text).unwrap();
            }
        }
    }

    /// Read events until one satisfies the predicate, returning all seen.
    async fn collect_until(&mut self, predicate: impl Fn(&Value) -> bool) -> Vec<Value> {
        let mut events = Vec::new();
        loop {
            let event = self.next_event().await;
            let done = predicate(&event);
            events.push(event);
            if done {
                return events;
            }
        }
    }

    async fn close(mut self) {
        let _ = self.stream.send(Message::Close(None)).await;
    }
}

fn events_of_type<'a>(events: &'a [Value], event_type: &str) -> Vec<&'a Value> {
    events.iter().filter(|event| event["type"] == event_type).collect()
}

#[tokio::test]
async fn health_endpoint_answers() {
    let world = world().await;
    let (status, body) = world.get("/api/health").await;
    assert_eq!(status, 200);
    assert_eq!(body["ok"], true);
}

#[tokio::test]
async fn create_agent_provisions_worktree_and_branch() {
    let world = world().await;
    let agent = world.create_agent("Fix auth bug", true, "always_ask").await;
    assert_eq!(agent["status"], "idle");
    assert_eq!(agent["approvalMode"], "always_ask");
    let worktree_path = agent["worktree"]["path"].as_str().unwrap();
    assert!(Path::new(worktree_path).join("README.md").exists());
    let branch = agent["worktree"]["branch"].as_str().unwrap();
    assert!(branch.starts_with("clai2/agents/fix-auth-bug-"), "branch: {branch}");
    assert_eq!(agent["worktree"]["baseBranch"], "main");
    assert_eq!(agent["sessions"][0]["id"], "main");
    assert_eq!(agent["sessions"][0]["isMain"], true);

    let output = tokio::process::Command::new("git")
        .arg("-C")
        .arg(&world.repo)
        .args(["worktree", "list"])
        .output()
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&output.stdout).contains(worktree_path));
}

#[tokio::test]
async fn create_agent_without_worktree_runs_in_repo() {
    let world = world().await;
    let agent = world.create_agent("chat only", false, "auto").await;
    assert!(agent["worktree"].is_null());
    assert_eq!(agent["cwd"].as_str().unwrap(), world.repo.to_str().unwrap());
}

#[tokio::test]
async fn create_agent_rejects_blank_name() {
    let world = world().await;
    let (status, body) = world
        .post(
            "/api/agents",
            json!({"name": "  ", "projectId": world.project_id, "approvalMode": "auto"}),
        )
        .await;
    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().contains("name"));
}

#[tokio::test]
async fn prompt_streams_chunks_and_ends_turn() {
    let world = world().await;
    let agent = world.create_agent("echoer", false, "always_ask").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "hello there").await;
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    ws.close().await;

    let user = events_of_type(&events, "userMessage");
    assert_eq!(user[0]["text"], "hello there");
    let chunks = events_of_type(&events, "messageChunk");
    assert_eq!(chunks[0]["text"], "echo: hello there");
    assert_eq!(chunks[0]["sessionId"], "main");
    let ended = events_of_type(&events, "turnEnded");
    assert_eq!(ended[0]["stopReason"], "end_turn");

    let (status, transcript) = world
        .get(&format!("/api/agents/{agent_id}/sessions/main/transcript"))
        .await;
    assert_eq!(status, 200);
    let items = transcript.as_array().unwrap();
    assert_eq!(items[0]["type"], "userMessage");
    assert!(items.iter().any(|item| item["type"] == "messageChunk"));
    assert!(items.iter().any(|item| item["type"] == "turnEnded"));

    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert_eq!(fetched["status"], "idle");
}

#[tokio::test]
async fn prompting_twice_accumulates_session_usage_totals() {
    let world = world().await;
    let agent = world.create_agent("echoer", false, "always_ask").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;

    world.prompt(agent_id, "main", "first").await;
    let first_events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    let first_ended = events_of_type(&first_events, "turnEnded");
    // The stub agent's default echo path reports totalTokens: 3, inputTokens: 2, outputTokens: 1.
    assert_eq!(first_ended[0]["usage"]["inputTokens"], 2);
    assert_eq!(first_ended[0]["usage"]["outputTokens"], 1);
    assert_eq!(first_ended[0]["usage"]["totalTokens"], 3);

    world.prompt(agent_id, "main", "second").await;
    ws.collect_until(|event| event["type"] == "turnEnded").await;
    ws.close().await;

    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    let sessions = fetched["sessions"].as_array().unwrap();
    let main = sessions.iter().find(|session| session["id"] == "main").unwrap();
    assert_eq!(main["totalInputTokens"], 4);
    assert_eq!(main["totalOutputTokens"], 2);
    assert_eq!(main["totalTokens"], 6);
}

#[tokio::test]
async fn goal_completes_via_the_mark_goal_complete_tool() {
    let world = world().await;
    let agent = world.create_agent("goal-agent", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;

    let (status, set) = world
        .post(
            &format!("/api/agents/{agent_id}/goal"),
            json!({"goal": "say complete-goal right away", "maxTurns": 5}),
        )
        .await;
    assert_eq!(status, 200, "{set}");
    assert_eq!(set["goal"]["goal"], "say complete-goal right away");
    assert_eq!(set["goal"]["maxTurns"], 5);
    assert_eq!(set["goal"]["turnsUsed"], 0);

    let events = ws
        .collect_until(|event| event["type"] == "agentUpdated" && event["agent"]["goal"].is_null())
        .await;
    let turn_ends = events_of_type(&events, "turnEnded");
    assert_eq!(
        turn_ends.len(),
        1,
        "the tool call should stop the loop after just the completing turn"
    );

    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert!(fetched["goal"].is_null());
}

#[tokio::test]
async fn goal_stops_after_max_turns_without_completing() {
    let world = world().await;
    let agent = world.create_agent("goal-agent-exhaust", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;

    let (status, _) = world
        .post(
            &format!("/api/agents/{agent_id}/goal"),
            json!({"goal": "keep working forever", "maxTurns": 2}),
        )
        .await;
    assert_eq!(status, 200);

    let events = ws
        .collect_until(|event| event["type"] == "agentUpdated" && event["agent"]["goal"].is_null())
        .await;
    let turn_ends = events_of_type(&events, "turnEnded");
    assert_eq!(
        turn_ends.len(),
        2,
        "should run exactly maxTurns turns then stop without completing"
    );

    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert!(fetched["goal"].is_null());
}

#[tokio::test]
async fn goal_pauses_for_approval_then_stops_once_resolved() {
    let world = world().await;
    let agent = world.create_agent("goal-agent-approval", false, "always_ask").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;

    let (status, set) = world
        .post(
            &format!("/api/agents/{agent_id}/goal"),
            json!({"goal": "approve:execute run the tests", "maxTurns": 5}),
        )
        .await;
    assert_eq!(status, 200);
    assert!(!set["goal"].is_null());

    let events = ws.collect_until(|event| event["type"] == "approvalRequested").await;
    let approval = &events_of_type(&events, "approvalRequested").last().unwrap()["approval"];
    let approval_id = approval["id"].as_str().unwrap().to_owned();

    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert_eq!(fetched["status"], "waiting_approval");
    assert!(
        !fetched["goal"].is_null(),
        "the goal stays visible while parked on an approval"
    );

    // Reject it: the turn ends `cancelled`, not `end_turn`, so the
    // auto-continuation stops instead of firing another prompt.
    let (status, _) = world
        .post(
            &format!("/api/approvals/{approval_id}"),
            json!({"optionId": "reject_once"}),
        )
        .await;
    assert_eq!(status, 200);

    ws.collect_until(|event| event["type"] == "agentUpdated" && event["agent"]["goal"].is_null())
        .await;
    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert!(fetched["goal"].is_null());
}

#[tokio::test]
async fn cancel_clears_an_active_goal() {
    let world = world().await;
    let agent = world.create_agent("goal-agent-cancel", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();

    let (status, set) = world
        .post(
            &format!("/api/agents/{agent_id}/goal"),
            json!({"goal": "keep working", "maxTurns": 5}),
        )
        .await;
    assert_eq!(status, 200);
    assert!(!set["goal"].is_null());

    let (status, _) = world.post(&format!("/api/agents/{agent_id}/cancel"), json!({})).await;
    assert_eq!(status, 200);
    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert!(fetched["goal"].is_null());
}

#[tokio::test]
async fn setting_a_blank_goal_is_rejected() {
    let world = world().await;
    let agent = world.create_agent("goal-agent-blank", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let (status, _) = world
        .post(
            &format!("/api/agents/{agent_id}/goal"),
            json!({"goal": "   ", "maxTurns": 3}),
        )
        .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn setting_a_goal_with_zero_max_turns_is_rejected() {
    let world = world().await;
    let agent = world.create_agent("goal-agent-zero", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let (status, _) = world
        .post(
            &format!("/api/agents/{agent_id}/goal"),
            json!({"goal": "do it", "maxTurns": 0}),
        )
        .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn setting_a_goal_on_an_archived_agent_rolls_back_and_errors() {
    let world = world().await;
    let agent = world.create_agent("goal-agent-archived", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    world
        .http
        .delete(format!("{}/api/agents/{agent_id}", world.base_url))
        .send()
        .await
        .unwrap();

    let (status, _) = world
        .post(
            &format!("/api/agents/{agent_id}/goal"),
            json!({"goal": "do it", "maxTurns": 3}),
        )
        .await;
    assert_eq!(status, 400);

    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert!(
        fetched["goal"].is_null(),
        "the goal set before the failed prompt must be rolled back"
    );
}

#[tokio::test]
async fn clearing_an_unset_goal_is_a_no_op() {
    let world = world().await;
    let agent = world.create_agent("goal-agent-clear", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let status = world.delete(&format!("/api/agents/{agent_id}/goal")).await;
    assert_eq!(status, 200);
    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert!(fetched["goal"].is_null());
}

#[tokio::test]
async fn creating_an_agent_with_an_initial_prompt_seeds_the_first_turn() {
    let world = world().await;
    // The manager only awaits recording the user message before returning from
    // `create_agent`; the turn itself runs in a spawned task, so a WS connection
    // opened before the create call is what proves it actually ran, not just
    // that a message was queued.
    let mut ws = world.ws().await;

    let (status, agent) = world
        .post(
            "/api/agents",
            json!({
                "name": "from issue",
                "projectId": world.project_id,
                "approvalMode": "always_ask",
                "initialPrompt": "hello there",
            }),
        )
        .await;
    assert_eq!(status, 200, "create agent failed: {agent}");
    let agent_id = agent["id"].as_str().unwrap().to_owned();

    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    ws.close().await;
    let user = events_of_type(&events, "userMessage");
    assert_eq!(user[0]["text"], "hello there");

    let (status, transcript) = world
        .get(&format!("/api/agents/{agent_id}/sessions/main/transcript"))
        .await;
    assert_eq!(status, 200);
    let items = transcript.as_array().unwrap();
    assert_eq!(items[0]["type"], "userMessage");
    assert_eq!(items[0]["text"], "hello there");
    assert!(items.iter().any(|item| item["type"] == "turnEnded"));

    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert_eq!(fetched["status"], "idle");
}

#[tokio::test]
async fn github_settings_default_to_no_token_and_round_trip_through_set_and_clear() {
    let world = world().await;

    let (status, settings) = world.get("/api/github").await;
    assert_eq!(status, 200);
    assert_eq!(settings["hasToken"], false);
    assert_eq!(settings["pollIntervalSecs"], 300);

    let (status, settings) = world.patch("/api/github", json!({"token": "ghp_secret"})).await;
    assert_eq!(status, 200);
    assert_eq!(settings["hasToken"], true);
    assert!(
        settings.get("token").is_none(),
        "the token must never round-trip to the client"
    );

    let (status, settings) = world.get("/api/github").await;
    assert_eq!(status, 200);
    assert_eq!(settings["hasToken"], true);

    let status = world.delete("/api/github").await;
    assert_eq!(status, 200);

    let (status, settings) = world.get("/api/github").await;
    assert_eq!(status, 200);
    assert_eq!(settings["hasToken"], false);
}

#[tokio::test]
async fn setting_a_blank_github_token_is_rejected() {
    let world = world().await;
    let (status, body) = world.patch("/api/github", json!({"token": "   "})).await;
    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().contains("token"));
    let (_, settings) = world.get("/api/github").await;
    assert_eq!(settings["hasToken"], false);
}

#[tokio::test]
async fn fetching_an_issue_without_a_token_configured_is_400() {
    let world = world().await;
    let (status, body) = world
        .post("/api/github/issue", json!({"issueRef": "pydantic/pydantic-ai#1"}))
        .await;
    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().contains("no GitHub token"));
}

#[tokio::test]
async fn fetching_an_issue_with_a_malformed_reference_is_400() {
    let world = world().await;
    let (status, _) = world.patch("/api/github", json!({"token": "ghp_secret"})).await;
    assert_eq!(status, 200);

    let (status, body) = world
        .post("/api/github/issue", json!({"issueRef": "not-an-issue"}))
        .await;
    assert_eq!(status, 400);
    assert!(
        body["error"].as_str().unwrap().contains("could not parse"),
        "error: {body}"
    );
}

#[tokio::test]
async fn fetching_an_issue_returns_title_body_url_and_a_ready_made_prompt() {
    let app = axum::Router::new().route(
        "/repos/o/r/issues/1",
        axum::routing::get(|| async {
            axum::Json(json!({
                "title": "Bug: things break",
                "body": "Steps to reproduce...",
                "html_url": "https://github.com/o/r/issues/1",
            }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let world = world_with_github(50, vec![STUB_AGENT.to_owned()], format!("http://{addr}")).await;
    world.patch("/api/github", json!({"token": "ghp_secret"})).await;

    let (status, issue) = world.post("/api/github/issue", json!({"issueRef": "o/r#1"})).await;
    assert_eq!(status, 200, "{issue}");
    assert_eq!(issue["title"], "Bug: things break");
    assert_eq!(issue["body"], "Steps to reproduce...");
    assert_eq!(issue["url"], "https://github.com/o/r/issues/1");
    let prompt = issue["prompt"].as_str().unwrap();
    assert!(prompt.contains("Bug: things break"));
    assert!(prompt.contains("Steps to reproduce..."));
    assert!(prompt.contains("https://github.com/o/r/issues/1"));
}

#[tokio::test]
async fn setting_the_github_poll_interval_persists_it() {
    let world = world().await;
    let (status, settings) = world
        .patch("/api/github/poll-interval", json!({"pollIntervalSecs": 120}))
        .await;
    assert_eq!(status, 200, "{settings}");
    assert_eq!(settings["pollIntervalSecs"], 120);

    let (_, settings) = world.get("/api/github").await;
    assert_eq!(settings["pollIntervalSecs"], 120);
}

#[tokio::test]
async fn setting_the_github_poll_interval_below_the_floor_is_400() {
    let world = world().await;
    let (status, body) = world
        .patch("/api/github/poll-interval", json!({"pollIntervalSecs": 10}))
        .await;
    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().contains("30 seconds"));
    let (_, settings) = world.get("/api/github").await;
    assert_eq!(settings["pollIntervalSecs"], 300);
}

#[tokio::test]
async fn setting_and_clearing_ci_tracking_round_trips() {
    let world = world().await;
    let agent = world.create_agent("ci-agent", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();

    let (status, updated) = world
        .post(
            &format!("/api/agents/{agent_id}/ci-tracking"),
            json!({"prRef": "o/r#1"}),
        )
        .await;
    assert_eq!(status, 200, "{updated}");
    assert_eq!(updated["ciTracking"]["prRef"], "o/r#1");
    assert_eq!(updated["ciTracking"]["lastState"], "unknown");

    let status = world.delete(&format!("/api/agents/{agent_id}/ci-tracking")).await;
    assert_eq!(status, 200);
    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert!(fetched["ciTracking"].is_null());
}

#[tokio::test]
async fn setting_ci_tracking_with_a_malformed_reference_is_400() {
    let world = world().await;
    let agent = world.create_agent("ci-agent-bad-ref", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let (status, body) = world
        .post(
            &format!("/api/agents/{agent_id}/ci-tracking"),
            json!({"prRef": "not-a-pr"}),
        )
        .await;
    assert_eq!(status, 400);
    assert!(
        body["error"].as_str().unwrap().contains("could not parse"),
        "error: {body}"
    );
}

#[tokio::test]
async fn setting_ci_tracking_on_an_unknown_agent_is_404() {
    let world = world().await;
    let (status, _) = world
        .post("/api/agents/ghost/ci-tracking", json!({"prRef": "o/r#1"}))
        .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn setting_ci_tracking_on_an_archived_agent_is_400() {
    let world = world().await;
    let agent = world.create_agent("ci-agent-archived", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    world.delete(&format!("/api/agents/{agent_id}")).await;
    let (status, _) = world
        .post(
            &format!("/api/agents/{agent_id}/ci-tracking"),
            json!({"prRef": "o/r#1"}),
        )
        .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn clearing_ci_tracking_on_an_unset_agent_is_a_no_op() {
    let world = world().await;
    let agent = world.create_agent("ci-agent-clear", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let status = world.delete(&format!("/api/agents/{agent_id}/ci-tracking")).await;
    assert_eq!(status, 200);
    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert!(fetched["ciTracking"].is_null());
}

/// A local mock GitHub server: PR #1 in `o/r` with head sha `abc123`, and a
/// controllable check-runs response. Returns its base URL plus a counter of
/// how many times the check-runs endpoint was hit, so a test can prove a
/// poll was (or wasn't) skipped.
async fn mock_github_ci(check_runs: Value) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
    let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let hits_for_route = Arc::clone(&hits);
    let app = axum::Router::new()
        .route(
            "/repos/o/r/pulls/1",
            axum::routing::get(|| async {
                axum::Json(json!({"head": {"sha": "abc123"}, "html_url": "https://github.com/o/r/pull/1"}))
            }),
        )
        .route(
            "/repos/o/r/commits/abc123/check-runs",
            axum::routing::get(move || {
                let hits = Arc::clone(&hits_for_route);
                let check_runs = check_runs.clone();
                async move {
                    hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    axum::Json(json!({"check_runs": check_runs}))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), hits)
}

#[tokio::test]
async fn poll_ci_once_prompts_the_agent_when_ci_turns_failing() {
    let (github_base, _hits) = mock_github_ci(json!([
        {"name": "test", "status": "completed", "conclusion": "failure"},
    ]))
    .await;
    let world = world_with_github(50, vec![STUB_AGENT.to_owned()], github_base).await;
    world.patch("/api/github", json!({"token": "ghp_secret"})).await;
    let agent = world.create_agent("ci-poll-agent", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    world
        .post(
            &format!("/api/agents/{agent_id}/ci-tracking"),
            json!({"prRef": "o/r#1"}),
        )
        .await;

    world.manager.poll_ci_once().await;

    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert_eq!(fetched["ciTracking"]["lastState"], "failure");

    let (_, transcript) = world
        .get(&format!("/api/agents/{agent_id}/sessions/main/transcript"))
        .await;
    let items = transcript.as_array().unwrap();
    let prompt = items
        .iter()
        .find(|item| item["type"] == "userMessage")
        .unwrap_or_else(|| panic!("no auto-prompt in transcript: {items:?}"));
    assert!(prompt["text"].as_str().unwrap().contains("CI is failing"));
    assert!(prompt["text"].as_str().unwrap().contains("test"));
}

#[tokio::test]
async fn poll_ci_once_skips_a_check_that_is_not_yet_due() {
    let (github_base, hits) = mock_github_ci(json!([
        {"name": "test", "status": "completed", "conclusion": "success"},
    ]))
    .await;
    let world = world_with_github(50, vec![STUB_AGENT.to_owned()], github_base).await;
    world.patch("/api/github", json!({"token": "ghp_secret"})).await;
    let agent = world.create_agent("ci-poll-due-agent", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    world
        .post(
            &format!("/api/agents/{agent_id}/ci-tracking"),
            json!({"prRef": "o/r#1"}),
        )
        .await;

    world.manager.poll_ci_once().await;
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
    world.manager.poll_ci_once().await;
    assert_eq!(
        hits.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the default 5-minute interval hasn't elapsed, so the second poll should be skipped"
    );
}

#[tokio::test]
async fn poll_ci_once_does_not_prompt_a_busy_agent() {
    let (github_base, _hits) = mock_github_ci(json!([
        {"name": "test", "status": "completed", "conclusion": "failure"},
    ]))
    .await;
    let world = world_with_github(50, vec![STUB_AGENT.to_owned()], github_base).await;
    world.patch("/api/github", json!({"token": "ghp_secret"})).await;
    let agent = world.create_agent("ci-poll-busy-agent", false, "always_ask").await;
    let agent_id = agent["id"].as_str().unwrap();
    world
        .post(
            &format!("/api/agents/{agent_id}/ci-tracking"),
            json!({"prRef": "o/r#1"}),
        )
        .await;

    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "slow").await;
    ws.collect_until(|event| event["type"] == "messageChunk").await;

    world.manager.poll_ci_once().await;

    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert_eq!(
        fetched["ciTracking"]["lastState"], "unknown",
        "a failure observed while busy must not be recorded, so the next poll retries"
    );
    let (_, transcript) = world
        .get(&format!("/api/agents/{agent_id}/sessions/main/transcript"))
        .await;
    let items = transcript.as_array().unwrap();
    assert!(
        items
            .iter()
            .filter(|item| item["type"] == "userMessage")
            .all(|item| item["text"] == "slow"),
        "no CI auto-prompt should have been sent while the agent was busy: {items:?}"
    );

    let (status, _) = world.post(&format!("/api/agents/{agent_id}/cancel"), json!({})).await;
    assert_eq!(status, 200);
    ws.close().await;
}

#[tokio::test]
async fn poll_ci_once_skips_archived_agents() {
    let (github_base, hits) = mock_github_ci(json!([])).await;
    let world = world_with_github(50, vec![STUB_AGENT.to_owned()], github_base).await;
    world.patch("/api/github", json!({"token": "ghp_secret"})).await;
    let agent = world.create_agent("ci-poll-archived-agent", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    world
        .post(
            &format!("/api/agents/{agent_id}/ci-tracking"),
            json!({"prRef": "o/r#1"}),
        )
        .await;
    world.delete(&format!("/api/agents/{agent_id}")).await;

    world.manager.poll_ci_once().await;
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[tokio::test]
async fn poll_ci_once_does_nothing_without_a_github_token() {
    let (github_base, hits) = mock_github_ci(json!([])).await;
    let world = world_with_github(50, vec![STUB_AGENT.to_owned()], github_base).await;
    let agent = world.create_agent("ci-poll-no-token-agent", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    world
        .post(
            &format!("/api/agents/{agent_id}/ci-tracking"),
            json!({"prRef": "o/r#1"}),
        )
        .await;

    world.manager.poll_ci_once().await;
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);
    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert_eq!(fetched["ciTracking"]["lastState"], "unknown");
}

#[tokio::test]
async fn poll_ci_once_tolerates_a_github_error_and_leaves_state_unchanged() {
    let app = axum::Router::new().route(
        "/repos/o/r/pulls/1",
        axum::routing::get(|| async {
            (
                axum::http::StatusCode::NOT_FOUND,
                axum::Json(json!({"message": "Not Found"})),
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let world = world_with_github(50, vec![STUB_AGENT.to_owned()], format!("http://{addr}")).await;
    world.patch("/api/github", json!({"token": "ghp_secret"})).await;
    let agent = world.create_agent("ci-poll-error-agent", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    world
        .post(
            &format!("/api/agents/{agent_id}/ci-tracking"),
            json!({"prRef": "o/r#1"}),
        )
        .await;

    world.manager.poll_ci_once().await;

    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert_eq!(
        fetched["ciTracking"]["lastState"], "unknown",
        "a failed check must not be mistaken for an observed state"
    );
}

#[tokio::test]
async fn thought_chunks_stream_separately() {
    let world = world().await;
    let agent = world.create_agent("thinker", false, "always_ask").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "think: deeply").await;
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    ws.close().await;
    let thoughts = events_of_type(&events, "thoughtChunk");
    assert_eq!(thoughts[0]["text"], "deeply");
}

#[tokio::test]
async fn always_ask_parks_approval_and_allow_runs_tool() {
    let world = world().await;
    let agent = world.create_agent("guarded", false, "always_ask").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "approve:execute run the tests").await;

    let events = ws.collect_until(|event| event["type"] == "approvalRequested").await;
    let approval = &events.last().unwrap()["approval"];
    assert_eq!(approval["agentId"], agent_id);
    assert_eq!(approval["toolCall"]["kind"], "execute");
    assert_eq!(approval["options"].as_array().unwrap().len(), 4);
    let approval_id = approval["id"].as_str().unwrap();

    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert_eq!(fetched["status"], "waiting_approval");
    assert_eq!(fetched["pendingApprovals"], 1);

    let (_, pending) = world.get("/api/approvals").await;
    assert_eq!(pending.as_array().unwrap().len(), 1);
    let (_, pending_for) = world.get(&format!("/api/agents/{agent_id}/approvals")).await;
    assert_eq!(pending_for.as_array().unwrap().len(), 1);

    let (status, _) = world
        .post(
            &format!("/api/approvals/{approval_id}"),
            json!({"optionId": "allow_once"}),
        )
        .await;
    assert_eq!(status, 200);

    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    ws.close().await;
    let resolved = events_of_type(&events, "approvalResolved");
    assert_eq!(resolved[0]["optionId"], "allow_once");
    let chunks = events_of_type(&events, "messageChunk");
    assert!(chunks.iter().any(|chunk| chunk["text"] == "tool ran"));
    let calls = events_of_type(&events, "toolCall");
    assert!(calls.iter().any(|call| call["toolCall"]["status"] == "completed"));

    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert_eq!(fetched["status"], "idle");
    assert_eq!(fetched["pendingApprovals"], 0);
}

#[tokio::test]
async fn rejecting_an_approval_fails_the_tool() {
    let world = world().await;
    let agent = world.create_agent("guarded", false, "always_ask").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "approve:execute rm -rf").await;
    let events = ws.collect_until(|event| event["type"] == "approvalRequested").await;
    let approval_id = events.last().unwrap()["approval"]["id"].as_str().unwrap().to_owned();
    let (status, _) = world
        .post(
            &format!("/api/approvals/{approval_id}"),
            json!({"optionId": "reject_once"}),
        )
        .await;
    assert_eq!(status, 200);
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    ws.close().await;
    let chunks = events_of_type(&events, "messageChunk");
    assert!(chunks.iter().any(|chunk| chunk["text"] == "tool rejected"));
    let calls = events_of_type(&events, "toolCall");
    assert!(calls.iter().any(|call| call["toolCall"]["status"] == "failed"));
}

#[tokio::test]
async fn resolving_unknown_approval_is_404() {
    let world = world().await;
    let (status, _) = world
        .post("/api/approvals/nope", json!({"optionId": "allow_once"}))
        .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn accept_edits_auto_approves_edits_but_parks_execute() {
    let world = world().await;
    let agent = world.create_agent("editor", false, "accept_edits").await;
    let agent_id = agent["id"].as_str().unwrap();

    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "approve:edit src file").await;
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    assert!(events_of_type(&events, "approvalRequested").is_empty());
    let chunks = events_of_type(&events, "messageChunk");
    assert!(chunks.iter().any(|chunk| chunk["text"] == "tool ran"));

    world.prompt(agent_id, "main", "approve:execute build").await;
    let events = ws.collect_until(|event| event["type"] == "approvalRequested").await;
    ws.close().await;
    let approval_id = events.last().unwrap()["approval"]["id"].as_str().unwrap().to_owned();
    world
        .post(
            &format!("/api/approvals/{approval_id}"),
            json!({"optionId": "reject_once"}),
        )
        .await;
}

#[tokio::test]
async fn auto_mode_approves_everything() {
    let world = world().await;
    let agent = world.create_agent("yolo", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "approve:execute anything").await;
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    ws.close().await;
    assert!(events_of_type(&events, "approvalRequested").is_empty());
    let chunks = events_of_type(&events, "messageChunk");
    assert!(chunks.iter().any(|chunk| chunk["text"] == "tool ran"));
}

#[tokio::test]
async fn approval_mode_changes_apply_live() {
    let world = world().await;
    let agent = world.create_agent("mutable", false, "always_ask").await;
    let agent_id = agent["id"].as_str().unwrap();
    let (status, updated) = {
        let response = world
            .http
            .patch(format!("{}/api/agents/{agent_id}/approval-mode", world.base_url))
            .json(&json!({"approvalMode": "auto"}))
            .send()
            .await
            .unwrap();
        (response.status(), response.json::<Value>().await.unwrap())
    };
    assert_eq!(status, 200);
    assert_eq!(updated["approvalMode"], "auto");

    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "approve:execute now allowed").await;
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    ws.close().await;
    assert!(events_of_type(&events, "approvalRequested").is_empty());
}

#[tokio::test]
async fn cancel_stops_a_running_turn() {
    let world = world().await;
    let agent = world.create_agent("slowpoke", false, "always_ask").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "slow").await;
    ws.collect_until(|event| event["type"] == "messageChunk").await;
    let (status, _) = world.post(&format!("/api/agents/{agent_id}/cancel"), json!({})).await;
    assert_eq!(status, 200);
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    ws.close().await;
    let ended = events_of_type(&events, "turnEnded");
    assert_eq!(ended[0]["stopReason"], "cancelled");
}

#[tokio::test]
async fn cancel_resolves_parked_approvals() {
    let world = world().await;
    let agent = world.create_agent("parked", false, "always_ask").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "approve:execute risky").await;
    ws.collect_until(|event| event["type"] == "approvalRequested").await;
    world.post(&format!("/api/agents/{agent_id}/cancel"), json!({})).await;
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    ws.close().await;
    let resolved = events_of_type(&events, "approvalResolved");
    assert!(resolved[0]["optionId"].is_null());
    let ended = events_of_type(&events, "turnEnded");
    assert_eq!(ended[0]["stopReason"], "cancelled");
    let (_, pending) = world.get("/api/approvals").await;
    assert!(pending.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn side_conversations_are_isolated_sessions() {
    let world = world().await;
    let agent = world.create_agent("multi", false, "always_ask").await;
    let agent_id = agent["id"].as_str().unwrap();
    let (status, updated) = world
        .post(&format!("/api/agents/{agent_id}/sessions"), json!({"label": "Q&A"}))
        .await;
    assert_eq!(status, 200);
    let sessions = updated["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    let side_id = sessions[1]["id"].as_str().unwrap().to_owned();
    assert_eq!(sessions[1]["label"], "Q&A");
    assert_eq!(sessions[1]["isMain"], false);

    let mut ws = world.ws().await;
    world.prompt(agent_id, &side_id, "side question").await;
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    ws.close().await;
    let chunks = events_of_type(&events, "messageChunk");
    assert_eq!(chunks[0]["sessionId"], side_id.as_str());
    assert_eq!(chunks[0]["text"], "echo: side question");

    // The main transcript is untouched; the side transcript has the turn.
    let (_, main_transcript) = world
        .get(&format!("/api/agents/{agent_id}/sessions/main/transcript"))
        .await;
    assert!(main_transcript.as_array().unwrap().is_empty());
    let (_, side_transcript) = world
        .get(&format!("/api/agents/{agent_id}/sessions/{side_id}/transcript"))
        .await;
    assert!(!side_transcript.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn side_session_requires_label() {
    let world = world().await;
    let agent = world.create_agent("multi", false, "always_ask").await;
    let agent_id = agent["id"].as_str().unwrap();
    let (status, _) = world
        .post(&format!("/api/agents/{agent_id}/sessions"), json!({"label": "  "}))
        .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn fork_carries_worktree_state_and_history() {
    let world = world().await;
    let agent = world.create_agent("parent", true, "accept_edits").await;
    let agent_id = agent["id"].as_str().unwrap();
    let parent_worktree = PathBuf::from(agent["worktree"]["path"].as_str().unwrap());

    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "remember the plan").await;
    ws.collect_until(|event| event["type"] == "turnEnded").await;

    // Uncommitted state in the parent worktree: a tracked edit and a new file.
    tokio::fs::write(parent_worktree.join("README.md"), "# demo\nedited\n")
        .await
        .unwrap();
    tokio::fs::write(parent_worktree.join("notes.txt"), "scratch\n")
        .await
        .unwrap();

    let (status, fork) = world
        .post(&format!("/api/agents/{agent_id}/fork"), json!({"name": "parent fork"}))
        .await;
    assert_eq!(status, 200, "fork failed: {fork}");
    assert_eq!(fork["forkedFrom"], agent_id);
    assert_eq!(fork["approvalMode"], "accept_edits");
    let fork_id = fork["id"].as_str().unwrap();
    let fork_worktree = PathBuf::from(fork["worktree"]["path"].as_str().unwrap());
    assert_ne!(fork_worktree, parent_worktree);
    let readme = tokio::fs::read_to_string(fork_worktree.join("README.md"))
        .await
        .unwrap();
    assert!(readme.contains("edited"));
    let notes = tokio::fs::read_to_string(fork_worktree.join("notes.txt"))
        .await
        .unwrap();
    assert_eq!(notes, "scratch\n");

    // The fork's transcript starts as a copy of the parent's.
    let (_, transcript) = world
        .get(&format!("/api/agents/{fork_id}/sessions/main/transcript"))
        .await;
    let items = transcript.as_array().unwrap();
    assert!(items.iter().any(|item| item["text"] == "remember the plan"));

    // Its first prompt carries the history preamble to the fresh process.
    world.prompt(fork_id, "main", "continue").await;
    let events = ws
        .collect_until(|event| event["type"] == "turnEnded" && event["agentId"] == fork_id)
        .await;
    ws.close().await;
    let echo = events_of_type(&events, "messageChunk")
        .iter()
        .filter(|chunk| chunk["agentId"] == fork_id)
        .map(|chunk| chunk["text"].as_str().unwrap().to_owned())
        .collect::<String>();
    assert!(echo.contains("<conversation-history>"), "echo: {echo}");
    assert!(echo.contains("User: remember the plan"), "echo: {echo}");
    assert!(echo.contains("continue"), "echo: {echo}");

    // The second prompt does not repeat the preamble.
    let mut ws = world.ws().await;
    world.prompt(fork_id, "main", "and again").await;
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    ws.close().await;
    let echo = events_of_type(&events, "messageChunk")
        .iter()
        .map(|chunk| chunk["text"].as_str().unwrap().to_owned())
        .collect::<String>();
    assert!(!echo.contains("<conversation-history>"), "echo: {echo}");
}

#[tokio::test]
async fn fork_of_missing_agent_is_404() {
    let world = world().await;
    let (status, _) = world.post("/api/agents/ghost/fork", json!({"name": "x"})).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn archive_kills_agent_and_removes_worktree() {
    let world = world().await;
    let agent = world.create_agent("done", true, "always_ask").await;
    let agent_id = agent["id"].as_str().unwrap();
    let worktree_path = PathBuf::from(agent["worktree"]["path"].as_str().unwrap());
    assert!(worktree_path.exists());

    let response = world
        .http
        .delete(format!("{}/api/agents/{agent_id}?removeWorktree=true", world.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let archived: Value = response.json().await.unwrap();
    assert_eq!(archived["status"], "archived");
    assert!(archived["worktree"].is_null());
    assert!(!worktree_path.exists());

    let (status, body) = world
        .post(
            &format!("/api/agents/{agent_id}/sessions/main/prompt"),
            json!({"text": "hi"}),
        )
        .await;
    assert_eq!(status, 400, "prompting archived agent: {body}");
}

#[tokio::test]
async fn agent_cap_is_enforced() {
    let world = world_with(2, vec![STUB_AGENT.to_owned()]).await;
    world.create_agent("one", false, "auto").await;
    world.create_agent("two", false, "auto").await;
    let (status, body) = world
        .post(
            "/api/agents",
            json!({"name": "three", "projectId": world.project_id, "approvalMode": "auto"}),
        )
        .await;
    assert_eq!(status, 409);
    assert!(body["error"].as_str().unwrap().contains("limit"));

    // Archiving frees a slot.
    let (_, agents) = world.get("/api/agents").await;
    let first_id = agents[0]["id"].as_str().unwrap();
    world
        .http
        .delete(format!("{}/api/agents/{first_id}", world.base_url))
        .send()
        .await
        .unwrap();
    let (status, _) = world
        .post(
            "/api/agents",
            json!({"name": "three", "projectId": world.project_id, "approvalMode": "auto"}),
        )
        .await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn diff_reports_tracked_and_untracked_changes() {
    let world = world().await;
    let agent = world.create_agent("differ", true, "always_ask").await;
    let agent_id = agent["id"].as_str().unwrap();
    let worktree_path = PathBuf::from(agent["worktree"]["path"].as_str().unwrap());
    tokio::fs::write(worktree_path.join("README.md"), "# demo\nchanged\n")
        .await
        .unwrap();
    tokio::fs::write(worktree_path.join("new.py"), "print('hi')\n")
        .await
        .unwrap();

    let (status, diff) = world.get(&format!("/api/agents/{agent_id}/diff")).await;
    assert_eq!(status, 200);
    assert!(diff["diff"].as_str().unwrap().contains("+changed"));
    assert!(diff["untrackedDiff"].as_str().unwrap().contains("print('hi')"));
    assert!(diff["status"].as_str().unwrap().contains("new.py"));
}

#[tokio::test]
async fn diff_without_worktree_is_400() {
    let world = world().await;
    let agent = world.create_agent("bare", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let (status, _) = world.get(&format!("/api/agents/{agent_id}/diff")).await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn unknown_agent_is_404_everywhere() {
    let world = world().await;
    for path in [
        "/api/agents/ghost",
        "/api/agents/ghost/diff",
        "/api/agents/ghost/approvals",
        "/api/agents/ghost/sessions/main/transcript",
    ] {
        let (status, _) = world.get(path).await;
        assert_eq!(status, 404, "{path}");
    }
    let (status, _) = world.post("/api/agents/ghost/cancel", json!({})).await;
    assert_eq!(status, 404);
    let (status, _) = world
        .post("/api/agents/ghost/sessions/main/prompt", json!({"text": "x"}))
        .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn unknown_session_is_404() {
    let world = world().await;
    let agent = world.create_agent("solo", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let (status, _) = world
        .post(
            &format!("/api/agents/{agent_id}/sessions/ghost/prompt"),
            json!({"text": "x"}),
        )
        .await;
    assert_eq!(status, 404);
    let (status, _) = world
        .get(&format!("/api/agents/{agent_id}/sessions/ghost/transcript"))
        .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn an_agent_created_under_stub_reports_is_stub() {
    let world = world().await;
    let agent = world.create_agent("solo", false, "auto").await;
    assert_eq!(agent["isStub"], true);
}

#[tokio::test]
async fn an_agent_created_under_a_real_agent_cmd_does_not_report_is_stub() {
    let world = world_with(50, vec!["/nonexistent/agent".to_owned()]).await;
    let (status, agent) = world
        .post(
            "/api/agents",
            json!({"name": "doomed", "projectId": world.project_id, "useWorktree": false, "approvalMode": "auto"}),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(agent["isStub"], false);
}

#[tokio::test]
async fn is_stub_reflects_each_agents_own_frozen_command_across_a_restart_with_a_different_one() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    init_repo(&repo).await;
    let config = ManagerConfig {
        repo_root: repo.clone(),
        worktrees_dir: dir.path().join("worktrees"),
        data_dir: dir.path().join("data"),
        agent_command: vec![STUB_AGENT.to_owned()],
        max_agents: 50,
        github_api_base_url: "https://api.github.com".to_owned(),
    };

    let agent_id = {
        let manager = AgentManager::new(config.clone()).await.unwrap();
        let project_id = manager.list_projects().await[0].id.clone();
        let agent = manager
            .create_agent(clai2_web_server::manager::CreateAgent {
                name: "stub-born".to_owned(),
                project_id,
                use_worktree: false,
                base_branch: None,
                approval_mode: clai2_web_server::model::ApprovalMode::Auto,
                model_profile_id: None,
                initial_prompt: None,
            })
            .await
            .unwrap();
        assert!(agent.is_stub);
        agent.id
    };

    // Restart with a different (non-stub) agent_command; the already-created agent keeps
    // reporting is_stub from its own frozen command, not the manager's new one.
    let mut real_config = config;
    real_config.agent_command = vec!["/nonexistent/agent".to_owned()];
    let manager = AgentManager::new(real_config).await.unwrap();
    let agents = manager.snapshot().await;
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].id, agent_id);
    assert!(agents[0].is_stub);
}

#[tokio::test]
async fn broken_agent_command_reports_error_status() {
    let world = world_with(50, vec!["/nonexistent/agent".to_owned()]).await;
    let (status, agent) = world
        .post(
            "/api/agents",
            json!({"name": "doomed", "projectId": world.project_id, "useWorktree": false, "approvalMode": "auto"}),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(agent["status"], "error");
    assert!(agent["lastError"].as_str().unwrap().contains("spawn"));
}

#[tokio::test]
async fn scripted_agent_failure_marks_agent_errored_then_recovers() {
    let world = world().await;
    let agent = world.create_agent("flaky", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "fail").await;
    let events = ws.collect_until(|event| event["type"] == "agentError").await;
    let error = events_of_type(&events, "agentError");
    assert!(error[0]["message"].as_str().unwrap().contains("scripted failure"));
    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert_eq!(fetched["status"], "error");

    // The next prompt clears the error and works.
    world.prompt(agent_id, "main", "hello again").await;
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    ws.close().await;
    let chunks = events_of_type(&events, "messageChunk");
    assert!(chunks.iter().any(|chunk| chunk["text"] == "echo: hello again"));
}

#[tokio::test]
async fn roster_survives_backend_restart_with_history_replay() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    init_repo(&repo).await;
    let config = ManagerConfig {
        repo_root: repo.clone(),
        worktrees_dir: dir.path().join("worktrees"),
        data_dir: dir.path().join("data"),
        agent_command: vec![STUB_AGENT.to_owned()],
        max_agents: 50,
        github_api_base_url: "https://api.github.com".to_owned(),
    };

    let agent_id = {
        let manager = AgentManager::new(config.clone()).await.unwrap();
        let project_id = manager.list_projects().await[0].id.clone();
        let agent = manager
            .create_agent(clai2_web_server::manager::CreateAgent {
                name: "survivor".to_owned(),
                project_id,
                use_worktree: false,
                base_branch: None,
                approval_mode: clai2_web_server::model::ApprovalMode::Auto,
                model_profile_id: None,
                initial_prompt: None,
            })
            .await
            .unwrap();
        manager
            .prompt(&agent.id, "main", "first life".to_owned())
            .await
            .unwrap();
        let mut receiver = manager.hub().subscribe();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(30), receiver.recv())
                .await
                .unwrap()
                .unwrap();
            if matches!(event, clai2_web_server::events::Event::TurnEnded { .. }) {
                break;
            }
        }
        agent.id
    };

    let manager = AgentManager::new(config).await.unwrap();
    let agents = manager.snapshot().await;
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].id, agent_id);
    assert_eq!(agents[0].name, "survivor");
    assert!(agents[0].sessions[0].acp_session_id.is_none());

    // A prompt after restart replays history to the fresh process.
    let mut receiver = manager.hub().subscribe();
    manager
        .prompt(&agent_id, "main", "second life".to_owned())
        .await
        .unwrap();
    let mut echo = String::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(30), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        match event {
            clai2_web_server::events::Event::MessageChunk { text, .. } => echo.push_str(&text),
            clai2_web_server::events::Event::TurnEnded { .. } => break,
            _ => {}
        }
    }
    assert!(echo.contains("first life"), "echo: {echo}");
    assert!(echo.contains("second life"), "echo: {echo}");
}

#[tokio::test]
async fn ws_snapshot_includes_existing_agents_and_approvals() {
    let world = world().await;
    let agent = world.create_agent("existing", false, "always_ask").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "approve:execute thing").await;
    ws.collect_until(|event| event["type"] == "approvalRequested").await;
    ws.close().await;

    // A late subscriber sees the parked approval in its snapshot.
    let (stream, _) = tokio_tungstenite::connect_async(&world.ws_url).await.unwrap();
    let mut late = Ws { stream };
    let snapshot = late.next_event().await;
    assert_eq!(snapshot["type"], "snapshot");
    assert_eq!(snapshot["agents"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["approvals"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["agents"][0]["status"], "waiting_approval");
    late.close().await;
}

#[tokio::test]
async fn explicit_bad_base_branch_reports_git_error() {
    let world = world().await;
    let (status, body) = world
        .post(
            "/api/agents",
            json!({"name": "branchy", "projectId": world.project_id, "useWorktree": true, "baseBranch": "no-such-branch", "approvalMode": "auto"}),
        )
        .await;
    // A git failure maps to 500 through the error responder.
    assert_eq!(status, 500, "body: {body}");
    assert!(body["error"].is_string());
}

#[tokio::test]
async fn create_with_explicit_base_branch_uses_it() {
    let world = world().await;
    let (status, agent) = world
        .post(
            "/api/agents",
            json!({"name": "based", "projectId": world.project_id, "useWorktree": true, "baseBranch": "main", "approvalMode": "auto"}),
        )
        .await;
    assert_eq!(status, 200, "body: {agent}");
    assert_eq!(agent["worktree"]["baseBranch"], "main");
}

#[tokio::test]
async fn side_session_on_archived_agent_is_400() {
    let world = world().await;
    let agent = world.create_agent("gone", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    world
        .http
        .delete(format!("{}/api/agents/{agent_id}", world.base_url))
        .send()
        .await
        .unwrap();
    let (status, _) = world
        .post(&format!("/api/agents/{agent_id}/sessions"), json!({"label": "late"}))
        .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn fork_at_capacity_is_409() {
    let world = world_with(1, vec![STUB_AGENT.to_owned()]).await;
    let agent = world.create_agent("only", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let (status, body) = world
        .post(&format!("/api/agents/{agent_id}/fork"), json!({"name": "clone"}))
        .await;
    assert_eq!(status, 409);
    assert!(body["error"].as_str().unwrap().contains("limit"));
}

#[tokio::test]
async fn fork_rejects_blank_name() {
    let world = world().await;
    let agent = world.create_agent("parent", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let (status, _) = world
        .post(&format!("/api/agents/{agent_id}/fork"), json!({"name": "  "}))
        .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn fork_without_worktree_copies_transcript_only() {
    let world = world().await;
    let agent = world.create_agent("bare parent", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "hello").await;
    ws.collect_until(|event| event["type"] == "turnEnded").await;
    ws.close().await;

    let (status, fork) = world
        .post(&format!("/api/agents/{agent_id}/fork"), json!({"name": "bare fork"}))
        .await;
    assert_eq!(status, 200, "fork failed: {fork}");
    assert!(fork["worktree"].is_null());
    assert_eq!(fork["cwd"].as_str().unwrap(), world.repo.to_str().unwrap());
    let fork_id = fork["id"].as_str().unwrap();
    let (_, transcript) = world
        .get(&format!("/api/agents/{fork_id}/sessions/main/transcript"))
        .await;
    assert!(transcript
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["text"] == "hello"));
}

#[tokio::test]
async fn set_approval_mode_on_unknown_agent_is_404() {
    let world = world().await;
    let response = world
        .http
        .patch(format!("{}/api/agents/ghost/approval-mode", world.base_url))
        .json(&json!({"approvalMode": "auto"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn archiving_agent_with_parked_approval_resolves_it() {
    let world = world().await;
    let agent = world.create_agent("parker", false, "always_ask").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "approve:execute risky").await;
    ws.collect_until(|event| event["type"] == "approvalRequested").await;
    ws.close().await;

    let response = world
        .http
        .delete(format!("{}/api/agents/{agent_id}", world.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let (_, pending) = world.get("/api/approvals").await;
    assert!(pending.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn archive_and_cancel_tolerate_a_process_that_never_started() {
    let world = world_with(50, vec!["/nonexistent/agent".to_owned()]).await;
    let (status, agent) = world
        .post(
            "/api/agents",
            json!({"name": "stillborn", "projectId": world.project_id, "useWorktree": false, "approvalMode": "auto"}),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(agent["status"], "error");
    let agent_id = agent["id"].as_str().unwrap();

    // Cancelling an agent that has no live process is a no-op success.
    let (status, _) = world.post(&format!("/api/agents/{agent_id}/cancel"), json!({})).await;
    assert_eq!(status, 200);

    // Archiving it takes no client to kill and removes no worktree.
    let response = world
        .http
        .delete(format!("{}/api/agents/{agent_id}", world.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let archived: Value = response.json().await.unwrap();
    assert_eq!(archived["status"], "archived");
}

#[tokio::test]
async fn plan_updates_stream_to_clients() {
    let world = world().await;
    let agent = world.create_agent("planner", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "emit-plan").await;
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    ws.close().await;
    let plans = events_of_type(&events, "plan");
    assert_eq!(plans[0]["entries"][0]["content"], "step one");
    assert_eq!(plans[0]["entries"][0]["priority"], "high");
}

#[tokio::test]
async fn passive_update_variants_do_not_break_the_turn() {
    let world = world().await;
    let agent = world.create_agent("passive", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "emit-extras").await;
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    ws.close().await;
    let ended = events_of_type(&events, "turnEnded");
    assert_eq!(ended[0]["stopReason"], "end_turn");
}

#[tokio::test]
async fn tool_call_update_without_prior_announcement_materializes_view() {
    let world = world().await;
    let agent = world.create_agent("patcher", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "bare-update").await;
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    ws.close().await;
    let calls = events_of_type(&events, "toolCall");
    assert!(calls
        .iter()
        .any(|call| call["toolCall"]["toolCallId"] == "bare-1" && call["toolCall"]["status"] == "completed"));
}

#[tokio::test]
async fn unexpected_process_exit_marks_agent_errored() {
    let world = world().await;
    let agent = world.create_agent("crasher", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "crash").await;
    let events = ws
        .collect_until(|event| {
            event["type"] == "agentError"
                && event["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("exited unexpectedly"))
        })
        .await;
    ws.close().await;
    assert!(!events.is_empty());
    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert_eq!(fetched["status"], "error");
}

#[tokio::test]
async fn archiving_during_a_running_turn_settles_cleanly() {
    let world = world().await;
    let agent = world.create_agent("busy", false, "always_ask").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "slow").await;
    ws.collect_until(|event| event["type"] == "messageChunk").await;
    let response = world
        .http
        .delete(format!("{}/api/agents/{agent_id}", world.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    // The in-flight turn task runs to completion against the archived agent.
    ws.collect_until(|event| event["type"] == "agentError").await;
    ws.close().await;
    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert_eq!(fetched["status"], "archived");
}

#[tokio::test]
async fn auto_approval_tolerates_a_dead_agent() {
    let world = world().await;
    let agent = world.create_agent("autodead", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;
    // The agent requests permission, then exits; the auto-approval response has
    // nowhere to go, which the manager logs and swallows.
    world.prompt(agent_id, "main", "perm-then-exit").await;
    ws.collect_until(|event| event["type"] == "agentError").await;
    ws.close().await;
    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert_eq!(fetched["status"], "error");
}

#[tokio::test]
async fn resolving_approval_for_a_dead_agent_is_tolerated() {
    let world = world().await;
    let agent = world.create_agent("parkdead", false, "always_ask").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "perm-then-exit").await;
    // The approval parks, then the agent process exits.
    let events = ws.collect_until(|event| event["type"] == "approvalRequested").await;
    let approval_id = events.last().unwrap()["approval"]["id"].as_str().unwrap().to_owned();
    ws.collect_until(|event| event["type"] == "agentError").await;
    ws.close().await;
    // Resolving now sends the answer to a dead connection; the manager logs the
    // failure and still reports the resolution succeeded.
    let (status, _) = world
        .post(
            &format!("/api/approvals/{approval_id}"),
            json!({"optionId": "allow_once"}),
        )
        .await;
    assert_eq!(status, 200);
    // A follow-up request yields the runtime so the parked responder task runs.
    let (_, pending) = world.get("/api/approvals").await;
    assert!(pending.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn websocket_closes_when_client_sends_close() {
    let world = world().await;
    let (stream, _) = tokio_tungstenite::connect_async(&world.ws_url).await.unwrap();
    let mut ws = Ws { stream };
    let snapshot = ws.next_event().await;
    assert_eq!(snapshot["type"], "snapshot");
    // A non-close message from the client is ignored by the server loop.
    ws.stream.send(Message::Text("ignored by server".into())).await.unwrap();
    // Sending a Close makes the server break out of its loop and drop the
    // socket, which the client observes as the stream ending.
    ws.stream.send(Message::Close(None)).await.unwrap();
    while let Some(message) = ws.stream.next().await {
        if message.is_err() {
            break;
        }
    }
}

#[tokio::test]
async fn fifty_agents_can_run_concurrently() {
    let world = world().await;
    let mut agent_ids = Vec::new();
    for index in 0..50 {
        let agent = world.create_agent(&format!("agent {index}"), false, "auto").await;
        agent_ids.push(agent["id"].as_str().unwrap().to_owned());
    }
    let (_, agents) = world.get("/api/agents").await;
    assert_eq!(agents.as_array().unwrap().len(), 50);

    let mut ws = world.ws().await;
    for agent_id in &agent_ids {
        world.prompt(agent_id, "main", "ping").await;
    }
    let mut ended = std::collections::HashSet::new();
    while ended.len() < 50 {
        let event = ws.next_event().await;
        if event["type"] == "turnEnded" {
            ended.insert(event["agentId"].as_str().unwrap().to_owned());
        }
    }
    ws.close().await;
}

#[tokio::test]
async fn default_project_is_bootstrapped_from_repo() {
    let world = world().await;
    let (status, projects) = world.get("/api/projects").await;
    assert_eq!(status, 200);
    let projects = projects.as_array().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0]["id"], world.project_id);
    assert_eq!(projects[0]["repoRoot"], world.repo.to_str().unwrap());

    let agent = world.create_agent("solo", false, "auto").await;
    assert_eq!(agent["projectId"], world.project_id);
}

#[tokio::test]
async fn registering_a_project_lets_agents_run_in_another_repo() {
    let world = world().await;
    let other_dir = tempfile::tempdir().unwrap();
    let other_repo = other_dir.path().join("other-repo");
    init_repo(&other_repo).await;

    let (status, project) = world
        .post(
            "/api/projects",
            json!({"name": "other project", "path": other_repo.to_str().unwrap()}),
        )
        .await;
    assert_eq!(status, 200, "body: {project}");
    assert_eq!(project["name"], "other project");
    let other_project_id = project["id"].as_str().unwrap().to_owned();

    let (_, projects) = world.get("/api/projects").await;
    assert_eq!(projects.as_array().unwrap().len(), 2);

    let (status, agent) = world
        .post(
            "/api/agents",
            json!({"name": "elsewhere", "projectId": other_project_id, "useWorktree": true, "approvalMode": "auto"}),
        )
        .await;
    assert_eq!(status, 200, "body: {agent}");
    assert_eq!(agent["projectId"], other_project_id);
    assert_eq!(agent["worktree"]["repoRoot"], other_repo.to_str().unwrap());
    let worktree_path = agent["worktree"]["path"].as_str().unwrap();
    assert!(Path::new(worktree_path).join("README.md").exists());
}

#[tokio::test]
async fn create_project_rejects_nonexistent_path() {
    let world = world().await;
    let (status, body) = world
        .post(
            "/api/projects",
            json!({"name": "ghost", "path": "/no/such/path/at/all"}),
        )
        .await;
    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().contains("does not exist"));
}

#[tokio::test]
async fn create_project_rejects_relative_path() {
    let world = world().await;
    let (status, body) = world
        .post("/api/projects", json!({"name": "rel", "path": "relative/path"}))
        .await;
    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().contains("absolute"));
}

#[tokio::test]
async fn create_project_rejects_blank_name() {
    let world = world().await;
    let (status, body) = world
        .post(
            "/api/projects",
            json!({"name": "  ", "path": world.repo.to_str().unwrap()}),
        )
        .await;
    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().contains("name"));
}

#[tokio::test]
async fn create_agent_with_unknown_project_is_404() {
    let world = world().await;
    let (status, _) = world
        .post(
            "/api/agents",
            json!({"name": "orphan", "projectId": "ghost-project", "approvalMode": "auto"}),
        )
        .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn deleting_a_project_in_use_is_conflict() {
    let world = world().await;
    world.create_agent("keeps project alive", false, "auto").await;
    let (status, body) = {
        let response = world
            .http
            .delete(format!("{}/api/projects/{}", world.base_url, world.project_id))
            .send()
            .await
            .unwrap();
        let status = response.status();
        (status, response.json::<Value>().await.unwrap())
    };
    assert_eq!(status, 409, "body: {body}");
}

#[tokio::test]
async fn deleting_an_unused_project_succeeds() {
    let world = world().await;
    let other_dir = tempfile::tempdir().unwrap();
    let other_repo = other_dir.path().join("other-repo");
    init_repo(&other_repo).await;
    let (_, project) = world
        .post(
            "/api/projects",
            json!({"name": "temp", "path": other_repo.to_str().unwrap()}),
        )
        .await;
    let project_id = project["id"].as_str().unwrap();

    let response = world
        .http
        .delete(format!("{}/api/projects/{project_id}", world.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let (_, projects) = world.get("/api/projects").await;
    assert_eq!(projects.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn deleting_an_unknown_project_is_404() {
    let world = world().await;
    let response = world
        .http
        .delete(format!("{}/api/projects/ghost", world.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn fork_stays_in_the_parents_project() {
    let world = world().await;
    let agent = world.create_agent("parent", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let (status, fork) = world
        .post(&format!("/api/agents/{agent_id}/fork"), json!({"name": "child"}))
        .await;
    assert_eq!(status, 200, "body: {fork}");
    assert_eq!(fork["projectId"], world.project_id);
}

#[tokio::test]
async fn ws_snapshot_includes_projects() {
    let world = world().await;
    let (stream, _) = tokio_tungstenite::connect_async(&world.ws_url).await.unwrap();
    let mut ws = Ws { stream };
    let snapshot = ws.next_event().await;
    let projects = snapshot["projects"].as_array().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0]["id"], world.project_id);
    ws.close().await;
}

#[tokio::test]
async fn creating_and_listing_a_folder() {
    let world = world().await;
    let (status, folders) = world.get("/api/folders").await;
    assert_eq!(status, 200);
    assert_eq!(folders.as_array().unwrap().len(), 0);

    let (status, folder) = world.post("/api/folders", json!({"name": "backend work"})).await;
    assert_eq!(status, 200, "body: {folder}");
    assert_eq!(folder["name"], "backend work");
    assert!(folder["id"].as_str().is_some());

    let (_, folders) = world.get("/api/folders").await;
    assert_eq!(folders.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn create_folder_rejects_blank_name() {
    let world = world().await;
    let (status, body) = world.post("/api/folders", json!({"name": "  "})).await;
    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().contains("name"));
}

#[tokio::test]
async fn setting_and_clearing_an_agents_folder_round_trips() {
    let world = world().await;
    let agent = world.create_agent("filer", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    assert!(agent["folderId"].is_null());

    let (_, folder) = world.post("/api/folders", json!({"name": "review"})).await;
    let folder_id = folder["id"].as_str().unwrap();

    let (status, updated) = world
        .patch(
            &format!("/api/agents/{agent_id}/folder"),
            json!({"folderId": folder_id}),
        )
        .await;
    assert_eq!(status, 200, "body: {updated}");
    assert_eq!(updated["folderId"], folder_id);

    let (status, cleared) = world
        .patch(&format!("/api/agents/{agent_id}/folder"), json!({"folderId": null}))
        .await;
    assert_eq!(status, 200, "body: {cleared}");
    assert!(cleared["folderId"].is_null());
}

#[tokio::test]
async fn setting_an_agents_folder_to_an_unknown_folder_is_404() {
    let world = world().await;
    let agent = world.create_agent("filer", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let (status, _) = world
        .patch(&format!("/api/agents/{agent_id}/folder"), json!({"folderId": "ghost"}))
        .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn setting_the_folder_of_an_unknown_agent_is_404() {
    let world = world().await;
    let (status, _) = world.patch("/api/agents/ghost/folder", json!({"folderId": null})).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn deleting_a_folder_unfiles_its_agents_instead_of_blocking() {
    let world = world().await;
    let (_, folder) = world.post("/api/folders", json!({"name": "temp"})).await;
    let folder_id = folder["id"].as_str().unwrap().to_owned();
    let agent = world.create_agent("filed", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    world
        .patch(
            &format!("/api/agents/{agent_id}/folder"),
            json!({"folderId": folder_id}),
        )
        .await;

    let response = world
        .http
        .delete(format!("{}/api/folders/{folder_id}", world.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);

    let (_, folders) = world.get("/api/folders").await;
    assert_eq!(folders.as_array().unwrap().len(), 0);
    let (_, agent) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert!(agent["folderId"].is_null());
}

#[tokio::test]
async fn deleting_an_unknown_folder_is_404() {
    let world = world().await;
    let response = world
        .http
        .delete(format!("{}/api/folders/ghost", world.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn forking_stays_in_the_parents_folder() {
    let world = world().await;
    let agent = world.create_agent("parent", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let (_, folder) = world.post("/api/folders", json!({"name": "team"})).await;
    let folder_id = folder["id"].as_str().unwrap();
    world
        .patch(
            &format!("/api/agents/{agent_id}/folder"),
            json!({"folderId": folder_id}),
        )
        .await;

    let (status, fork) = world
        .post(&format!("/api/agents/{agent_id}/fork"), json!({"name": "child"}))
        .await;
    assert_eq!(status, 200, "body: {fork}");
    assert_eq!(fork["folderId"], folder_id);
}

#[tokio::test]
async fn ws_snapshot_includes_folders() {
    let world = world().await;
    world.post("/api/folders", json!({"name": "backend work"})).await;
    let (stream, _) = tokio_tungstenite::connect_async(&world.ws_url).await.unwrap();
    let mut ws = Ws { stream };
    let snapshot = ws.next_event().await;
    let folders = snapshot["folders"].as_array().unwrap();
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0]["name"], "backend work");
    ws.close().await;
}

#[tokio::test]
async fn ws_snapshot_reports_the_configured_max_agents() {
    let world = world_with(7, vec![STUB_AGENT.to_owned()]).await;
    let (stream, _) = tokio_tungstenite::connect_async(&world.ws_url).await.unwrap();
    let mut ws = Ws { stream };
    let snapshot = ws.next_event().await;
    assert_eq!(snapshot["maxAgents"], 7);
    ws.close().await;
}

#[tokio::test]
async fn renaming_an_agent_updates_its_summary() {
    let world = world().await;
    let agent = world.create_agent("old name", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let mut ws = world.ws().await;

    let response = world
        .http
        .patch(format!("{}/api/agents/{agent_id}/name", world.base_url))
        .json(&json!({"name": "new name"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let renamed: Value = response.json().await.unwrap();
    assert_eq!(renamed["name"], "new name");

    let event = ws.collect_until(|event| event["type"] == "agentUpdated").await;
    assert_eq!(event.last().unwrap()["agent"]["name"], "new name");
    ws.close().await;

    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert_eq!(fetched["name"], "new name");
}

#[tokio::test]
async fn renaming_rejects_blank_name() {
    let world = world().await;
    let agent = world.create_agent("keeper", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let response = world
        .http
        .patch(format!("{}/api/agents/{agent_id}/name", world.base_url))
        .json(&json!({"name": "   "}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn renaming_unknown_agent_is_404() {
    let world = world().await;
    let response = world
        .http
        .patch(format!("{}/api/agents/ghost/name", world.base_url))
        .json(&json!({"name": "x"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn model_profiles_crud_and_secret_redaction() {
    let world = world().await;
    assert!(world.get("/api/models").await.1.as_array().unwrap().is_empty());

    let (status, created) = world
        .post(
            "/api/models",
            json!({
                "label": "Vertex Gemini",
                "provider": "google_vertex",
                "model": "gemini-2.5-pro",
                "projectId": "my-project",
                "region": "us-central1",
                "credentialsJson": "{\"type\":\"service_account\"}",
                "extraEnv": [{"name": "TOKEN", "value": "shh", "secret": true}]
            }),
        )
        .await;
    assert_eq!(status, 200, "create model failed: {created}");
    let model_id = created["id"].as_str().unwrap().to_owned();
    // Secrets are never echoed back; presence is flagged instead.
    assert_eq!(created["hasCredentials"], true);
    assert_eq!(created["projectId"], "my-project");
    assert!(created.get("credentialsJson").is_none());
    assert_eq!(created["extraEnv"][0]["value"], Value::Null);
    assert_eq!(created["extraEnv"][0]["secret"], true);

    // Editing without resending the secret keeps it.
    let (status, updated) = world
        .patch(
            &format!("/api/models/{model_id}"),
            json!({
                "label": "Vertex Gemini Flash",
                "provider": "google_vertex",
                "model": "gemini-2.5-flash",
                "projectId": "my-project",
                "region": "us-central1",
                "extraEnv": [{"name": "TOKEN", "secret": true}]
            }),
        )
        .await;
    assert_eq!(status, 200, "update model failed: {updated}");
    assert_eq!(updated["label"], "Vertex Gemini Flash");
    assert_eq!(updated["model"], "gemini-2.5-flash");
    assert_eq!(updated["hasCredentials"], true);

    // Validation: blank label is rejected.
    let (status, _) = world
        .post(
            "/api/models",
            json!({"label": "", "provider": "openai", "model": "gpt"}),
        )
        .await;
    assert_eq!(status, 400);

    let (status, _) = world
        .patch(
            "/api/models/nope",
            json!({"label": "x", "provider": "openai", "model": "gpt"}),
        )
        .await;
    assert_eq!(status, 404);

    assert_eq!(world.delete("/api/models/nope").await, reqwest::StatusCode::NOT_FOUND);
    assert_eq!(
        world.delete(&format!("/api/models/{model_id}")).await,
        reqwest::StatusCode::OK
    );
    assert!(world.get("/api/models").await.1.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn agent_runs_with_its_model_profile_environment() {
    let world = world().await;
    let (_, model) = world
        .post(
            "/api/models",
            json!({
                "label": "Anthropic",
                "provider": "anthropic",
                "model": "claude-sonnet-4-6",
                "apiKey": "sk-test-123"
            }),
        )
        .await;
    let model_id = model["id"].as_str().unwrap().to_owned();

    let (status, agent) = world
        .post(
            "/api/agents",
            json!({"name": "modelled", "useWorktree": false, "projectId": world.project_id, "approvalMode": "auto", "modelProfileId": model_id}),
        )
        .await;
    assert_eq!(status, 200, "create agent failed: {agent}");
    assert_eq!(agent["modelProfileId"], model_id);
    assert_eq!(agent["modelLabel"], "Anthropic");
    let agent_id = agent["id"].as_str().unwrap().to_owned();

    // The stub echoes an env var, proving the profile's environment reached
    // the process: CLAI_MODEL is provider-qualified, and the API key is set.
    let mut ws = world.ws().await;
    world.prompt(&agent_id, "main", "env:CLAI_MODEL").await;
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    let chunks = events_of_type(&events, "messageChunk");
    assert!(
        chunks
            .iter()
            .any(|chunk| chunk["text"] == "env CLAI_MODEL=anthropic:claude-sonnet-4-6"),
        "chunks: {chunks:?}"
    );

    world.prompt(&agent_id, "main", "env:ANTHROPIC_API_KEY").await;
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    let chunks = events_of_type(&events, "messageChunk");
    assert!(chunks
        .iter()
        .any(|chunk| chunk["text"] == "env ANTHROPIC_API_KEY=sk-test-123"));
    ws.close().await;
}

#[tokio::test]
async fn creating_agent_with_unknown_model_is_404() {
    let world = world().await;
    let (status, _) = world
        .post(
            "/api/agents",
            json!({"name": "bad", "useWorktree": false, "projectId": world.project_id, "approvalMode": "auto", "modelProfileId": "ghost"}),
        )
        .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn switching_model_restarts_with_new_environment() {
    let world = world().await;
    let (_, first_model) = world
        .post(
            "/api/models",
            json!({"label": "GPT six", "provider": "openai", "model": "gpt-6", "apiKey": "k"}),
        )
        .await;
    let first = first_model["id"].as_str().unwrap().to_owned();
    let (_, second_model) = world
        .post(
            "/api/models",
            json!({"label": "GPT mini", "provider": "openai", "model": "gpt-6-mini", "apiKey": "k"}),
        )
        .await;
    let second = second_model["id"].as_str().unwrap().to_owned();

    let (_, agent) = world
        .post(
            "/api/agents",
            json!({"name": "switcher", "useWorktree": false, "projectId": world.project_id, "approvalMode": "auto", "modelProfileId": first}),
        )
        .await;
    let agent_id = agent["id"].as_str().unwrap().to_owned();

    // Establish history with a plain prompt (no stub directive, so it replays
    // cleanly). The pre-switch environment is covered by another test.
    let mut ws = world.ws().await;
    world.prompt(&agent_id, "main", "remember the teal sky").await;
    ws.collect_until(|event| event["type"] == "turnEnded").await;

    // Switch the model; the agent keeps its identity and label updates.
    let (status, updated) = world
        .patch(
            &format!("/api/agents/{agent_id}/model"),
            json!({"modelProfileId": second}),
        )
        .await;
    assert_eq!(status, 200, "switch failed: {updated}");
    assert_eq!(updated["modelLabel"], "GPT mini");

    // The next prompt runs on a fresh process and replays the history
    // preamble (a normal prompt echoes the full wire text).
    world.prompt(&agent_id, "main", "continue").await;
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    let echo: String = events_of_type(&events, "messageChunk")
        .iter()
        .map(|chunk| chunk["text"].as_str().unwrap().to_owned())
        .collect();
    assert!(echo.contains("<conversation-history>"), "echo: {echo}");
    assert!(echo.contains("User: remember the teal sky"), "echo: {echo}");

    // The new provider environment is in effect on the fresh process.
    world.prompt(&agent_id, "main", "env:CLAI_MODEL").await;
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    assert!(events_of_type(&events, "messageChunk")
        .iter()
        .any(|chunk| chunk["text"] == "env CLAI_MODEL=openai:gpt-6-mini"));
    ws.close().await;
}

#[tokio::test]
async fn model_in_use_cannot_be_deleted_until_agent_archived() {
    let world = world().await;
    let (_, model) = world
        .post(
            "/api/models",
            json!({"label": "M", "provider": "openai", "model": "gpt-6"}),
        )
        .await;
    let model_id = model["id"].as_str().unwrap().to_owned();
    let (_, agent) = world
        .post(
            "/api/agents",
            json!({"name": "user", "useWorktree": false, "projectId": world.project_id, "approvalMode": "auto", "modelProfileId": model_id}),
        )
        .await;
    let agent_id = agent["id"].as_str().unwrap().to_owned();

    assert_eq!(
        world.delete(&format!("/api/models/{model_id}")).await,
        reqwest::StatusCode::CONFLICT
    );

    world
        .http
        .delete(format!("{}/api/agents/{agent_id}", world.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(
        world.delete(&format!("/api/models/{model_id}")).await,
        reqwest::StatusCode::OK
    );
}

#[tokio::test]
async fn updating_a_model_refreshes_the_label_on_its_agents() {
    let world = world().await;
    let (_, model) = world
        .post(
            "/api/models",
            json!({"label": "Old", "provider": "openai", "model": "gpt-6"}),
        )
        .await;
    let model_id = model["id"].as_str().unwrap().to_owned();
    let (_, agent) = world
        .post(
            "/api/agents",
            json!({"name": "labelled", "useWorktree": false, "projectId": world.project_id, "approvalMode": "auto", "modelProfileId": model_id}),
        )
        .await;
    let agent_id = agent["id"].as_str().unwrap().to_owned();

    world
        .patch(
            &format!("/api/models/{model_id}"),
            json!({"label": "New", "provider": "openai", "model": "gpt-6"}),
        )
        .await;
    let (_, fetched) = world.get(&format!("/api/agents/{agent_id}")).await;
    assert_eq!(fetched["modelLabel"], "New");
}

#[tokio::test]
async fn agent_with_vertex_credentials_gets_a_credentials_file() {
    let world = world().await;
    let (_, model) = world
        .post(
            "/api/models",
            json!({
                "label": "Vertex",
                "provider": "google_vertex",
                "model": "gemini-2.5-pro",
                "projectId": "proj",
                "region": "us-central1",
                "credentialsJson": "{\"type\":\"service_account\"}"
            }),
        )
        .await;
    let model_id = model["id"].as_str().unwrap().to_owned();
    let (status, agent) = world
        .post(
            "/api/agents",
            json!({"name": "vertexed", "useWorktree": false, "projectId": world.project_id, "approvalMode": "auto", "modelProfileId": model_id}),
        )
        .await;
    assert_eq!(status, 200, "create agent failed: {agent}");
    let agent_id = agent["id"].as_str().unwrap().to_owned();

    // Spawning the agent writes the service-account JSON to a file and points
    // GOOGLE_APPLICATION_CREDENTIALS at it. The stub echoes the value back.
    let mut ws = world.ws().await;
    world
        .prompt(&agent_id, "main", "env:GOOGLE_APPLICATION_CREDENTIALS")
        .await;
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    let path = events_of_type(&events, "messageChunk")
        .iter()
        .find_map(|chunk| {
            chunk["text"]
                .as_str()
                .and_then(|text| text.strip_prefix("env GOOGLE_APPLICATION_CREDENTIALS="))
                .map(str::to_owned)
        })
        .expect("credentials env var echoed");
    assert!(!path.is_empty(), "credentials path should be non-empty");
    assert!(Path::new(&path).exists(), "credentials file should exist: {path}");
    ws.close().await;
}

#[tokio::test]
async fn setting_model_on_a_busy_agent_is_409() {
    let world = world().await;
    let (_, model) = world
        .post(
            "/api/models",
            json!({"label": "M", "provider": "openai", "model": "gpt-6"}),
        )
        .await;
    let model_id = model["id"].as_str().unwrap().to_owned();
    let agent = world.create_agent("busy", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap().to_owned();

    let mut ws = world.ws().await;
    world.prompt(&agent_id, "main", "slow").await;
    ws.collect_until(|event| event["type"] == "messageChunk").await;
    let (status, _) = world
        .patch(
            &format!("/api/agents/{agent_id}/model"),
            json!({"modelProfileId": model_id}),
        )
        .await;
    assert_eq!(status, 409);

    // Release the held turn so the world tears down cleanly.
    world.post(&format!("/api/agents/{agent_id}/cancel"), json!({})).await;
    ws.collect_until(|event| event["type"] == "turnEnded").await;
    ws.close().await;
}

#[tokio::test]
async fn setting_model_on_an_archived_agent_is_400() {
    let world = world().await;
    let (_, model) = world
        .post(
            "/api/models",
            json!({"label": "M", "provider": "openai", "model": "gpt-6"}),
        )
        .await;
    let model_id = model["id"].as_str().unwrap().to_owned();
    let agent = world.create_agent("gone", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap().to_owned();
    world
        .http
        .delete(format!("{}/api/agents/{agent_id}", world.base_url))
        .send()
        .await
        .unwrap();

    let (status, _) = world
        .patch(
            &format!("/api/agents/{agent_id}/model"),
            json!({"modelProfileId": model_id}),
        )
        .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn setting_model_on_an_unknown_agent_is_404() {
    let world = world().await;
    let (status, _) = world
        .patch("/api/agents/ghost/model", json!({"modelProfileId": null}))
        .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn setting_model_to_an_unknown_model_is_404() {
    let world = world().await;
    let agent = world.create_agent("picky", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap().to_owned();
    let (status, _) = world
        .patch(
            &format!("/api/agents/{agent_id}/model"),
            json!({"modelProfileId": "ghost"}),
        )
        .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn clearing_then_reswitching_model_without_prompting() {
    let world = world().await;
    let (_, model) = world
        .post(
            "/api/models",
            json!({"label": "M", "provider": "openai", "model": "gpt-6", "apiKey": "k"}),
        )
        .await;
    let model_id = model["id"].as_str().unwrap().to_owned();
    let (_, agent) = world
        .post(
            "/api/agents",
            json!({"name": "clearer", "useWorktree": false, "projectId": world.project_id, "approvalMode": "auto", "modelProfileId": model_id}),
        )
        .await;
    let agent_id = agent["id"].as_str().unwrap().to_owned();

    // The first switch clears the profile and kills the live process.
    let (status, cleared) = world
        .patch(
            &format!("/api/agents/{agent_id}/model"),
            json!({"modelProfileId": null}),
        )
        .await;
    assert_eq!(status, 200, "clear failed: {cleared}");
    assert!(cleared["modelProfileId"].is_null());
    assert!(cleared["modelLabel"].is_null());

    // The second switch runs with no prompt in between, so the runtime is
    // already gone and there is no client to kill.
    let (status, reset) = world
        .patch(
            &format!("/api/agents/{agent_id}/model"),
            json!({"modelProfileId": model_id}),
        )
        .await;
    assert_eq!(status, 200, "reset failed: {reset}");
    assert_eq!(reset["modelProfileId"], model_id);
    assert_eq!(reset["modelLabel"], "M");
}

#[tokio::test]
async fn agent_referencing_a_deleted_model_starts_with_an_empty_overlay() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    init_repo(&repo).await;
    let config = ManagerConfig {
        repo_root: repo.clone(),
        worktrees_dir: dir.path().join("worktrees"),
        data_dir: dir.path().join("data"),
        agent_command: vec![STUB_AGENT.to_owned()],
        max_agents: 50,
        github_api_base_url: "https://api.github.com".to_owned(),
    };

    let agent_id = {
        let manager = AgentManager::new(config.clone()).await.unwrap();
        let model = manager
            .create_model(clai2_web_server::models::ProfileEdit {
                label: "Doomed".to_owned(),
                provider: clai2_web_server::models::Provider::Openai,
                model: "gpt-6".to_owned(),
                api_key: None,
                project_id: None,
                region: None,
                credentials_json: None,
                extra_env: vec![],
            })
            .await
            .unwrap();
        let project_id = manager.list_projects().await[0].id.clone();
        let agent = manager
            .create_agent(clai2_web_server::manager::CreateAgent {
                name: "orphan".to_owned(),
                project_id,
                use_worktree: false,
                base_branch: None,
                approval_mode: clai2_web_server::model::ApprovalMode::Auto,
                model_profile_id: Some(model.id.clone()),
                initial_prompt: None,
            })
            .await
            .unwrap();
        agent.id
    };

    // Drop the profile from disk so the restart cannot resolve it, standing in
    // for a profile deleted while an agent still references it.
    tokio::fs::write(config.data_dir.join("models.json"), b"[]")
        .await
        .unwrap();

    let manager = AgentManager::new(config).await.unwrap();
    // A prompt respawns the process; spawn_env finds no profile and runs with
    // an empty overlay rather than refusing to start.
    let mut receiver = manager.hub().subscribe();
    manager
        .prompt(&agent_id, "main", "env:CLAI_MODEL".to_owned())
        .await
        .unwrap();
    let mut echo = String::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(30), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        match event {
            clai2_web_server::events::Event::MessageChunk { text, .. } => echo.push_str(&text),
            clai2_web_server::events::Event::TurnEnded { .. } => break,
            _ => {}
        }
    }
    // No profile means no CLAI_MODEL overlay, so the stub echoes an empty value.
    assert!(echo.starts_with("env CLAI_MODEL="), "echo: {echo}");
    assert!(!echo.contains("gpt-6"), "echo: {echo}");
}

#[tokio::test]
async fn agent_process_is_told_its_own_id_and_debug_context_dir() {
    let world = world().await;
    let agent = world.create_agent("solo", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap().to_owned();

    let mut ws = world.ws().await;
    world.prompt(&agent_id, "main", "env:CLAI_AGENT_ID").await;
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    let chunks = events_of_type(&events, "messageChunk");
    assert!(
        chunks
            .iter()
            .any(|chunk| chunk["text"] == format!("env CLAI_AGENT_ID={agent_id}")),
        "chunks: {chunks:?}"
    );

    world.prompt(&agent_id, "main", "env:CLAI_DEBUG_CONTEXT_DIR").await;
    let events = ws.collect_until(|event| event["type"] == "turnEnded").await;
    let chunks = events_of_type(&events, "messageChunk");
    assert!(
        chunks
            .iter()
            .any(|chunk| chunk["text"].as_str().unwrap_or_default().ends_with("debug-context")),
        "chunks: {chunks:?}"
    );
    ws.close().await;
}

#[tokio::test]
async fn debug_context_for_unknown_agent_is_404() {
    let world = world().await;
    let (status, _) = world.get("/api/agents/ghost/sessions/main/debug-context").await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn debug_context_for_unknown_session_is_404() {
    let world = world().await;
    let agent = world.create_agent("solo", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let (status, _) = world
        .get(&format!("/api/agents/{agent_id}/sessions/ghost/debug-context"))
        .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn debug_context_with_no_snapshot_yet_is_null() {
    let world = world().await;
    let agent = world.create_agent("solo", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap();
    let (status, body) = world
        .get(&format!("/api/agents/{agent_id}/sessions/main/debug-context"))
        .await;
    assert_eq!(status, 200);
    assert!(body.is_null(), "body: {body}");
}

/// Prompts `agent_id`'s main session for real, over a real ACP handshake, and returns the
/// `acpSessionId` the backend recorded for it -- the id `clai_agent.py` actually names its
/// snapshot file after, which is *not* the same string as this session's own `"main"` id.
async fn establish_acp_session(world: &World, agent_id: &str) -> String {
    let mut ws = world.ws().await;
    world.prompt(agent_id, "main", "hello").await;
    ws.collect_until(|event| event["type"] == "turnEnded").await;
    ws.close().await;
    let (_, agent) = world.get(&format!("/api/agents/{agent_id}")).await;
    agent["sessions"][0]["acpSessionId"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn debug_context_passes_through_the_agent_process_snapshot() {
    let world = world().await;
    let agent = world.create_agent("solo", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap().to_owned();
    let acp_session_id = establish_acp_session(&world, &agent_id).await;

    // Stands in for `clai_agent.py`'s debug-context listener (a
    // `pydantic_ai_harness.compaction.ReportModelRequest` capability plus an `@agent.on_event`
    // handler), which writes exactly this file shape -- opaque JSON passed straight through --
    // named after the ACP session id, the only session identity the agent process ever sees.
    let snapshot_dir = world._dir.path().join("data/debug-context").join(&agent_id);
    tokio::fs::create_dir_all(&snapshot_dir).await.unwrap();
    let snapshot = json!([{"kind": "request", "parts": [{"part_kind": "user-prompt", "content": "hi"}]}]);
    tokio::fs::write(
        snapshot_dir.join(format!("{acp_session_id}.json")),
        snapshot.to_string(),
    )
    .await
    .unwrap();

    let (status, body) = world
        .get(&format!("/api/agents/{agent_id}/sessions/main/debug-context"))
        .await;
    assert_eq!(status, 200);
    assert_eq!(body, snapshot);
}

#[tokio::test]
async fn debug_context_is_keyed_by_the_acp_session_id_not_the_clai2_web_session_id() {
    // Regression test: the agent process only ever knows the ACP-protocol session id (it has no
    // way to learn clai2-web's own "main"/side-session naming), so a file named after clai2-web's
    // session id -- which is exactly the mistake that shipped with the first version of this
    // endpoint -- must not be found.
    let world = world().await;
    let agent = world.create_agent("solo", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap().to_owned();
    establish_acp_session(&world, &agent_id).await;

    let snapshot_dir = world._dir.path().join("data/debug-context").join(&agent_id);
    tokio::fs::create_dir_all(&snapshot_dir).await.unwrap();
    let wrongly_keyed = json!([{"kind": "request", "parts": []}]);
    tokio::fs::write(snapshot_dir.join("main.json"), wrongly_keyed.to_string())
        .await
        .unwrap();

    let (status, body) = world
        .get(&format!("/api/agents/{agent_id}/sessions/main/debug-context"))
        .await;
    assert_eq!(status, 200);
    assert!(body.is_null(), "body: {body}");
}

#[tokio::test]
async fn debug_context_with_a_corrupt_snapshot_is_400() {
    let world = world().await;
    let agent = world.create_agent("solo", false, "auto").await;
    let agent_id = agent["id"].as_str().unwrap().to_owned();
    let acp_session_id = establish_acp_session(&world, &agent_id).await;

    let snapshot_dir = world._dir.path().join("data/debug-context").join(&agent_id);
    tokio::fs::create_dir_all(&snapshot_dir).await.unwrap();
    tokio::fs::write(snapshot_dir.join(format!("{acp_session_id}.json")), b"not json")
        .await
        .unwrap();

    let (status, _) = world
        .get(&format!("/api/agents/{agent_id}/sessions/main/debug-context"))
        .await;
    assert_eq!(status, 400);
}
