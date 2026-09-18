//! Deterministic ACP agent for tests, e2e runs, and demo mode.
//!
//! Speaks newline-delimited JSON-RPC 2.0 on stdio. Prompt text drives the
//! scripted behavior, so tests can exercise streaming, tool calls, approvals,
//! and cancellation without a model:
//!
//! - `think: <text>`   -- emits a thought chunk before the echo
//! - `approve:<kind>`  -- announces a tool call of `<kind>`, requests
//!   permission, then completes or fails the call per the client's answer
//! - `slow`            -- streams one chunk, then waits for `session/cancel`
//! - `fail`            -- answers the prompt with a JSON-RPC error
//! - anything else     -- echoes the prompt back as one message chunk

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{stdin, stdout, AsyncBufReadExt, AsyncWriteExt, BufReader, Stdout};
use tokio::sync::{oneshot, Mutex, Notify};

struct Stub {
    stdout: Mutex<Stdout>,
    permission_waiters: Mutex<HashMap<i64, oneshot::Sender<Value>>>,
    cancels: Mutex<HashMap<String, Arc<Notify>>>,
    next_request_id: AtomicI64,
    next_session: AtomicI64,
    next_tool_call: AtomicI64,
}

impl Stub {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            stdout: Mutex::new(stdout()),
            permission_waiters: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
            next_request_id: AtomicI64::new(1),
            next_session: AtomicI64::new(1),
            next_tool_call: AtomicI64::new(1),
        })
    }

    async fn write_frame(&self, frame: Value) {
        let mut line = frame.to_string();
        line.push('\n');
        let mut out = self.stdout.lock().await;
        if out.write_all(line.as_bytes()).await.is_err() {
            std::process::exit(0);
        }
        let _ = out.flush().await;
    }

    async fn respond(&self, id: &Value, result: Value) {
        self.write_frame(json!({"jsonrpc": "2.0", "id": id, "result": result}))
            .await;
    }

    async fn respond_error(&self, id: &Value, code: i64, message: &str) {
        self.write_frame(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": code, "message": message},
        }))
        .await;
    }

    async fn send_update(&self, session_id: &str, update: Value) {
        self.write_frame(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": session_id, "update": update},
        }))
        .await;
    }

    async fn send_text_chunk(&self, session_id: &str, variant: &str, text: &str) {
        self.send_update(
            session_id,
            json!({
                "sessionUpdate": variant,
                "content": {"type": "text", "text": text},
            }),
        )
        .await;
    }

    async fn request_permission(&self, session_id: &str, tool_call: Value) -> Value {
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.permission_waiters.lock().await.insert(id, tx);
        self.write_frame(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/request_permission",
            "params": {
                "sessionId": session_id,
                "toolCall": tool_call,
                "options": [
                    {"optionId": "allow_once", "name": "Allow", "kind": "allow_once"},
                    {"optionId": "allow_always", "name": "Always allow", "kind": "allow_always"},
                    {"optionId": "reject_once", "name": "Reject", "kind": "reject_once"},
                    {"optionId": "reject_always", "name": "Always reject", "kind": "reject_always"}
                ],
            },
        }))
        .await;
        rx.await
            .unwrap_or_else(|_| json!({"outcome": {"outcome": "cancelled"}}))
    }

    async fn cancel_notify(&self, session_id: &str) -> Arc<Notify> {
        let mut cancels = self.cancels.lock().await;
        Arc::clone(cancels.entry(session_id.to_owned()).or_default())
    }
}

fn prompt_text(params: &Value) -> String {
    params
        .get("prompt")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

async fn handle_prompt(stub: Arc<Stub>, request_id: Value, params: Value) {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let text = prompt_text(&params);
    let cancelled = stub.cancel_notify(&session_id).await;

    if text.contains("fail") {
        stub.respond_error(&request_id, -32603, "scripted failure").await;
        return;
    }

    // Drop the connection mid-turn without responding, to exercise the
    // manager's unexpected-exit handling.
    if text.contains("crash") {
        std::process::exit(0);
    }

    // Emit a plan update, then end the turn.
    if text.contains("emit-plan") {
        stub.send_update(
            &session_id,
            json!({
                "sessionUpdate": "plan",
                "entries": [{"content": "step one", "priority": "high", "status": "pending"}],
            }),
        )
        .await;
        stub.respond(&request_id, json!({"stopReason": "end_turn"})).await;
        return;
    }

    // Emit update variants the manager records passively (a user message chunk
    // echoed back, and an unrecognized variant), then end the turn.
    if text.contains("emit-extras") {
        stub.send_update(
            &session_id,
            json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "u"}}),
        )
        .await;
        stub.send_update(&session_id, json!({"sessionUpdate": "usage_update"}))
            .await;
        stub.respond(&request_id, json!({"stopReason": "end_turn"})).await;
        return;
    }

    // Emit a tool_call_update with no preceding tool_call announcement, so the
    // manager materializes the view from the patch alone.
    if text.contains("bare-update") {
        stub.send_update(
            &session_id,
            json!({"sessionUpdate": "tool_call_update", "toolCallId": "bare-1", "status": "completed"}),
        )
        .await;
        stub.respond(&request_id, json!({"stopReason": "end_turn"})).await;
        return;
    }

    // Announce a tool call, request permission, then drop the connection
    // without waiting for the answer, so the client's response has nowhere to
    // go.
    if text.contains("perm-then-exit") {
        let call_number = stub.next_tool_call.fetch_add(1, Ordering::Relaxed);
        let tool_call_id = format!("call-{call_number}");
        stub.send_update(
            &session_id,
            json!({
                "sessionUpdate": "tool_call",
                "toolCallId": tool_call_id,
                "title": "stub execute",
                "kind": "execute",
                "status": "pending",
            }),
        )
        .await;
        let id = stub.next_request_id.fetch_add(1, Ordering::Relaxed);
        stub.write_frame(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/request_permission",
            "params": {
                "sessionId": session_id,
                "toolCall": {"toolCallId": tool_call_id, "title": "stub execute", "kind": "execute", "status": "pending"},
                "options": [
                    {"optionId": "allow_once", "name": "Allow", "kind": "allow_once"},
                    {"optionId": "reject_once", "name": "Reject", "kind": "reject_once"}
                ],
            },
        }))
        .await;
        std::process::exit(0);
    }

    if let Some(rest) = text.split("think:").nth(1) {
        stub.send_text_chunk(&session_id, "agent_thought_chunk", rest.trim())
            .await;
    }

    if text.contains("slow") {
        stub.send_text_chunk(&session_id, "agent_message_chunk", "working...")
            .await;
        cancelled.notified().await;
        stub.respond(&request_id, json!({"stopReason": "cancelled"})).await;
        return;
    }

    if let Some(kind) = text
        .split("approve:")
        .nth(1)
        .map(|rest| rest.split_whitespace().next().unwrap_or("execute").to_owned())
    {
        let call_number = stub.next_tool_call.fetch_add(1, Ordering::Relaxed);
        let tool_call_id = format!("call-{call_number}");
        stub.send_update(
            &session_id,
            json!({
                "sessionUpdate": "tool_call",
                "toolCallId": tool_call_id,
                "title": format!("stub {kind}"),
                "kind": kind,
                "status": "pending",
                "rawInput": {"prompt": text},
            }),
        )
        .await;
        let answer = stub
            .request_permission(
                &session_id,
                json!({
                    "toolCallId": tool_call_id,
                    "title": format!("stub {kind}"),
                    "kind": kind,
                    "status": "pending",
                }),
            )
            .await;
        let outcome = answer.get("outcome").cloned().unwrap_or(Value::Null);
        match outcome.get("outcome").and_then(Value::as_str) {
            Some("selected") => {
                let allowed = outcome
                    .get("optionId")
                    .and_then(Value::as_str)
                    .is_some_and(|option| option.starts_with("allow"));
                if allowed {
                    stub.send_update(
                        &session_id,
                        json!({"sessionUpdate": "tool_call_update", "toolCallId": tool_call_id, "status": "in_progress"}),
                    )
                    .await;
                    stub.send_update(
                        &session_id,
                        json!({"sessionUpdate": "tool_call_update", "toolCallId": tool_call_id, "status": "completed"}),
                    )
                    .await;
                    stub.send_text_chunk(&session_id, "agent_message_chunk", "tool ran")
                        .await;
                } else {
                    stub.send_update(
                        &session_id,
                        json!({"sessionUpdate": "tool_call_update", "toolCallId": tool_call_id, "status": "failed"}),
                    )
                    .await;
                    stub.send_text_chunk(&session_id, "agent_message_chunk", "tool rejected")
                        .await;
                }
                stub.respond(&request_id, json!({"stopReason": "end_turn"})).await;
            }
            _ => {
                stub.send_update(
                    &session_id,
                    json!({"sessionUpdate": "tool_call_update", "toolCallId": tool_call_id, "status": "failed"}),
                )
                .await;
                stub.respond(&request_id, json!({"stopReason": "cancelled"})).await;
            }
        }
        return;
    }

    stub.send_text_chunk(&session_id, "agent_message_chunk", &format!("echo: {text}"))
        .await;
    stub.respond(
        &request_id,
        json!({
            "stopReason": "end_turn",
            "usage": {"totalTokens": 3, "inputTokens": 2, "outputTokens": 1},
        }),
    )
    .await;
}

async fn handle_frame(stub: Arc<Stub>, frame: Value) {
    let method = frame.get("method").and_then(Value::as_str).map(str::to_owned);
    let id = frame.get("id").cloned();
    match (method.as_deref(), id) {
        (Some("initialize"), Some(id)) => {
            stub.respond(
                &id,
                json!({
                    "protocolVersion": 1,
                    "agentCapabilities": {"loadSession": false, "promptCapabilities": {}},
                    "agentInfo": {"name": "stub-agent", "version": "0.1.0"},
                }),
            )
            .await;
        }
        (Some("session/new"), Some(id)) => {
            let number = stub.next_session.fetch_add(1, Ordering::Relaxed);
            let session_id = format!("stub-session-{number}");
            stub.cancels
                .lock()
                .await
                .insert(session_id.clone(), Arc::new(Notify::new()));
            stub.respond(&id, json!({"sessionId": session_id})).await;
        }
        (Some("session/prompt"), Some(id)) => {
            let params = frame.get("params").cloned().unwrap_or(Value::Null);
            tokio::spawn(handle_prompt(stub, id, params));
        }
        (Some("session/cancel"), None) => {
            let session_id = frame
                .get("params")
                .and_then(|params| params.get("sessionId"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if let Some(notify) = stub.cancels.lock().await.get(session_id) {
                notify.notify_waiters();
            }
        }
        (Some(other), Some(id)) => {
            stub.respond_error(&id, -32601, &format!("method not found: {other}"))
                .await;
        }
        (Some(_), None) => {}
        (None, _) => {
            // A response to one of our own requests (permission answers).
            if let Some(id) = frame.get("id").and_then(Value::as_i64) {
                if let Some(waiter) = stub.permission_waiters.lock().await.remove(&id) {
                    let _ = waiter.send(frame.get("result").cloned().unwrap_or(Value::Null));
                }
            }
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let stub = Stub::new();
    let mut lines = BufReader::new(stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(frame) = serde_json::from_str::<Value>(&line) {
            handle_frame(Arc::clone(&stub), frame).await;
        }
    }
}
