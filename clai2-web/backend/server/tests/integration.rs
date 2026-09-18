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
    #[allow(dead_code)]
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
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    init_repo(&repo).await;
    let config = ManagerConfig {
        repo_root: repo.clone(),
        worktrees_dir: dir.path().join("worktrees"),
        data_dir: dir.path().join("data"),
        agent_command,
        max_agents,
    };
    let manager = AgentManager::new(config).await.unwrap();
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

    async fn create_agent(&self, name: &str, use_worktree: bool, mode: &str) -> Value {
        let (status, agent) = self
            .post(
                "/api/agents",
                json!({"name": name, "useWorktree": use_worktree, "approvalMode": mode}),
            )
            .await;
        assert_eq!(status, 200, "create agent failed: {agent}");
        agent
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
        .post("/api/agents", json!({"name": "  ", "approvalMode": "auto"}))
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
        .post("/api/agents", json!({"name": "three", "approvalMode": "auto"}))
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
        .post("/api/agents", json!({"name": "three", "approvalMode": "auto"}))
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
async fn broken_agent_command_reports_error_status() {
    let world = world_with(50, vec!["/nonexistent/agent".to_owned()]).await;
    let (status, agent) = world
        .post(
            "/api/agents",
            json!({"name": "doomed", "useWorktree": false, "approvalMode": "auto"}),
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
    };

    let agent_id = {
        let manager = AgentManager::new(config.clone()).await.unwrap();
        let agent = manager
            .create_agent(clai2_web_server::manager::CreateAgent {
                name: "survivor".to_owned(),
                use_worktree: false,
                base_branch: None,
                approval_mode: clai2_web_server::model::ApprovalMode::Auto,
                model_profile_id: None,
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
            json!({"name": "branchy", "useWorktree": true, "baseBranch": "no-such-branch", "approvalMode": "auto"}),
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
            json!({"name": "based", "useWorktree": true, "baseBranch": "main", "approvalMode": "auto"}),
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
            json!({"name": "stillborn", "useWorktree": false, "approvalMode": "auto"}),
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
            json!({"name": "modelled", "useWorktree": false, "approvalMode": "auto", "modelProfileId": model_id}),
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
            json!({"name": "bad", "useWorktree": false, "approvalMode": "auto", "modelProfileId": "ghost"}),
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
            json!({"name": "switcher", "useWorktree": false, "approvalMode": "auto", "modelProfileId": first}),
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
            json!({"name": "user", "useWorktree": false, "approvalMode": "auto", "modelProfileId": model_id}),
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
            json!({"name": "labelled", "useWorktree": false, "approvalMode": "auto", "modelProfileId": model_id}),
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
            json!({"name": "vertexed", "useWorktree": false, "approvalMode": "auto", "modelProfileId": model_id}),
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
            json!({"name": "clearer", "useWorktree": false, "approvalMode": "auto", "modelProfileId": model_id}),
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
        let agent = manager
            .create_agent(clai2_web_server::manager::CreateAgent {
                name: "orphan".to_owned(),
                use_worktree: false,
                base_branch: None,
                approval_mode: clai2_web_server::model::ApprovalMode::Auto,
                model_profile_id: Some(model.id.clone()),
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
