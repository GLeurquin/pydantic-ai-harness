//! Newline-delimited JSON-RPC 2.0 over a child process's stdio.
//!
//! One transport per agent process. All inbound traffic -- responses to our
//! requests, requests from the agent, and notifications -- is delivered on a
//! single ordered channel. The consumer resolves responses via
//! [`Transport::resolve_response`], which keeps protocol ordering intact:
//! a request's response cannot be observed before the notifications the
//! agent sent ahead of it have been handled.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex};

#[derive(Debug, thiserror::Error)]
pub enum RpcError {
    #[error("agent connection closed")]
    Closed,
    #[error("agent returned error {code}: {message}")]
    Agent { code: i64, message: String },
    #[error("io error talking to agent: {0}")]
    Io(#[from] std::io::Error),
    #[error("malformed frame from agent: {0}")]
    Malformed(#[from] serde_json::Error),
}

/// A request initiated by the agent that the client must answer.
#[derive(Debug)]
pub struct InboundRequest {
    pub id: Value,
    pub method: String,
    pub params: Value,
}

/// A notification from the agent (no response expected).
#[derive(Debug)]
pub struct InboundNotification {
    pub method: String,
    pub params: Value,
}

/// Traffic the transport hands to its owner, in wire order.
#[derive(Debug)]
pub enum Inbound {
    Request(InboundRequest),
    Notification(InboundNotification),
    /// A response to one of our requests; pass it to
    /// [`Transport::resolve_response`] once earlier traffic is handled.
    Response(Value),
}

type Waiters = Mutex<HashMap<i64, oneshot::Sender<Result<Value, RpcError>>>>;

pub struct Transport {
    writer: Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    waiters: Waiters,
    next_id: AtomicI64,
    closed: AtomicBool,
}

impl Transport {
    /// Wire the transport over a reader/writer pair. The read loop runs until
    /// EOF or a malformed frame, then closes the channel; the consumer must
    /// call [`Transport::fail_all`] when the channel closes.
    pub fn new(
        reader: impl AsyncRead + Send + Unpin + 'static,
        writer: impl AsyncWrite + Send + Unpin + 'static,
    ) -> (Arc<Self>, mpsc::Receiver<Inbound>) {
        let transport = Arc::new(Self {
            writer: Mutex::new(Box::new(writer)),
            waiters: Mutex::new(HashMap::new()),
            next_id: AtomicI64::new(1),
            closed: AtomicBool::new(false),
        });
        let (inbound_tx, inbound_rx) = mpsc::channel(256);
        tokio::spawn(read_loop(reader, inbound_tx));
        (transport, inbound_rx)
    }

    /// Send a request and await the agent's response.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            // Check and register under one lock: `fail_all` sets `closed` before
            // it drains the waiters, so a waiter registered here is either seen
            // by `fail_all` or rejected below -- it can never be orphaned.
            let mut waiters = self.waiters.lock().await;
            if self.closed.load(Ordering::Acquire) {
                return Err(RpcError::Closed);
            }
            waiters.insert(id, tx);
        }
        let frame = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        if let Err(err) = self.write_frame(&frame).await {
            self.waiters.lock().await.remove(&id);
            return Err(err);
        }
        rx.await.map_err(|_| RpcError::Closed)?
    }

    /// Send a notification (no response).
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), RpcError> {
        self.write_frame(&json!({"jsonrpc": "2.0", "method": method, "params": params}))
            .await
    }

    /// Answer a request the agent made to the client.
    pub async fn respond(&self, id: Value, result: Value) -> Result<(), RpcError> {
        self.write_frame(&json!({"jsonrpc": "2.0", "id": id, "result": result}))
            .await
    }

    /// Answer a request the agent made with a JSON-RPC error.
    pub async fn respond_error(&self, id: Value, code: i64, message: &str) -> Result<(), RpcError> {
        self.write_frame(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": code, "message": message},
        }))
        .await
    }

    /// Resolve the waiter for a response frame. Unknown ids are ignored.
    pub async fn resolve_response(&self, frame: &Value) {
        let Some(id) = frame.get("id").and_then(Value::as_i64) else {
            return;
        };
        let outcome = match frame.get("error") {
            Some(error) => Err(RpcError::Agent {
                code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error")
                    .to_owned(),
            }),
            None => Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
        };
        if let Some(waiter) = self.waiters.lock().await.remove(&id) {
            let _ = waiter.send(outcome);
        }
    }

    /// Fail every in-flight and future request: the connection is gone.
    pub async fn fail_all(&self) {
        self.closed.store(true, Ordering::Release);
        let mut waiters = self.waiters.lock().await;
        for (_, waiter) in waiters.drain() {
            let _ = waiter.send(Err(RpcError::Closed));
        }
    }

    async fn write_frame(&self, frame: &Value) -> Result<(), RpcError> {
        let mut bytes = serde_json::to_vec(frame)?;
        bytes.push(b'\n');
        let mut writer = self.writer.lock().await;
        writer.write_all(&bytes).await?;
        writer.flush().await?;
        Ok(())
    }
}

async fn read_loop(reader: impl AsyncRead + Send + Unpin, inbound_tx: mpsc::Sender<Inbound>) {
    let mut lines = BufReader::new(reader).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) | Err(_) => return,
        };
        if line.trim().is_empty() {
            continue;
        }
        let frame: Value = match serde_json::from_str(&line) {
            Ok(frame) => frame,
            Err(_) => return,
        };
        let inbound = if let Some(method) = frame.get("method").and_then(Value::as_str).map(str::to_owned) {
            let params = frame.get("params").cloned().unwrap_or(Value::Null);
            match frame.get("id") {
                Some(id) => Inbound::Request(InboundRequest {
                    id: id.clone(),
                    method,
                    params,
                }),
                None => Inbound::Notification(InboundNotification { method, params }),
            }
        } else if frame.get("id").is_some() {
            Inbound::Response(frame)
        } else {
            continue;
        };
        if inbound_tx.send(inbound).await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, split};

    fn expect_notification(inbound: Inbound) -> InboundNotification {
        match inbound {
            Inbound::Notification(notification) => notification,
            other => panic!("expected notification, got {other:?}"),
        }
    }

    fn expect_request(inbound: Inbound) -> InboundRequest {
        match inbound {
            Inbound::Request(request) => request,
            other => panic!("expected request, got {other:?}"),
        }
    }

    #[test]
    #[should_panic(expected = "expected notification")]
    fn expect_notification_rejects_other() {
        expect_notification(Inbound::Response(json!({})));
    }

    #[test]
    #[should_panic(expected = "expected request")]
    fn expect_request_rejects_other() {
        expect_request(Inbound::Response(json!({})));
    }

    /// Drive the consumer side the way `AcpClient` does: resolve responses in
    /// order, drop the rest, fail all waiters when the stream ends.
    fn pump(transport: Arc<Transport>, mut inbound: mpsc::Receiver<Inbound>) -> mpsc::Receiver<Inbound> {
        let (other_tx, other_rx) = mpsc::channel(64);
        tokio::spawn(async move {
            while let Some(message) = inbound.recv().await {
                match message {
                    Inbound::Response(frame) => transport.resolve_response(&frame).await,
                    other => {
                        let _ = other_tx.send(other).await;
                    }
                }
            }
            transport.fail_all().await;
        });
        other_rx
    }

    /// Test double: the "agent" end of a duplex pipe.
    async fn agent_side(stream: tokio::io::DuplexStream, script: impl FnOnce(String) -> Vec<String> + Send + 'static) {
        let (read_half, mut write_half) = split(stream);
        let mut lines = BufReader::new(read_half).lines();
        // Every caller sends one request line, so the read yields Some.
        let line = lines.next_line().await.unwrap().unwrap();
        for reply in script(line) {
            write_half.write_all(reply.as_bytes()).await.unwrap();
            write_half.write_all(b"\n").await.unwrap();
        }
        let _ = write_half.flush().await;
    }

    #[tokio::test]
    async fn request_gets_matching_response() {
        let (client_io, agent_io) = duplex(4096);
        let (read_half, write_half) = split(client_io);
        let (transport, inbound) = Transport::new(read_half, write_half);
        let _other = pump(Arc::clone(&transport), inbound);
        tokio::spawn(agent_side(agent_io, |line| {
            let frame: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(frame["method"], "initialize");
            vec![json!({"jsonrpc": "2.0", "id": frame["id"], "result": {"ok": true}}).to_string()]
        }));
        let result = transport.request("initialize", json!({})).await.unwrap();
        assert_eq!(result["ok"], true);
    }

    #[tokio::test]
    async fn error_response_surfaces_as_agent_error() {
        let (client_io, agent_io) = duplex(4096);
        let (read_half, write_half) = split(client_io);
        let (transport, inbound) = Transport::new(read_half, write_half);
        let _other = pump(Arc::clone(&transport), inbound);
        tokio::spawn(agent_side(agent_io, |line| {
            let frame: Value = serde_json::from_str(&line).unwrap();
            vec![json!({
                "jsonrpc": "2.0",
                "id": frame["id"],
                "error": {"code": -32601, "message": "no such method"},
            })
            .to_string()]
        }));
        let err = transport.request("bogus", json!({})).await.unwrap_err();
        assert_eq!(err.to_string(), "agent returned error -32601: no such method");
    }

    #[tokio::test]
    async fn closed_pipe_fails_in_flight_requests() {
        let (client_io, agent_io) = duplex(4096);
        let (read_half, write_half) = split(client_io);
        let (transport, inbound) = Transport::new(read_half, write_half);
        let _other = pump(Arc::clone(&transport), inbound);
        // The agent reads the request, replies nothing, and hangs up.
        tokio::spawn(agent_side(agent_io, |_line| vec![]));
        let err = transport.request("initialize", json!({})).await.unwrap_err();
        assert!(matches!(err, RpcError::Closed));
    }

    #[tokio::test]
    async fn requests_after_fail_all_fail_immediately() {
        let (client_io, agent_io) = duplex(4096);
        let (read_half, write_half) = split(client_io);
        let (transport, inbound) = Transport::new(read_half, write_half);
        let _other = pump(Arc::clone(&transport), inbound);
        let _keep_agent = agent_io;
        transport.fail_all().await;
        let err = transport.request("first", json!({})).await.unwrap_err();
        assert!(matches!(err, RpcError::Closed));
        let err = transport.request("second", json!({})).await.unwrap_err();
        assert!(matches!(err, RpcError::Closed));
    }

    #[tokio::test]
    async fn inbound_request_and_notification_are_delivered_in_order() {
        let (client_io, agent_io) = duplex(4096);
        let (read_half, write_half) = split(client_io);
        let (transport, inbound) = Transport::new(read_half, write_half);
        let mut other = pump(transport, inbound);
        let (agent_read, mut agent_write) = split(agent_io);
        let _keep = agent_read;
        agent_write
            .write_all(
                format!(
                    "{}\n{}\n",
                    json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s"}}),
                    json!({"jsonrpc": "2.0", "id": 9, "method": "session/request_permission", "params": {}}),
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let notification = expect_notification(other.recv().await.unwrap());
        assert_eq!(notification.method, "session/update");
        assert_eq!(notification.params["sessionId"], "s");
        let request = expect_request(other.recv().await.unwrap());
        assert_eq!(request.method, "session/request_permission");
        assert_eq!(request.id, json!(9));
    }

    #[tokio::test]
    async fn respond_writes_result_frame() {
        let (client_io, agent_io) = duplex(4096);
        let (read_half, write_half) = split(client_io);
        let (transport, _inbound) = Transport::new(read_half, write_half);
        let (agent_read, _agent_write) = split(agent_io);
        transport
            .respond(
                json!(5),
                json!({"outcome": {"outcome": "selected", "optionId": "allow"}}),
            )
            .await
            .unwrap();
        transport.respond_error(json!(6), -32000, "nope").await.unwrap();
        let mut lines = BufReader::new(agent_read).lines();
        let first: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(first["id"], 5);
        assert_eq!(first["result"]["outcome"]["optionId"], "allow");
        let second: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(second["error"]["code"], -32000);
    }

    #[tokio::test]
    async fn unknown_response_ids_and_junk_frames_are_ignored() {
        let (client_io, agent_io) = duplex(4096);
        let (read_half, write_half) = split(client_io);
        let (transport, inbound) = Transport::new(read_half, write_half);
        let mut other = pump(transport, inbound);
        let (agent_read, mut agent_write) = split(agent_io);
        let _keep = agent_read;
        agent_write
            .write_all(
                format!(
                    "{}\n\n{}\n{}\n",
                    json!({"jsonrpc": "2.0", "id": 777, "result": {}}),
                    json!({"jsonrpc": "2.0"}),
                    json!({"jsonrpc": "2.0", "method": "session/update", "params": {}}),
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let first = other.recv().await.unwrap();
        assert!(matches!(first, Inbound::Notification(_)));
    }

    #[tokio::test]
    async fn request_reports_error_when_write_fails() {
        let (client_io, agent_io) = duplex(4096);
        let (read_half, write_half) = split(client_io);
        let (transport, _inbound) = Transport::new(read_half, write_half);
        // Dropping the agent end breaks the pipe, so writing the frame fails.
        drop(agent_io);
        let err = transport.request("initialize", json!({})).await.unwrap_err();
        assert!(matches!(err, RpcError::Io(_) | RpcError::Closed));
    }

    #[tokio::test]
    async fn resolve_response_without_integer_id_is_ignored() {
        let (client_io, agent_io) = duplex(4096);
        let (read_half, write_half) = split(client_io);
        let (transport, _inbound) = Transport::new(read_half, write_half);
        let _keep = agent_io;
        // No numeric id: the resolver returns without touching any waiter.
        transport.resolve_response(&json!({"result": {"ok": true}})).await;
    }

    #[tokio::test]
    async fn malformed_frame_ends_the_read_loop() {
        let (client_io, agent_io) = duplex(4096);
        let (read_half, write_half) = split(client_io);
        let (_transport, mut inbound) = Transport::new(read_half, write_half);
        let (agent_read, mut agent_write) = split(agent_io);
        let _keep = agent_read;
        agent_write.write_all(b"this is not json\n").await.unwrap();
        // The read loop stops on the malformed line, closing the channel.
        assert!(inbound.recv().await.is_none());
    }

    #[tokio::test]
    async fn read_loop_stops_when_consumer_drops_receiver() {
        let (client_io, agent_io) = duplex(4096);
        let (read_half, write_half) = split(client_io);
        let (_transport, inbound) = Transport::new(read_half, write_half);
        // Drop the consumer before any frame arrives, so the read loop's send
        // fails on the first frame and it returns.
        drop(inbound);
        let (agent_read, mut agent_write) = split(agent_io);
        let _keep = agent_read;
        agent_write
            .write_all(
                json!({"jsonrpc": "2.0", "method": "session/update", "params": {}})
                    .to_string()
                    .as_bytes(),
            )
            .await
            .unwrap();
        agent_write.write_all(b"\n").await.unwrap();
        // Yield so the read loop is scheduled: it reads the frame, fails to send
        // into the dropped channel, and returns.
        for _ in 0..100 {
            tokio::task::yield_now().await;
        }
    }
}
