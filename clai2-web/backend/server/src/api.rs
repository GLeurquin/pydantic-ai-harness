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
use crate::models::ProfileEdit;

pub type AppState = Arc<AgentManager>;

impl IntoResponse for ManagerError {
    fn into_response(self) -> Response {
        let status = match &self {
            ManagerError::AgentNotFound
            | ManagerError::SessionNotFound
            | ManagerError::ApprovalNotFound
            | ManagerError::ModelNotFound
            | ManagerError::ProjectNotFound
            | ManagerError::FolderNotFound => StatusCode::NOT_FOUND,
            ManagerError::CapReached(_)
            | ManagerError::ModelInUse
            | ManagerError::ProjectInUse
            | ManagerError::Busy => StatusCode::CONFLICT,
            ManagerError::Archived | ManagerError::NoWorktree | ManagerError::Invalid(_) | ManagerError::Github(_) => {
                StatusCode::BAD_REQUEST
            }
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
    #[serde(default)]
    model_profile_id: Option<String>,
    #[serde(default)]
    initial_prompt: Option<String>,
}

#[derive(Deserialize)]
struct CreateProjectBody {
    name: String,
    path: String,
}

#[derive(Deserialize)]
struct CreateFolderBody {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetAgentFolderBody {
    #[serde(default)]
    folder_id: Option<String>,
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
struct SetGoalBody {
    goal: String,
    max_turns: u32,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetModelBody {
    #[serde(default)]
    model_profile_id: Option<String>,
}

#[derive(Deserialize)]
struct GithubTokenBody {
    token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchIssueBody {
    issue_ref: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetCiTrackingBody {
    pr_ref: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPollIntervalBody {
    poll_interval_secs: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitBody {
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestBody {
    title: String,
    body: String,
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
            model_profile_id: body.model_profile_id,
            initial_prompt: body.initial_prompt,
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

async fn list_folders(State(manager): State<AppState>) -> Json<serde_json::Value> {
    Json(json!(manager.list_folders().await))
}

async fn create_folder(
    State(manager): State<AppState>,
    Json(body): Json<CreateFolderBody>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    let folder = manager.add_folder(body.name).await?;
    Ok(Json(json!(folder)))
}

async fn delete_folder(
    State(manager): State<AppState>,
    Path(folder_id): Path<String>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    manager.remove_folder(&folder_id).await?;
    Ok(Json(json!({"ok": true})))
}

async fn set_agent_folder(
    State(manager): State<AppState>,
    Path(agent_id): Path<String>,
    Json(body): Json<SetAgentFolderBody>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.set_agent_folder(&agent_id, body.folder_id).await?)))
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

async fn set_goal(
    State(manager): State<AppState>,
    Path(agent_id): Path<String>,
    Json(body): Json<SetGoalBody>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(
        manager.set_goal(&agent_id, body.goal, body.max_turns).await?
    )))
}

async fn clear_goal(
    State(manager): State<AppState>,
    Path(agent_id): Path<String>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.clear_goal(&agent_id).await?)))
}

async fn set_ci_tracking(
    State(manager): State<AppState>,
    Path(agent_id): Path<String>,
    Json(body): Json<SetCiTrackingBody>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.set_ci_tracking(&agent_id, body.pr_ref).await?)))
}

async fn clear_ci_tracking(
    State(manager): State<AppState>,
    Path(agent_id): Path<String>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.clear_ci_tracking(&agent_id).await?)))
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

async fn debug_context(
    State(manager): State<AppState>,
    Path((agent_id, session_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.debug_context(&agent_id, &session_id).await?)))
}

async fn context_usage(
    State(manager): State<AppState>,
    Path((agent_id, session_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.context_usage(&agent_id, &session_id).await?)))
}

async fn diff(
    State(manager): State<AppState>,
    Path(agent_id): Path<String>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.diff(&agent_id).await?)))
}

async fn commit(
    State(manager): State<AppState>,
    Path(agent_id): Path<String>,
    Json(body): Json<CommitBody>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    manager.commit(&agent_id, &body.message).await?;
    Ok(Json(json!({"ok": true})))
}

async fn open_pull_request(
    State(manager): State<AppState>,
    Path(agent_id): Path<String>,
    Json(body): Json<PullRequestBody>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(
        manager.open_pull_request(&agent_id, &body.title, &body.body).await?
    )))
}

async fn list_models(State(manager): State<AppState>) -> Json<serde_json::Value> {
    Json(json!(manager.list_models().await))
}

async fn create_model(
    State(manager): State<AppState>,
    Json(body): Json<ProfileEdit>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.create_model(body).await?)))
}

async fn update_model(
    State(manager): State<AppState>,
    Path(model_id): Path<String>,
    Json(body): Json<ProfileEdit>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.update_model(&model_id, body).await?)))
}

async fn delete_model(
    State(manager): State<AppState>,
    Path(model_id): Path<String>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    manager.delete_model(&model_id).await?;
    Ok(Json(json!({"ok": true})))
}

async fn github_settings(State(manager): State<AppState>) -> Json<serde_json::Value> {
    Json(json!(manager.github_settings().await))
}

async fn set_github_token(
    State(manager): State<AppState>,
    Json(body): Json<GithubTokenBody>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.set_github_token(body.token).await?)))
}

async fn clear_github_token(State(manager): State<AppState>) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.clear_github_token().await?)))
}

async fn set_github_poll_interval(
    State(manager): State<AppState>,
    Json(body): Json<SetPollIntervalBody>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(
        manager.set_github_poll_interval(body.poll_interval_secs).await?
    )))
}

async fn fetch_github_issue(
    State(manager): State<AppState>,
    Json(body): Json<FetchIssueBody>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    let issue = manager.fetch_github_issue(&body.issue_ref).await?;
    let prompt = crate::github::issue_prompt(&issue);
    Ok(Json(json!({
        "title": issue.title,
        "body": issue.body,
        "url": issue.url,
        "prompt": prompt,
    })))
}

async fn set_agent_model(
    State(manager): State<AppState>,
    Path(agent_id): Path<String>,
    Json(body): Json<SetModelBody>,
) -> Result<Json<serde_json::Value>, ManagerError> {
    Ok(Json(json!(manager.set_model(&agent_id, body.model_profile_id).await?)))
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
        "folders": manager.list_folders().await,
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
        .route(
            "/api/agents/{agent_id}/sessions/{session_id}/debug-context",
            get(debug_context),
        )
        .route(
            "/api/agents/{agent_id}/sessions/{session_id}/context-usage",
            get(context_usage),
        )
        .route("/api/agents/{agent_id}/approval-mode", patch(set_approval_mode))
        .route("/api/agents/{agent_id}/name", patch(rename_agent))
        .route("/api/agents/{agent_id}/goal", post(set_goal).delete(clear_goal))
        .route(
            "/api/agents/{agent_id}/ci-tracking",
            post(set_ci_tracking).delete(clear_ci_tracking),
        )
        .route("/api/agents/{agent_id}/approvals", get(agent_approvals))
        .route("/api/agents/{agent_id}/diff", get(diff))
        .route("/api/agents/{agent_id}/commit", post(commit))
        .route("/api/agents/{agent_id}/pull-request", post(open_pull_request))
        .route("/api/agents/{agent_id}/model", patch(set_agent_model))
        .route("/api/agents/{agent_id}/folder", patch(set_agent_folder))
        .route("/api/approvals", get(all_approvals))
        .route("/api/approvals/{approval_id}", post(resolve_approval))
        .route("/api/models", get(list_models).post(create_model))
        .route("/api/models/{model_id}", patch(update_model).delete(delete_model))
        .route(
            "/api/github",
            get(github_settings).patch(set_github_token).delete(clear_github_token),
        )
        .route("/api/github/issue", post(fetch_github_issue))
        .route("/api/github/poll-interval", patch(set_github_poll_interval))
        .route("/api/projects", get(list_projects).post(create_project))
        .route("/api/projects/{project_id}", delete(delete_project))
        .route("/api/folders", get(list_folders).post(create_folder))
        .route("/api/folders/{folder_id}", delete(delete_folder))
        .route("/api/ws", get(ws_upgrade))
        .with_state(manager)
}
