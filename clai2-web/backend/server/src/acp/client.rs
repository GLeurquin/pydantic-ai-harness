//! Typed ACP client over one agent subprocess.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};

use super::transport::{Inbound, RpcError, Transport};
use super::updates::{parse_tool_call, parse_update, SessionUpdate};
use crate::model::{PermissionOption, PermissionOptionKind, StopReason};

#[derive(Debug, thiserror::Error)]
pub enum SpawnError {
    #[error("agent command is empty")]
    EmptyCommand,
    #[error("failed to spawn agent process `{command}`: {source}")]
    Spawn { command: String, source: std::io::Error },
    #[error(transparent)]
    Rpc(#[from] RpcError),
}

/// A permission request from the agent, awaiting an answer.
#[derive(Debug)]
pub struct PermissionRequest {
    pub rpc_id: Value,
    pub acp_session_id: String,
    pub tool_call: crate::model::ToolCallView,
    pub options: Vec<PermissionOption>,
}

/// Protocol traffic surfaced to the agent manager, in wire order.
#[derive(Debug)]
pub enum AcpEvent {
    Update {
        acp_session_id: String,
        update: SessionUpdate,
    },
    Permission(PermissionRequest),
    /// A response to one of our requests. The consumer resolves it via
    /// [`AcpClient::resolve_response`] after handling everything the agent
    /// sent before it, so a prompt turn cannot complete ahead of its own
    /// streamed output.
    Response(Value),
    /// The agent process closed its side of the connection.
    Closed,
}

pub struct AcpClient {
    transport: Arc<Transport>,
    child: Mutex<Child>,
}

fn parse_options(value: &Value) -> Vec<PermissionOption> {
    value
        .as_array()
        .map(|options| {
            options
                .iter()
                .filter_map(|option| {
                    let option_id = option.get("optionId").and_then(Value::as_str)?.to_owned();
                    let kind = match option.get("kind").and_then(Value::as_str) {
                        Some("allow_once") => PermissionOptionKind::AllowOnce,
                        Some("allow_always") => PermissionOptionKind::AllowAlways,
                        Some("reject_once") => PermissionOptionKind::RejectOnce,
                        Some("reject_always") => PermissionOptionKind::RejectAlways,
                        _ => return None,
                    };
                    let name = option
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or(&option_id)
                        .to_owned();
                    Some(PermissionOption { option_id, name, kind })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_stop_reason(result: &Value) -> StopReason {
    match result.get("stopReason").and_then(Value::as_str) {
        Some("max_tokens") => StopReason::MaxTokens,
        Some("max_turn_requests") => StopReason::MaxTurnRequests,
        Some("refusal") => StopReason::Refusal,
        Some("cancelled") => StopReason::Cancelled,
        _ => StopReason::EndTurn,
    }
}

async fn dispatch_loop(
    mut inbound: mpsc::Receiver<Inbound>,
    transport: Arc<Transport>,
    events: mpsc::Sender<AcpEvent>,
) {
    while let Some(message) = inbound.recv().await {
        match message {
            Inbound::Notification(notification) if notification.method == "session/update" => {
                let acp_session_id = notification
                    .params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let update = notification
                    .params
                    .get("update")
                    .map(parse_update)
                    .unwrap_or(SessionUpdate::Other);
                if events.send(AcpEvent::Update { acp_session_id, update }).await.is_err() {
                    return;
                }
            }
            Inbound::Notification(_) => {}
            Inbound::Request(request) if request.method == "session/request_permission" => {
                let acp_session_id = request
                    .params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let tool_call = request
                    .params
                    .get("toolCall")
                    .map(parse_tool_call)
                    .unwrap_or_else(|| parse_tool_call(&Value::Null));
                let options = request.params.get("options").map(parse_options).unwrap_or_default();
                let permission = PermissionRequest {
                    rpc_id: request.id,
                    acp_session_id,
                    tool_call,
                    options,
                };
                if events.send(AcpEvent::Permission(permission)).await.is_err() {
                    return;
                }
            }
            Inbound::Request(request) => {
                // fs/*, terminal/* and extensions are not advertised, so any
                // request here is out of contract; decline it.
                let _ = transport
                    .respond_error(request.id, -32601, &format!("method not supported: {}", request.method))
                    .await;
            }
            Inbound::Response(frame) => {
                if events.send(AcpEvent::Response(frame)).await.is_err() {
                    return;
                }
            }
        }
    }
    let _ = events.send(AcpEvent::Closed).await;
}

impl AcpClient {
    /// Spawn the agent process and wire the protocol over its stdio.
    pub fn spawn(command: &[String], cwd: &Path) -> Result<(Arc<Self>, mpsc::Receiver<AcpEvent>), SpawnError> {
        let (program, args) = command.split_first().ok_or(SpawnError::EmptyCommand)?;
        let mut child = Command::new(program)
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|source| SpawnError::Spawn {
                command: command.join(" "),
                source,
            })?;
        // Both handles are piped above, so `take` yields Some. The eager errors
        // keep these single covered expressions rather than a branch that never
        // runs, while still surfacing a spawn failure if a handle is missing.
        let stdout = child.stdout.take().ok_or(SpawnError::Spawn {
            command: command.join(" "),
            source: std::io::Error::other("child stdout was not piped"),
        });
        let stdin = child.stdin.take().ok_or(SpawnError::Spawn {
            command: command.join(" "),
            source: std::io::Error::other("child stdin was not piped"),
        });
        let (transport, inbound) = Transport::new(stdout?, stdin?);
        let (events_tx, events_rx) = mpsc::channel(1024);
        tokio::spawn(dispatch_loop(inbound, Arc::clone(&transport), events_tx));
        let client = Arc::new(Self {
            transport,
            child: Mutex::new(child),
        });
        Ok((client, events_rx))
    }

    /// Negotiate the protocol. The client is text-only and delegates all file
    /// and terminal IO to the agent's own tools.
    pub async fn initialize(&self) -> Result<(), RpcError> {
        self.transport
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": {"readTextFile": false, "writeTextFile": false},
                        "terminal": false,
                    },
                    "clientInfo": {"name": "clai2-web", "version": env!("CARGO_PKG_VERSION")},
                }),
            )
            .await?;
        Ok(())
    }

    /// Open a session rooted at `cwd`. Returns the agent-assigned session id.
    pub async fn new_session(&self, cwd: &Path) -> Result<String, RpcError> {
        let result = self
            .transport
            .request("session/new", json!({"cwd": cwd, "mcpServers": []}))
            .await?;
        Ok(result
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned())
    }

    /// Send a prompt turn and wait for it to end.
    pub async fn prompt(&self, acp_session_id: &str, text: &str) -> Result<StopReason, RpcError> {
        let result = self
            .transport
            .request(
                "session/prompt",
                json!({
                    "sessionId": acp_session_id,
                    "prompt": [{"type": "text", "text": text}],
                }),
            )
            .await?;
        Ok(parse_stop_reason(&result))
    }

    /// Ask the agent to cancel the in-flight turn (fire-and-forget).
    pub async fn cancel(&self, acp_session_id: &str) -> Result<(), RpcError> {
        self.transport
            .notify("session/cancel", json!({"sessionId": acp_session_id}))
            .await
    }

    /// Answer a permission request: `Some(option_id)` selects an option,
    /// `None` reports the turn as cancelled.
    pub async fn respond_permission(&self, rpc_id: Value, option_id: Option<String>) -> Result<(), RpcError> {
        let outcome = match option_id {
            Some(option_id) => json!({"outcome": {"outcome": "selected", "optionId": option_id}}),
            None => json!({"outcome": {"outcome": "cancelled"}}),
        };
        self.transport.respond(rpc_id, outcome).await
    }

    /// Resolve a response frame delivered as [`AcpEvent::Response`].
    pub async fn resolve_response(&self, frame: &Value) {
        self.transport.resolve_response(frame).await;
    }

    /// Fail all in-flight and future requests; the connection is gone.
    pub async fn fail_all(&self) {
        self.transport.fail_all().await;
    }

    /// Kill the agent process.
    pub async fn kill(&self) {
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_options_keeps_known_kinds_only() {
        let value = json!([
            {"optionId": "allow_once", "name": "Allow", "kind": "allow_once"},
            {"optionId": "allow_always", "name": "Always allow", "kind": "allow_always"},
            {"optionId": "reject_once", "name": "Reject", "kind": "reject_once"},
            {"optionId": "reject_always", "name": "Always reject", "kind": "reject_always"},
            {"optionId": "weird", "name": "Weird", "kind": "someday"},
            {"name": "missing id", "kind": "allow_once"}
        ]);
        let options = parse_options(&value);
        assert_eq!(options.len(), 4);
        assert_eq!(options[0].kind, PermissionOptionKind::AllowOnce);
        assert_eq!(options[3].kind, PermissionOptionKind::RejectAlways);
    }

    #[test]
    fn parse_options_defaults_name_to_id() {
        let value = json!([{"optionId": "allow_once", "kind": "allow_once"}]);
        let options = parse_options(&value);
        assert_eq!(options[0].name, "allow_once");
    }

    #[test]
    fn parse_options_of_non_array_is_empty() {
        assert!(parse_options(&Value::Null).is_empty());
    }

    #[test]
    fn parse_stop_reason_covers_all_values() {
        for (name, reason) in [
            ("end_turn", StopReason::EndTurn),
            ("max_tokens", StopReason::MaxTokens),
            ("max_turn_requests", StopReason::MaxTurnRequests),
            ("refusal", StopReason::Refusal),
            ("cancelled", StopReason::Cancelled),
        ] {
            assert_eq!(parse_stop_reason(&json!({"stopReason": name})), reason);
        }
        assert_eq!(parse_stop_reason(&json!({})), StopReason::EndTurn);
    }

    #[test]
    fn spawn_with_empty_command_fails() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _guard = runtime.enter();
        assert!(matches!(
            AcpClient::spawn(&[], Path::new("/tmp")),
            Err(SpawnError::EmptyCommand)
        ));
    }

    #[test]
    fn spawn_with_missing_binary_fails() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _guard = runtime.enter();
        let result = AcpClient::spawn(&["/nonexistent/agent-binary".to_owned()], Path::new("/tmp"));
        assert!(matches!(result, Err(SpawnError::Spawn { .. })));
    }

    #[tokio::test]
    async fn dispatch_loop_routes_every_inbound_kind() {
        use crate::acp::transport::{InboundNotification, InboundRequest};
        use tokio::io::{duplex, split, AsyncBufReadExt, BufReader};

        let (client_io, agent_io) = duplex(4096);
        let (read_half, write_half) = split(client_io);
        let (transport, _transport_inbound) = super::super::transport::Transport::new(read_half, write_half);
        let (agent_read, _agent_write) = split(agent_io);
        let mut agent_lines = BufReader::new(agent_read).lines();
        let (in_tx, in_rx) = mpsc::channel(16);
        let (events_tx, mut events_rx) = mpsc::channel(16);
        let handle = tokio::spawn(dispatch_loop(in_rx, Arc::clone(&transport), events_tx));

        // A notification other than session/update is dropped.
        in_tx
            .send(Inbound::Notification(InboundNotification {
                method: "session/other".to_owned(),
                params: json!({}),
            }))
            .await
            .unwrap();
        // A session/update becomes an Update event.
        in_tx
            .send(Inbound::Notification(InboundNotification {
                method: "session/update".to_owned(),
                params: json!({
                    "sessionId": "s",
                    "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hi"}},
                }),
            }))
            .await
            .unwrap();
        assert!(matches!(events_rx.recv().await.unwrap(), AcpEvent::Update { .. }));
        // A permission request becomes a Permission event.
        in_tx
            .send(Inbound::Request(InboundRequest {
                id: json!(1),
                method: "session/request_permission".to_owned(),
                params: json!({"sessionId": "s", "toolCall": {"toolCallId": "t"}, "options": []}),
            }))
            .await
            .unwrap();
        assert!(matches!(events_rx.recv().await.unwrap(), AcpEvent::Permission(_)));
        // Any other request is declined with a JSON-RPC error.
        in_tx
            .send(Inbound::Request(InboundRequest {
                id: json!(2),
                method: "fs/read_text_file".to_owned(),
                params: json!({}),
            }))
            .await
            .unwrap();
        let declined: Value = serde_json::from_str(&agent_lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(declined["id"], 2);
        assert_eq!(declined["error"]["code"], -32601);
        // A response frame is forwarded as a Response event.
        in_tx
            .send(Inbound::Response(json!({"id": 5, "result": {}})))
            .await
            .unwrap();
        assert!(matches!(events_rx.recv().await.unwrap(), AcpEvent::Response(_)));
        // Closing the inbound channel emits a final Closed event.
        drop(in_tx);
        assert!(matches!(events_rx.recv().await.unwrap(), AcpEvent::Closed));
        handle.await.unwrap();
    }

    async fn dispatch_loop_returns_when_events_closed(message: Inbound) {
        use tokio::io::{duplex, split};
        let (client_io, agent_io) = duplex(64);
        let (read_half, write_half) = split(client_io);
        let (transport, _transport_inbound) = super::super::transport::Transport::new(read_half, write_half);
        let _keep_agent = agent_io;
        let (in_tx, in_rx) = mpsc::channel(4);
        let (events_tx, events_rx) = mpsc::channel(1);
        drop(events_rx);
        let handle = tokio::spawn(dispatch_loop(in_rx, transport, events_tx));
        in_tx.send(message).await.unwrap();
        // The send into the closed events channel fails, so the loop returns.
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn dispatch_loop_stops_when_update_cannot_be_delivered() {
        use crate::acp::transport::InboundNotification;
        dispatch_loop_returns_when_events_closed(Inbound::Notification(InboundNotification {
            method: "session/update".to_owned(),
            params: json!({"sessionId": "s", "update": {}}),
        }))
        .await;
    }

    #[tokio::test]
    async fn dispatch_loop_stops_when_permission_cannot_be_delivered() {
        use crate::acp::transport::InboundRequest;
        dispatch_loop_returns_when_events_closed(Inbound::Request(InboundRequest {
            id: json!(1),
            method: "session/request_permission".to_owned(),
            params: json!({"sessionId": "s"}),
        }))
        .await;
    }

    #[tokio::test]
    async fn dispatch_loop_stops_when_response_cannot_be_delivered() {
        dispatch_loop_returns_when_events_closed(Inbound::Response(json!({"id": 5, "result": {}}))).await;
    }
}
