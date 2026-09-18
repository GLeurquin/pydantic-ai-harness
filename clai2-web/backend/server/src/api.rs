//! REST and WebSocket surface over the agent manager.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::manager::{AgentManager, CreateAgent, ManagerError};
use crate::model::ApprovalMode;

pub type AppState = Arc<AgentManager>;

impl IntoResponse for ManagerError {
    fn into_response(self) -> Response {
        let status = match &self {
            ManagerError::AgentNotFound
            | ManagerError::SessionNotFound
            | ManagerError::ApprovalNotFound
            | ManagerError::ProjectNotFound => StatusCode::NOT_FOUND,
            ManagerError::CapReached(_) | ManagerError::ProjectInUse => StatusCode::CONFLICT,
            ManagerError::Archived | ManagerError::NoWorktree | ManagerError::Invalid(_) => StatusCode::BAD_REQUEST,
            ManagerError::Git(_) | ManagerError::Store(_) | ManagerError::Spawn(_) | ManagerError::Rpc(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        (status, Json(json!({"error": self.to_string()}))).into_response()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAgentBody {
    name: String,
    project_id: String,
    #[serde(default)]
    use_worktree: bool,
    #[serde(default)]
    base_branch: Option<String>,
    approval_mode: ApprovalMode,
}

#[derive(Deserialize)]
struct CreateProjectBody {
    name: String,
    path: String,
}

#[derive(Deserialize)]
struct PromptBody {
    text: String,
}

#[derive(Deserialize)]
struct ForkBody {
    name: String,
}

#[derive(Deserialize)]
struct SideSessionBody {
    label: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalModeBody {
    approval_mode: ApprovalMode,
}

#[derive(Deserialize)]
struct RenameAgentBody {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveApprovalBody {
    option_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveQuery {
    #[serde(default)]
    remove_worktree: bool,
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({"ok": true}))
}

async fn list_agents(State(manager): State<AppState>) -> Json<serde_json::Value> {
    Json(json!(manager.snapshot().await))
}

async fn create_agent(
    State(manager): State<AppState>,
    Json(body): Json<CreateAgentBody>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    let agent = manager
        .create_agent(CreateAgent {
            name: body.name,
            project_id: body.project_id,
            use_worktree: body.use_worktree,
            base_branch: body.base_branch,
            approval_mode: body.approval_mode,
        })
        .await?;
    Ok(Json(json!(agent)))
}

async fn list_projects(State(manager): State<AppState>) -> Json<serde_json::Value> {
    Json(json!(manager.list_projects().await))
}

async fn create_project(
    State(manager): State<AppState>,
    Json(body): Json<CreateProjectBody>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    let project = manager.add_project(body.name, PathBuf::from(body.path)).await?;
    Ok(Json(json!(project)))
}

async fn delete_project(
    State(manager): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    manager.remove_project(&project_id).await?;
    Ok(Json(json!({"ok": true})))
}

async fn get_agent(
    State(manager): State<AppState>,
    Path(agent_id): Path<String>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.agent(&agent_id).await?)))
}

async fn archive_agent(
    State(manager): State<AppState>,
    Path(agent_id): Path<String>,
    Query(query): Query<ArchiveQuery>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.archive(&agent_id, query.remove_worktree).await?)))
}

async fn prompt_session(
    State(manager): State<AppState>,
    Path((agent_id, session_id)): Path<(String, String)>,
    Json(body): Json<PromptBody>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    manager.prompt(&agent_id, &session_id, body.text).await?;
    Ok(Json(json!({"ok": true})))
}

async fn cancel_agent(
    State(manager): State<AppState>,
    Path(agent_id): Path<String>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    manager.cancel(&agent_id).await?;
    Ok(Json(json!({"ok": true})))
}

async fn fork_agent(
    State(manager): State<AppState>,
    Path(agent_id): Path<String>,
    Json(body): Json<ForkBody>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.fork(&agent_id, body.name).await?)))
}

async fn open_side_session(
    State(manager): State<AppState>,
    Path(agent_id): Path<String>,
    Json(body): Json<SideSessionBody>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.open_side_session(&agent_id, body.label).await?)))
}

async fn set_approval_mode(
    State(manager): State<AppState>,
    Path(agent_id): Path<String>,
    Json(body): Json<ApprovalModeBody>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(
        manager.set_approval_mode(&agent_id, body.approval_mode).await?
    )))
}

async fn rename_agent(
    State(manager): State<AppState>,
    Path(agent_id): Path<String>,
    Json(body): Json<RenameAgentBody>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.rename_agent(&agent_id, body.name).await?)))
}

async fn agent_approvals(
    State(manager): State<AppState>,
    Path(agent_id): Path<String>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.pending_approvals_for(&agent_id).await?)))
}

async fn all_approvals(State(manager): State<AppState>) -> Json<serde_json::Value> {
    Json(json!(manager.pending_approvals().await))
}

async fn resolve_approval(
    State(manager): State<AppState>,
    Path(approval_id): Path<String>,
    Json(body): Json<ResolveApprovalBody>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    manager.resolve_approval(&approval_id, body.option_id).await?;
    Ok(Json(json!({"ok": true})))
}

async fn transcript(
    State(manager): State<AppState>,
    Path((agent_id, session_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.transcript(&agent_id, &session_id).await?)))
}

async fn diff(
    State(manager): State<AppState>,
    Path(agent_id): Path<String>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.diff(&agent_id).await?)))
}

async fn ws_upgrade(State(manager): State<AppState>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| ws_connection(socket, manager))
}

/// Send a full snapshot, then stream events. A subscriber that lags behind
/// the broadcast buffer is disconnected; the client reconnects and gets a
/// fresh snapshot.
async fn ws_connection(mut socket: WebSocket, manager: AppState) {
    let mut receiver = manager.hub().subscribe();
    let snapshot = json!({
        "type": "snapshot",
        "agents": manager.snapshot().await,
        "approvals": manager.pending_approvals().await,
        "projects": manager.list_projects().await,
        "maxAgents": manager.max_agents(),
    });
    if socket.send(Message::Text(snapshot.to_string().into())).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            event = receiver.recv() => {
                let Ok(event) = event else { break };
                let Ok(text) = serde_json::to_string(&event) else { break };
                if socket.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                }
            }
        }
    }
}

pub fn build_router(manager: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/agents", get(list_agents).post(create_agent))
        .route("/api/agents/{agent_id}", get(get_agent).delete(archive_agent))
        .route("/api/agents/{agent_id}/cancel", post(cancel_agent))
        .route("/api/agents/{agent_id}/fork", post(fork_agent))
        .route("/api/agents/{agent_id}/sessions", post(open_side_session))
        .route(
            "/api/agents/{agent_id}/sessions/{session_id}/prompt",
            post(prompt_session),
        )
        .route(
            "/api/agents/{agent_id}/sessions/{session_id}/transcript",
            get(transcript),
        )
        .route("/api/agents/{agent_id}/approval-mode", patch(set_approval_mode))
        .route("/api/agents/{agent_id}/name", patch(rename_agent))
        .route("/api/agents/{agent_id}/approvals", get(agent_approvals))
        .route("/api/agents/{agent_id}/diff", get(diff))
        .route("/api/approvals", get(all_approvals))
        .route("/api/approvals/{approval_id}", post(resolve_approval))
        .route("/api/projects", get(list_projects).post(create_project))
        .route("/api/projects/{project_id}", delete(delete_project))
        .route("/api/ws", get(ws_upgrade))
        .with_state(manager)
}
