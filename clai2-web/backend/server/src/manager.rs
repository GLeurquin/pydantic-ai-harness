//! Agent lifecycle orchestration: registry, processes, sessions, approvals.
//!
//! All registry mutation happens behind one async mutex; protocol IO and git
//! subprocesses run outside the lock. Long-running work (prompt turns,
//! parked-approval waits) lives in spawned tasks tied to the owning agent.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex;
use uuid::Uuid;

use crate::acp::client::SpawnError;
use crate::acp::transport::RpcError;
use crate::acp::{AcpClient, AcpEvent, PermissionRequest, SessionUpdate};
use crate::approvals::{decide, ApprovalLedger, ApprovalOutcome, PolicyDecision};
use crate::events::{Event, EventHub};
use crate::model::{
    AgentStatus, AgentSummary, ApprovalMode, ApprovalView, ProjectSummary, SessionSummary, StopReason, ToolCallView,
    TranscriptItem,
};
use crate::models::{ModelProfile, ProfileEdit, RedactedProfile};
use crate::store::{PersistedAgent, Store, StoreError};
use crate::worktrees::{slugify, GitError, WorktreeDiff, WorktreeService};

#[derive(Debug, thiserror::Error)]
pub enum ManagerError {
    #[error("agent not found")]
    AgentNotFound,
    #[error("session not found")]
    SessionNotFound,
    #[error("approval not found")]
    ApprovalNotFound,
    #[error("agent is archived")]
    Archived,
    #[error("agent limit reached ({0})")]
    CapReached(usize),
    #[error("agent has no worktree")]
    NoWorktree,
    #[error("model profile not found")]
    ModelNotFound,
    #[error("model profile is in use by an agent")]
    ModelInUse,
    #[error("agent is busy")]
    Busy,
    #[error("project not found")]
    ProjectNotFound,
    #[error("project is in use by a live agent")]
    ProjectInUse,
    #[error("invalid request: {0}")]
    Invalid(String),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Spawn(#[from] SpawnError),
    #[error(transparent)]
    Rpc(#[from] RpcError),
}

#[derive(Debug, Clone)]
pub struct ManagerConfig {
    /// Repository bootstrapped as the default project on first start. Ignored
    /// on later starts once the project registry is non-empty.
    pub repo_root: PathBuf,
    pub worktrees_dir: PathBuf,
    pub data_dir: PathBuf,
    /// argv used to spawn agent processes.
    pub agent_command: Vec<String>,
    pub max_agents: usize,
}

#[derive(Debug, Clone)]
pub struct CreateAgent {
    pub name: String,
    pub project_id: String,
    pub use_worktree: bool,
    pub base_branch: Option<String>,
    pub approval_mode: ApprovalMode,
    pub model_profile_id: Option<String>,
}

struct Runtime {
    client: Arc<AcpClient>,
}

struct AgentEntry {
    summary: AgentSummary,
    command: Vec<String>,
    runtime: Option<Runtime>,
    active_turns: u32,
    /// Merged tool-call state, keyed by `<session id>/<tool call id>`.
    tool_calls: HashMap<String, ToolCallView>,
    /// Sessions whose next prompt must carry a history preamble (fork or
    /// backend restart re-attached them to a fresh agent process).
    needs_replay: HashSet<String>,
}

impl AgentEntry {
    fn recompute_status(&mut self) {
        if matches!(self.summary.status, AgentStatus::Archived | AgentStatus::Error) {
            return;
        }
        self.summary.status = if self.summary.pending_approvals > 0 {
            AgentStatus::WaitingApproval
        } else if self.active_turns > 0 {
            AgentStatus::Working
        } else {
            AgentStatus::Idle
        };
    }

    fn session(&self, session_id: &str) -> Option<&SessionSummary> {
        self.summary.sessions.iter().find(|session| session.id == session_id)
    }

    fn session_by_acp(&self, acp_session_id: &str) -> Option<&SessionSummary> {
        self.summary
            .sessions
            .iter()
            .find(|session| session.acp_session_id.as_deref() == Some(acp_session_id))
    }
}

pub struct AgentManager {
    config: ManagerConfig,
    worktrees: WorktreeService,
    store: Store,
    hub: EventHub,
    ledger: Arc<ApprovalLedger>,
    agents: Mutex<Vec<AgentEntry>>,
    models: Mutex<Vec<ModelProfile>>,
    projects: Mutex<Vec<ProjectSummary>>,
    /// Serializes process spawns and ACP session opens, so two concurrent
    /// prompts cannot double-spawn an agent or double-open a session.
    spawn_lock: Mutex<()>,
}

/// Cap applied to the history preamble a fork or restored session sends.
const MAX_PREAMBLE_CHARS: usize = 16_000;

/// Build the first-prompt preamble that hands a new agent process the
/// conversation so far.
pub fn history_preamble(items: &[TranscriptItem]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut assistant_run = String::new();
    for item in items {
        match item {
            TranscriptItem::UserMessage { text } => {
                if !assistant_run.is_empty() {
                    lines.push(format!("Assistant: {assistant_run}"));
                    assistant_run.clear();
                }
                lines.push(format!("User: {text}"));
            }
            TranscriptItem::MessageChunk { text } => assistant_run.push_str(text),
            _ => {}
        }
    }
    if !assistant_run.is_empty() {
        lines.push(format!("Assistant: {assistant_run}"));
    }
    if lines.is_empty() {
        return String::new();
    }
    let mut body = lines.join("\n");
    if body.len() > MAX_PREAMBLE_CHARS {
        let cut = body.len() - MAX_PREAMBLE_CHARS;
        let boundary = body
            .char_indices()
            .map(|(index, _)| index)
            .find(|index| *index >= cut)
            .unwrap_or(0);
        body = body.split_off(boundary);
    }
    format!(
        "<conversation-history>\nThis conversation continues an earlier one. Prior messages:\n{body}\n</conversation-history>\n\n"
    )
}

/// Display name for a project bootstrapped from a repo path: its final
/// component, or the whole path when it has none (e.g. `/`).
fn default_project_name(repo_root: &std::path::Path) -> String {
    repo_root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| repo_root.to_string_lossy().into_owned())
}

impl AgentManager {
    pub async fn new(config: ManagerConfig) -> Result<Arc<Self>, ManagerError> {
        let store = Store::new(config.data_dir.clone());
        let worktrees = WorktreeService::new(config.worktrees_dir.clone());
        let mut projects = store.load_projects().await?;
        if projects.is_empty() {
            let bootstrap = ProjectSummary {
                id: Uuid::new_v4().to_string(),
                name: default_project_name(&config.repo_root),
                repo_root: config.repo_root.clone(),
            };
            store.save_projects(std::slice::from_ref(&bootstrap)).await?;
            projects.push(bootstrap);
        }
        let persisted = store.load_roster().await?;
        let models = store.load_models().await?;
        // Roster files predating the project registry have no project_id
        // (defaults to empty on deserialize); backfill them to the bootstrap
        // default project rather than leaving them pointing nowhere.
        let default_project_id = projects[0].id.clone();
        let mut migrated = false;
        let agents: Vec<AgentEntry> = persisted
            .into_iter()
            .map(|agent| {
                let mut summary = agent.summary;
                if summary.project_id.is_empty() {
                    summary.project_id = default_project_id.clone();
                    migrated = true;
                }
                if !matches!(summary.status, AgentStatus::Archived) {
                    summary.status = AgentStatus::Idle;
                }
                summary.pending_approvals = 0;
                let needs_replay = summary.sessions.iter().map(|session| session.id.clone()).collect();
                for session in &mut summary.sessions {
                    session.acp_session_id = None;
                }
                AgentEntry {
                    summary,
                    command: agent.command,
                    runtime: None,
                    active_turns: 0,
                    tool_calls: HashMap::new(),
                    needs_replay,
                }
            })
            .collect();
        if migrated {
            let persisted: Vec<PersistedAgent> = agents
                .iter()
                .map(|entry| PersistedAgent {
                    summary: entry.summary.clone(),
                    command: entry.command.clone(),
                })
                .collect();
            store.save_roster(&persisted).await?;
        }
        Ok(Arc::new(Self {
            config,
            worktrees,
            store,
            hub: EventHub::new(),
            ledger: Arc::new(ApprovalLedger::default()),
            agents: Mutex::new(agents),
            models: Mutex::new(models),
            projects: Mutex::new(projects),
            spawn_lock: Mutex::new(()),
        }))
    }

    pub fn hub(&self) -> &EventHub {
        &self.hub
    }

    /// The concurrent-agent cap this server was configured with.
    pub fn max_agents(&self) -> usize {
        self.config.max_agents
    }

    pub async fn snapshot(&self) -> Vec<AgentSummary> {
        self.agents
            .lock()
            .await
            .iter()
            .map(|entry| entry.summary.clone())
            .collect()
    }

    pub async fn agent(&self, agent_id: &str) -> Result<AgentSummary, ManagerError> {
        let agents = self.agents.lock().await;
        agents
            .iter()
            .find(|entry| entry.summary.id == agent_id)
            .map(|entry| entry.summary.clone())
            .ok_or(ManagerError::AgentNotFound)
    }

    pub async fn list_projects(&self) -> Vec<ProjectSummary> {
        self.projects.lock().await.clone()
    }

    async fn project(&self, project_id: &str) -> Result<ProjectSummary, ManagerError> {
        self.projects
            .lock()
            .await
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
            .ok_or(ManagerError::ProjectNotFound)
    }

    async fn persist_projects(&self) -> Result<(), ManagerError> {
        let projects = self.projects.lock().await.clone();
        self.store.save_projects(&projects).await?;
        Ok(())
    }

    /// Register a project: a repository agents can be created in. `repo_root`
    /// must be an absolute path to an existing directory.
    pub async fn add_project(&self, name: String, repo_root: PathBuf) -> Result<ProjectSummary, ManagerError> {
        let name = name.trim().to_owned();
        if name.is_empty() {
            return Err(ManagerError::Invalid("project name must not be empty".to_owned()));
        }
        if !repo_root.is_absolute() {
            return Err(ManagerError::Invalid(format!(
                "project path must be absolute: {}",
                repo_root.display()
            )));
        }
        let metadata = tokio::fs::metadata(&repo_root)
            .await
            .map_err(|_err| ManagerError::Invalid(format!("path does not exist: {}", repo_root.display())))?;
        if !metadata.is_dir() {
            return Err(ManagerError::Invalid(format!(
                "path is not a directory: {}",
                repo_root.display()
            )));
        }
        let project = ProjectSummary {
            id: Uuid::new_v4().to_string(),
            name,
            repo_root,
        };
        {
            let mut projects = self.projects.lock().await;
            projects.push(project.clone());
        }
        self.persist_projects().await?;
        self.hub.publish(Event::ProjectAdded {
            project: project.clone(),
        });
        Ok(project)
    }

    /// Remove a project. Rejected while a non-archived agent still belongs to
    /// it, so a live agent never loses the project it reports.
    pub async fn remove_project(&self, project_id: &str) -> Result<(), ManagerError> {
        {
            let agents = self.agents.lock().await;
            let in_use = agents.iter().any(|entry| {
                entry.summary.project_id == project_id && !matches!(entry.summary.status, AgentStatus::Archived)
            });
            if in_use {
                return Err(ManagerError::ProjectInUse);
            }
        }
        let removed = {
            let mut projects = self.projects.lock().await;
            let before = projects.len();
            projects.retain(|project| project.id != project_id);
            before != projects.len()
        };
        if !removed {
            return Err(ManagerError::ProjectNotFound);
        }
        self.persist_projects().await?;
        self.hub.publish(Event::ProjectRemoved {
            project_id: project_id.to_owned(),
        });
        Ok(())
    }

    async fn persist_roster(&self) -> Result<(), ManagerError> {
        let persisted: Vec<PersistedAgent> = {
            let agents = self.agents.lock().await;
            agents
                .iter()
                .map(|entry| PersistedAgent {
                    summary: entry.summary.clone(),
                    command: entry.command.clone(),
                })
                .collect()
        };
        self.store.save_roster(&persisted).await?;
        Ok(())
    }

    async fn publish_agent(&self, agent_id: &str) {
        let summary = {
            let agents = self.agents.lock().await;
            agents
                .iter()
                .find(|entry| entry.summary.id == agent_id)
                .map(|entry| entry.summary.clone())
        };
        if let Some(agent) = summary {
            self.hub.publish(Event::AgentUpdated { agent });
        }
    }

    /// Create an agent, its worktree (when requested), and its process.
    pub async fn create_agent(self: &Arc<Self>, request: CreateAgent) -> Result<AgentSummary, ManagerError> {
        let name = request.name.trim().to_owned();
        if name.is_empty() {
            return Err(ManagerError::Invalid("agent name must not be empty".to_owned()));
        }
        let project = self.project(&request.project_id).await?;
        {
            let agents = self.agents.lock().await;
            let live = agents
                .iter()
                .filter(|entry| !matches!(entry.summary.status, AgentStatus::Archived))
                .count();
            if live >= self.config.max_agents {
                return Err(ManagerError::CapReached(self.config.max_agents));
            }
        }
        let model_label = self.resolve_model_label(request.model_profile_id.as_deref()).await?;
        let agent_id = Uuid::new_v4().to_string();
        let unique_slug = format!("{}-{}", slugify(&name), &agent_id[..8]);
        let worktree = if request.use_worktree {
            let base_branch = match request.base_branch {
                Some(branch) if !branch.trim().is_empty() => branch,
                _ => self.worktrees.current_branch(&project.repo_root).await?,
            };
            Some(
                self.worktrees
                    .create(&project.repo_root, &base_branch, &unique_slug)
                    .await?,
            )
        } else {
            None
        };
        let cwd = worktree
            .as_ref()
            .map(|worktree| worktree.path.clone())
            .unwrap_or_else(|| project.repo_root.clone());
        let summary = AgentSummary {
            id: agent_id.clone(),
            name,
            project_id: project.id,
            status: AgentStatus::Starting,
            approval_mode: request.approval_mode,
            worktree,
            cwd,
            sessions: vec![SessionSummary {
                id: "main".to_owned(),
                acp_session_id: None,
                label: "Conversation".to_owned(),
                is_main: true,
            }],
            pending_approvals: 0,
            forked_from: None,
            model_profile_id: request.model_profile_id,
            model_label,
            last_error: None,
        };
        self.finish_creation(summary, None).await
    }

    /// Look up a model profile's label, erroring if the id is unknown.
    async fn resolve_model_label(&self, model_profile_id: Option<&str>) -> Result<Option<String>, ManagerError> {
        let Some(id) = model_profile_id else {
            return Ok(None);
        };
        let models = self.models.lock().await;
        models
            .iter()
            .find(|profile| profile.id == id)
            .map(|profile| Some(profile.label.clone()))
            .ok_or(ManagerError::ModelNotFound)
    }

    /// Compute the spawn environment for an agent from its model profile,
    /// writing a Vertex credentials file when the profile carries one.
    async fn spawn_env(
        &self,
        agent_id: &str,
        model_profile_id: Option<&str>,
    ) -> Result<Vec<(String, String)>, ManagerError> {
        let Some(id) = model_profile_id else {
            return Ok(Vec::new());
        };
        let profile = {
            let models = self.models.lock().await;
            models.iter().find(|profile| profile.id == id).cloned()
        };
        let Some(profile) = profile else {
            // The profile was deleted after the agent referenced it; run with
            // no overlay rather than refusing to start.
            return Ok(Vec::new());
        };
        let mut env = profile.base_env();
        if let Some(credentials) = profile.credentials() {
            let path = self.store.write_credentials(agent_id, credentials).await?;
            env.push((
                "GOOGLE_APPLICATION_CREDENTIALS".to_owned(),
                path.to_string_lossy().into_owned(),
            ));
        }
        Ok(env)
    }

    /// Shared tail of create and fork: register, spawn, persist, announce.
    async fn finish_creation(
        self: &Arc<Self>,
        summary: AgentSummary,
        needs_replay: Option<HashSet<String>>,
    ) -> Result<AgentSummary, ManagerError> {
        let agent_id = summary.id.clone();
        {
            let mut agents = self.agents.lock().await;
            agents.push(AgentEntry {
                summary: summary.clone(),
                command: self.config.agent_command.clone(),
                runtime: None,
                active_turns: 0,
                tool_calls: HashMap::new(),
                needs_replay: needs_replay.unwrap_or_default(),
            });
        }
        self.hub.publish(Event::AgentAdded { agent: summary });
        match self.ensure_running(&agent_id).await {
            Ok(()) => {
                let mut agents = self.agents.lock().await;
                if let Some(entry) = agents.iter_mut().find(|entry| entry.summary.id == agent_id) {
                    entry.summary.status = AgentStatus::Idle;
                }
            }
            Err(err) => {
                self.mark_error(&agent_id, &err.to_string()).await;
            }
        }
        self.publish_agent(&agent_id).await;
        self.persist_roster().await?;
        self.agent(&agent_id).await
    }

    async fn mark_error(&self, agent_id: &str, message: &str) {
        {
            let mut agents = self.agents.lock().await;
            if let Some(entry) = agents.iter_mut().find(|entry| entry.summary.id == agent_id) {
                if !matches!(entry.summary.status, AgentStatus::Archived) {
                    entry.summary.status = AgentStatus::Error;
                    entry.summary.last_error = Some(message.to_owned());
                }
            }
        }
        self.hub.publish(Event::AgentError {
            agent_id: agent_id.to_owned(),
            message: message.to_owned(),
        });
        self.publish_agent(agent_id).await;
    }

    /// Spawn the agent process if it is not running, and initialize ACP.
    async fn ensure_running(self: &Arc<Self>, agent_id: &str) -> Result<(), ManagerError> {
        let _spawn_guard = self.spawn_lock.lock().await;
        let (command, cwd, model_profile_id, already_running) = {
            let agents = self.agents.lock().await;
            let entry = agents
                .iter()
                .find(|entry| entry.summary.id == agent_id)
                .ok_or(ManagerError::AgentNotFound)?;
            if matches!(entry.summary.status, AgentStatus::Archived) {
                return Err(ManagerError::Archived);
            }
            (
                entry.command.clone(),
                entry.summary.cwd.clone(),
                entry.summary.model_profile_id.clone(),
                entry.runtime.is_some(),
            )
        };
        if already_running {
            return Ok(());
        }
        let env = self.spawn_env(agent_id, model_profile_id.as_deref()).await?;
        let (client, mut events) = AcpClient::spawn(&command, &cwd, &env)?;
        // The pump must run before `initialize`: it is the single consumer of
        // the ordered event stream, and responses resolve through it.
        let manager = Arc::clone(self);
        let pump_agent_id = agent_id.to_owned();
        let pump_client = Arc::clone(&client);
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    AcpEvent::Response(frame) => pump_client.resolve_response(&frame).await,
                    AcpEvent::Closed => {
                        pump_client.fail_all().await;
                        manager.handle_acp_event(&pump_agent_id, AcpEvent::Closed).await;
                    }
                    other => manager.handle_acp_event(&pump_agent_id, other).await,
                }
            }
        });
        client.initialize().await?;
        {
            let mut agents = self.agents.lock().await;
            let entry = agents
                .iter_mut()
                .find(|entry| entry.summary.id == agent_id)
                .ok_or(ManagerError::AgentNotFound)?;
            entry.runtime = Some(Runtime {
                client: Arc::clone(&client),
            });
            // Any previously opened ACP sessions died with the old process.
            for session in &mut entry.summary.sessions {
                session.acp_session_id = None;
            }
        }
        Ok(())
    }

    /// Open the ACP session backing `session_id` if it is not open yet.
    async fn ensure_session(&self, agent_id: &str, session_id: &str) -> Result<(Arc<AcpClient>, String), ManagerError> {
        let _spawn_guard = self.spawn_lock.lock().await;
        let (client, cwd, existing) = {
            let agents = self.agents.lock().await;
            let entry = agents
                .iter()
                .find(|entry| entry.summary.id == agent_id)
                .ok_or(ManagerError::AgentNotFound)?;
            let session = entry.session(session_id).ok_or(ManagerError::SessionNotFound)?;
            let runtime = entry.runtime.as_ref().ok_or(ManagerError::AgentNotFound)?;
            (
                Arc::clone(&runtime.client),
                entry.summary.cwd.clone(),
                session.acp_session_id.clone(),
            )
        };
        if let Some(acp_session_id) = existing {
            return Ok((client, acp_session_id));
        }
        let acp_session_id = client.new_session(&cwd).await?;
        let mut agents = self.agents.lock().await;
        let entry = agents
            .iter_mut()
            .find(|entry| entry.summary.id == agent_id)
            .ok_or(ManagerError::AgentNotFound)?;
        let session = entry
            .summary
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or(ManagerError::SessionNotFound)?;
        session.acp_session_id = Some(acp_session_id.clone());
        Ok((client, acp_session_id))
    }

    /// Send a prompt on a session. Returns once the turn has started; the
    /// turn itself runs in a spawned task and reports through events.
    pub async fn prompt(self: &Arc<Self>, agent_id: &str, session_id: &str, text: String) -> Result<(), ManagerError> {
        {
            let agents = self.agents.lock().await;
            let entry = agents
                .iter()
                .find(|entry| entry.summary.id == agent_id)
                .ok_or(ManagerError::AgentNotFound)?;
            if matches!(entry.summary.status, AgentStatus::Archived) {
                return Err(ManagerError::Archived);
            }
            entry.session(session_id).ok_or(ManagerError::SessionNotFound)?;
        }
        self.ensure_running(agent_id).await?;
        let (client, acp_session_id) = self.ensure_session(agent_id, session_id).await?;

        let needs_replay = {
            let mut agents = self.agents.lock().await;
            let entry = agents
                .iter_mut()
                .find(|entry| entry.summary.id == agent_id)
                .ok_or(ManagerError::AgentNotFound)?;
            entry.needs_replay.remove(session_id)
        };
        let wire_text = if needs_replay {
            let history = self.store.load_transcript(agent_id, session_id).await?;
            format!("{}{}", history_preamble(&history), text)
        } else {
            text.clone()
        };

        {
            let mut agents = self.agents.lock().await;
            let entry = agents
                .iter_mut()
                .find(|entry| entry.summary.id == agent_id)
                .ok_or(ManagerError::AgentNotFound)?;
            entry.active_turns += 1;
            entry.summary.last_error = None;
            if matches!(entry.summary.status, AgentStatus::Error) {
                entry.summary.status = AgentStatus::Idle;
            }
            entry.recompute_status();
        }
        self.publish_agent(agent_id).await;
        self.record(
            agent_id,
            session_id,
            TranscriptItem::UserMessage { text: text.clone() },
            Event::UserMessage {
                agent_id: agent_id.to_owned(),
                session_id: session_id.to_owned(),
                text,
            },
        )
        .await;

        let manager = Arc::clone(self);
        let agent_id = agent_id.to_owned();
        let session_id = session_id.to_owned();
        tokio::spawn(async move {
            let result = client.prompt(&acp_session_id, &wire_text).await;
            {
                let mut agents = manager.agents.lock().await;
                if let Some(entry) = agents.iter_mut().find(|entry| entry.summary.id == agent_id) {
                    entry.active_turns = entry.active_turns.saturating_sub(1);
                    entry.recompute_status();
                }
            }
            match result {
                Ok(stop_reason) => {
                    manager
                        .record(
                            &agent_id,
                            &session_id,
                            TranscriptItem::TurnEnded { stop_reason },
                            Event::TurnEnded {
                                agent_id: agent_id.clone(),
                                session_id: session_id.clone(),
                                stop_reason,
                            },
                        )
                        .await;
                    manager.publish_agent(&agent_id).await;
                }
                Err(err) => {
                    let message = err.to_string();
                    manager
                        .record(
                            &agent_id,
                            &session_id,
                            TranscriptItem::Error {
                                message: message.clone(),
                            },
                            Event::TurnEnded {
                                agent_id: agent_id.clone(),
                                session_id: session_id.clone(),
                                stop_reason: StopReason::Cancelled,
                            },
                        )
                        .await;
                    manager.mark_error(&agent_id, &message).await;
                }
            }
        });
        Ok(())
    }

    /// Persist a transcript item and publish its event.
    async fn record(&self, agent_id: &str, session_id: &str, item: TranscriptItem, event: Event) {
        if let Err(err) = self.store.append_transcript(agent_id, session_id, &item).await {
            tracing::warn!(agent_id, session_id, error = %err, "failed to persist transcript item");
        }
        self.hub.publish(event);
    }

    /// Cancel in-flight turns on every session of the agent, and resolve its
    /// parked approvals as cancelled.
    pub async fn cancel(&self, agent_id: &str) -> Result<(), ManagerError> {
        let (client, acp_sessions) = {
            let agents = self.agents.lock().await;
            let entry = agents
                .iter()
                .find(|entry| entry.summary.id == agent_id)
                .ok_or(ManagerError::AgentNotFound)?;
            let client = entry.runtime.as_ref().map(|runtime| Arc::clone(&runtime.client));
            let sessions: Vec<String> = entry
                .summary
                .sessions
                .iter()
                .filter_map(|session| session.acp_session_id.clone())
                .collect();
            (client, sessions)
        };
        let cancelled = self.ledger.cancel_for_agent(agent_id).await;
        for approval in &cancelled {
            self.hub.publish(Event::ApprovalResolved {
                approval_id: approval.id.clone(),
                agent_id: agent_id.to_owned(),
                option_id: None,
            });
        }
        if !cancelled.is_empty() {
            let mut agents = self.agents.lock().await;
            if let Some(entry) = agents.iter_mut().find(|entry| entry.summary.id == agent_id) {
                entry.summary.pending_approvals = 0;
                entry.recompute_status();
            }
        }
        if let Some(client) = client {
            for acp_session_id in acp_sessions {
                client.cancel(&acp_session_id).await?;
            }
        }
        self.publish_agent(agent_id).await;
        Ok(())
    }

    /// Open a side conversation: one more ACP session on the same process.
    pub async fn open_side_session(
        self: &Arc<Self>,
        agent_id: &str,
        label: String,
    ) -> Result<AgentSummary, ManagerError> {
        let label = label.trim().to_owned();
        if label.is_empty() {
            return Err(ManagerError::Invalid("session label must not be empty".to_owned()));
        }
        let session_id = {
            let mut agents = self.agents.lock().await;
            let entry = agents
                .iter_mut()
                .find(|entry| entry.summary.id == agent_id)
                .ok_or(ManagerError::AgentNotFound)?;
            if matches!(entry.summary.status, AgentStatus::Archived) {
                return Err(ManagerError::Archived);
            }
            let session_id = format!("side-{}", &Uuid::new_v4().to_string()[..8]);
            entry.summary.sessions.push(SessionSummary {
                id: session_id.clone(),
                acp_session_id: None,
                label,
                is_main: false,
            });
            session_id
        };
        self.ensure_running(agent_id).await?;
        self.ensure_session(agent_id, &session_id).await?;
        self.publish_agent(agent_id).await;
        self.persist_roster().await?;
        self.agent(agent_id).await
    }

    /// Fork an agent: new worktree cut from the parent's, transcript copied,
    /// history replayed on the fork's first prompt.
    pub async fn fork(self: &Arc<Self>, parent_id: &str, name: String) -> Result<AgentSummary, ManagerError> {
        let name = name.trim().to_owned();
        if name.is_empty() {
            return Err(ManagerError::Invalid("agent name must not be empty".to_owned()));
        }
        let (parent_summary, live) = {
            let agents = self.agents.lock().await;
            let live = agents
                .iter()
                .filter(|entry| !matches!(entry.summary.status, AgentStatus::Archived))
                .count();
            let entry = agents
                .iter()
                .find(|entry| entry.summary.id == parent_id)
                .ok_or(ManagerError::AgentNotFound)?;
            (entry.summary.clone(), live)
        };
        if live >= self.config.max_agents {
            return Err(ManagerError::CapReached(self.config.max_agents));
        }
        let agent_id = Uuid::new_v4().to_string();
        let unique_slug = format!("{}-{}", slugify(&name), &agent_id[..8]);
        let worktree = match &parent_summary.worktree {
            Some(parent_worktree) => Some(self.worktrees.fork(parent_worktree, &unique_slug).await?),
            None => None,
        };
        let cwd = worktree
            .as_ref()
            .map(|worktree| worktree.path.clone())
            .unwrap_or_else(|| parent_summary.cwd.clone());

        let history = self.store.load_transcript(parent_id, "main").await?;
        for item in &history {
            self.store.append_transcript(&agent_id, "main", item).await?;
        }

        let summary = AgentSummary {
            id: agent_id.clone(),
            name,
            project_id: parent_summary.project_id,
            status: AgentStatus::Starting,
            approval_mode: parent_summary.approval_mode,
            worktree,
            cwd,
            sessions: vec![SessionSummary {
                id: "main".to_owned(),
                acp_session_id: None,
                label: "Conversation".to_owned(),
                is_main: true,
            }],
            pending_approvals: 0,
            forked_from: Some(parent_id.to_owned()),
            model_profile_id: parent_summary.model_profile_id.clone(),
            model_label: parent_summary.model_label.clone(),
            last_error: None,
        };
        let mut needs_replay = HashSet::new();
        needs_replay.insert("main".to_owned());
        self.finish_creation(summary, Some(needs_replay)).await
    }

    /// Model profiles, with secrets removed, for the config UI.
    pub async fn list_models(&self) -> Vec<RedactedProfile> {
        let models = self.models.lock().await;
        models.iter().map(ModelProfile::redacted).collect()
    }

    pub async fn create_model(&self, edit: ProfileEdit) -> Result<RedactedProfile, ManagerError> {
        edit.validate().map_err(ManagerError::Invalid)?;
        let profile = edit.into_profile(Uuid::new_v4().to_string());
        let redacted = profile.redacted();
        {
            let mut models = self.models.lock().await;
            models.push(profile);
            self.store.save_models(&models).await?;
        }
        Ok(redacted)
    }

    pub async fn update_model(&self, model_id: &str, edit: ProfileEdit) -> Result<RedactedProfile, ManagerError> {
        edit.validate().map_err(ManagerError::Invalid)?;
        let (redacted, new_label) = {
            let mut models = self.models.lock().await;
            let profile = models
                .iter_mut()
                .find(|profile| profile.id == model_id)
                .ok_or(ManagerError::ModelNotFound)?;
            profile.apply_edit(edit);
            let redacted = profile.redacted();
            let label = profile.label.clone();
            self.store.save_models(&models).await?;
            (redacted, label)
        };
        // Refresh the snapshotted label on any agent using this profile.
        let mut touched = Vec::new();
        {
            let mut agents = self.agents.lock().await;
            for entry in agents.iter_mut() {
                if entry.summary.model_profile_id.as_deref() == Some(model_id) {
                    entry.summary.model_label = Some(new_label.clone());
                    touched.push(entry.summary.id.clone());
                }
            }
        }
        for agent_id in touched {
            self.publish_agent(&agent_id).await;
        }
        self.persist_roster().await?;
        Ok(redacted)
    }

    pub async fn delete_model(&self, model_id: &str) -> Result<(), ManagerError> {
        {
            let agents = self.agents.lock().await;
            if agents.iter().any(|entry| {
                entry.summary.model_profile_id.as_deref() == Some(model_id)
                    && !matches!(entry.summary.status, AgentStatus::Archived)
            }) {
                return Err(ManagerError::ModelInUse);
            }
        }
        let mut models = self.models.lock().await;
        let before = models.len();
        models.retain(|profile| profile.id != model_id);
        if models.len() == before {
            return Err(ManagerError::ModelNotFound);
        }
        self.store.save_models(&models).await?;
        Ok(())
    }

    /// Switch an idle agent's model profile. The change restarts the agent
    /// process so the new provider environment takes effect; the conversation
    /// is replayed to the fresh process on the next prompt.
    pub async fn set_model(
        self: &Arc<Self>,
        agent_id: &str,
        model_profile_id: Option<String>,
    ) -> Result<AgentSummary, ManagerError> {
        let label = self.resolve_model_label(model_profile_id.as_deref()).await?;
        let client = {
            let mut agents = self.agents.lock().await;
            let entry = agents
                .iter_mut()
                .find(|entry| entry.summary.id == agent_id)
                .ok_or(ManagerError::AgentNotFound)?;
            if matches!(entry.summary.status, AgentStatus::Archived) {
                return Err(ManagerError::Archived);
            }
            if entry.active_turns > 0 {
                return Err(ManagerError::Busy);
            }
            entry.summary.model_profile_id = model_profile_id;
            entry.summary.model_label = label;
            // Restart on next prompt with the new environment, replaying history.
            let client = entry.runtime.take().map(|runtime| runtime.client);
            for session in &mut entry.summary.sessions {
                session.acp_session_id = None;
                entry.needs_replay.insert(session.id.clone());
            }
            client
        };
        if let Some(client) = client {
            client.kill().await;
        }
        self.publish_agent(agent_id).await;
        self.persist_roster().await?;
        self.agent(agent_id).await
    }

    pub async fn set_approval_mode(&self, agent_id: &str, mode: ApprovalMode) -> Result<AgentSummary, ManagerError> {
        {
            let mut agents = self.agents.lock().await;
            let entry = agents
                .iter_mut()
                .find(|entry| entry.summary.id == agent_id)
                .ok_or(ManagerError::AgentNotFound)?;
            entry.summary.approval_mode = mode;
        }
        self.publish_agent(agent_id).await;
        self.persist_roster().await?;
        self.agent(agent_id).await
    }

    pub async fn rename_agent(&self, agent_id: &str, name: String) -> Result<AgentSummary, ManagerError> {
        let name = name.trim().to_owned();
        if name.is_empty() {
            return Err(ManagerError::Invalid("agent name must not be empty".to_owned()));
        }
        {
            let mut agents = self.agents.lock().await;
            let entry = agents
                .iter_mut()
                .find(|entry| entry.summary.id == agent_id)
                .ok_or(ManagerError::AgentNotFound)?;
            entry.summary.name = name;
        }
        self.publish_agent(agent_id).await;
        self.persist_roster().await?;
        self.agent(agent_id).await
    }

    /// Archive: kill the process, resolve parked approvals as cancelled,
    /// optionally remove the worktree.
    pub async fn archive(&self, agent_id: &str, remove_worktree: bool) -> Result<AgentSummary, ManagerError> {
        let cancelled = self.ledger.cancel_for_agent(agent_id).await;
        for approval in &cancelled {
            self.hub.publish(Event::ApprovalResolved {
                approval_id: approval.id.clone(),
                agent_id: agent_id.to_owned(),
                option_id: None,
            });
        }
        let (client, worktree) = {
            let mut agents = self.agents.lock().await;
            let entry = agents
                .iter_mut()
                .find(|entry| entry.summary.id == agent_id)
                .ok_or(ManagerError::AgentNotFound)?;
            let client = entry.runtime.take().map(|runtime| runtime.client);
            entry.summary.status = AgentStatus::Archived;
            entry.summary.pending_approvals = 0;
            for session in &mut entry.summary.sessions {
                session.acp_session_id = None;
            }
            let worktree = if remove_worktree {
                entry.summary.worktree.take()
            } else {
                None
            };
            (client, worktree)
        };
        if let Some(client) = client {
            client.kill().await;
        }
        if let Some(worktree) = worktree {
            self.worktrees.remove(&worktree, true).await?;
        }
        // The agent's Vertex credentials file, if any, is no longer needed.
        self.store.remove_credentials(agent_id).await?;
        self.publish_agent(agent_id).await;
        self.persist_roster().await?;
        self.agent(agent_id).await
    }

    pub async fn transcript(&self, agent_id: &str, session_id: &str) -> Result<Vec<TranscriptItem>, ManagerError> {
        {
            let agents = self.agents.lock().await;
            let entry = agents
                .iter()
                .find(|entry| entry.summary.id == agent_id)
                .ok_or(ManagerError::AgentNotFound)?;
            entry.session(session_id).ok_or(ManagerError::SessionNotFound)?;
        }
        Ok(self.store.load_transcript(agent_id, session_id).await?)
    }

    pub async fn diff(&self, agent_id: &str) -> Result<WorktreeDiff, ManagerError> {
        let worktree = {
            let agents = self.agents.lock().await;
            let entry = agents
                .iter()
                .find(|entry| entry.summary.id == agent_id)
                .ok_or(ManagerError::AgentNotFound)?;
            entry.summary.worktree.clone().ok_or(ManagerError::NoWorktree)?
        };
        Ok(self.worktrees.diff(&worktree).await?)
    }

    pub async fn pending_approvals(&self) -> Vec<ApprovalView> {
        self.ledger.pending_all().await
    }

    pub async fn pending_approvals_for(&self, agent_id: &str) -> Result<Vec<ApprovalView>, ManagerError> {
        self.agent(agent_id).await?;
        Ok(self.ledger.pending_for_agent(agent_id).await)
    }

    /// Resolve a parked approval with the chosen option id.
    pub async fn resolve_approval(&self, approval_id: &str, option_id: String) -> Result<(), ManagerError> {
        let view = self
            .ledger
            .resolve(approval_id, option_id.clone())
            .await
            .ok_or(ManagerError::ApprovalNotFound)?;
        {
            let mut agents = self.agents.lock().await;
            if let Some(entry) = agents.iter_mut().find(|entry| entry.summary.id == view.agent_id) {
                entry.summary.pending_approvals = entry.summary.pending_approvals.saturating_sub(1);
                entry.recompute_status();
            }
        }
        self.hub.publish(Event::ApprovalResolved {
            approval_id: approval_id.to_owned(),
            agent_id: view.agent_id.clone(),
            option_id: Some(option_id),
        });
        self.publish_agent(&view.agent_id).await;
        Ok(())
    }

    /// React to protocol traffic from one agent process.
    async fn handle_acp_event(self: &Arc<Self>, agent_id: &str, event: AcpEvent) {
        match event {
            AcpEvent::Update { acp_session_id, update } => {
                let session_id = {
                    let agents = self.agents.lock().await;
                    agents
                        .iter()
                        .find(|entry| entry.summary.id == agent_id)
                        .and_then(|entry| entry.session_by_acp(&acp_session_id))
                        .map(|session| session.id.clone())
                };
                let Some(session_id) = session_id else { return };
                self.handle_update(agent_id, &session_id, update).await;
            }
            AcpEvent::Permission(request) => {
                self.handle_permission(agent_id, request).await;
            }
            // Responses are resolved by the pump before reaching here.
            AcpEvent::Response(_) => {}
            AcpEvent::Closed => {
                let (was_busy, archived) = {
                    let mut agents = self.agents.lock().await;
                    match agents.iter_mut().find(|entry| entry.summary.id == agent_id) {
                        Some(entry) => {
                            let archived = matches!(entry.summary.status, AgentStatus::Archived);
                            entry.runtime = None;
                            for session in &mut entry.summary.sessions {
                                session.acp_session_id = None;
                                entry.needs_replay.insert(session.id.clone());
                            }
                            (entry.active_turns > 0, archived)
                        }
                        None => (false, true),
                    }
                };
                if !archived && was_busy {
                    self.mark_error(agent_id, "agent process exited unexpectedly").await;
                }
            }
        }
    }

    async fn handle_update(&self, agent_id: &str, session_id: &str, update: SessionUpdate) {
        match update {
            SessionUpdate::MessageChunk { text } => {
                self.record(
                    agent_id,
                    session_id,
                    TranscriptItem::MessageChunk { text: text.clone() },
                    Event::MessageChunk {
                        agent_id: agent_id.to_owned(),
                        session_id: session_id.to_owned(),
                        text,
                    },
                )
                .await;
            }
            SessionUpdate::ThoughtChunk { text } => {
                self.record(
                    agent_id,
                    session_id,
                    TranscriptItem::ThoughtChunk { text: text.clone() },
                    Event::ThoughtChunk {
                        agent_id: agent_id.to_owned(),
                        session_id: session_id.to_owned(),
                        text,
                    },
                )
                .await;
            }
            SessionUpdate::ToolCall(view) => {
                self.upsert_tool_call(agent_id, session_id, view).await;
            }
            SessionUpdate::ToolCallUpdate(patch) => {
                let merged = {
                    let mut agents = self.agents.lock().await;
                    agents
                        .iter_mut()
                        .find(|entry| entry.summary.id == agent_id)
                        .map(|entry| {
                            let key = format!("{session_id}/{}", patch.tool_call_id);
                            match entry.tool_calls.get_mut(&key) {
                                Some(existing) => {
                                    patch.apply(existing);
                                    existing.clone()
                                }
                                None => {
                                    let view = patch.into_view();
                                    entry.tool_calls.insert(key, view.clone());
                                    view
                                }
                            }
                        })
                };
                if let Some(view) = merged {
                    self.record(
                        agent_id,
                        session_id,
                        TranscriptItem::ToolCall {
                            tool_call: view.clone(),
                        },
                        Event::ToolCall {
                            agent_id: agent_id.to_owned(),
                            session_id: session_id.to_owned(),
                            tool_call: view,
                        },
                    )
                    .await;
                }
            }
            SessionUpdate::Plan(entries) => {
                self.record(
                    agent_id,
                    session_id,
                    TranscriptItem::Plan {
                        entries: entries.clone(),
                    },
                    Event::Plan {
                        agent_id: agent_id.to_owned(),
                        session_id: session_id.to_owned(),
                        entries,
                    },
                )
                .await;
            }
            SessionUpdate::UserMessageChunk { .. } | SessionUpdate::Other => {}
        }
    }

    async fn upsert_tool_call(&self, agent_id: &str, session_id: &str, view: ToolCallView) {
        {
            let mut agents = self.agents.lock().await;
            if let Some(entry) = agents.iter_mut().find(|entry| entry.summary.id == agent_id) {
                let key = format!("{session_id}/{}", view.tool_call_id);
                entry.tool_calls.insert(key, view.clone());
            }
        }
        self.record(
            agent_id,
            session_id,
            TranscriptItem::ToolCall {
                tool_call: view.clone(),
            },
            Event::ToolCall {
                agent_id: agent_id.to_owned(),
                session_id: session_id.to_owned(),
                tool_call: view,
            },
        )
        .await;
    }

    async fn handle_permission(self: &Arc<Self>, agent_id: &str, request: PermissionRequest) {
        let PermissionRequest {
            rpc_id,
            acp_session_id,
            tool_call,
            options,
        } = request;
        let (client, session_id, mode) = {
            let agents = self.agents.lock().await;
            let Some(entry) = agents.iter().find(|entry| entry.summary.id == agent_id) else {
                return;
            };
            let Some(runtime) = entry.runtime.as_ref() else { return };
            let session_id = entry
                .session_by_acp(&acp_session_id)
                .map(|session| session.id.clone())
                .unwrap_or("main".to_owned());
            (Arc::clone(&runtime.client), session_id, entry.summary.approval_mode)
        };
        match decide(mode, tool_call.kind, &options) {
            PolicyDecision::AutoSelect(option_id) => {
                if let Err(err) = client.respond_permission(rpc_id, Some(option_id)).await {
                    tracing::warn!(agent_id, error = %err, "failed to answer permission request");
                }
            }
            PolicyDecision::Ask => {
                let approval = ApprovalView {
                    id: Uuid::new_v4().to_string(),
                    agent_id: agent_id.to_owned(),
                    session_id,
                    tool_call,
                    options,
                };
                let receiver = self.ledger.park(approval.clone()).await;
                {
                    let mut agents = self.agents.lock().await;
                    if let Some(entry) = agents.iter_mut().find(|entry| entry.summary.id == agent_id) {
                        entry.summary.pending_approvals += 1;
                        entry.recompute_status();
                    }
                }
                self.hub.publish(Event::ApprovalRequested { approval });
                self.publish_agent(agent_id).await;
                let agent_id = agent_id.to_owned();
                tokio::spawn(async move {
                    let outcome = receiver.await.unwrap_or(ApprovalOutcome::Cancelled);
                    let answer = match outcome {
                        ApprovalOutcome::Selected(option_id) => Some(option_id),
                        ApprovalOutcome::Cancelled => None,
                    };
                    if let Err(err) = client.respond_permission(rpc_id, answer).await {
                        tracing::warn!(agent_id, error = %err, "failed to answer permission request");
                    }
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{default_project_name, history_preamble, AgentManager, CreateAgent, ManagerConfig, ManagerError};
    use crate::acp::updates::ToolCallPatch;
    use crate::acp::{AcpEvent, SessionUpdate};
    use crate::model::{ApprovalMode, StopReason, TranscriptItem};
    use std::path::Path;

    #[test]
    fn default_project_name_uses_the_final_path_component() {
        assert_eq!(default_project_name(Path::new("/Users/dev/my-repo")), "my-repo");
        assert_eq!(default_project_name(Path::new("relative/path")), "path");
    }

    #[test]
    fn default_project_name_falls_back_to_the_whole_path_with_no_file_name() {
        assert_eq!(default_project_name(Path::new("/")), "/");
    }

    fn config(dir: &std::path::Path, command: Vec<String>) -> ManagerConfig {
        ManagerConfig {
            repo_root: dir.to_owned(),
            worktrees_dir: dir.join("worktrees"),
            data_dir: dir.join("data"),
            agent_command: command,
            max_agents: 10,
        }
    }

    /// The project bootstrapped from `config()`'s `repo_root` on first start.
    async fn default_project_id(manager: &AgentManager) -> String {
        manager.list_projects().await.into_iter().next().unwrap().id
    }

    #[tokio::test]
    async fn new_reports_corrupt_roster() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        tokio::fs::create_dir_all(&data).await.unwrap();
        tokio::fs::write(data.join("agents.json"), b"{ not json").await.unwrap();
        let result = AgentManager::new(config(dir.path(), vec!["stub".to_owned()])).await;
        assert!(matches!(result, Err(ManagerError::Store(_))));
    }

    #[tokio::test]
    async fn new_backfills_a_roster_persisted_before_projects_existed() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        tokio::fs::create_dir_all(&data).await.unwrap();
        // No `projectId` field: the shape written by a pre-projects build.
        let legacy_roster = serde_json::json!([{
            "summary": {
                "id": "legacy-1",
                "name": "old agent",
                "status": "idle",
                "approvalMode": "always_ask",
                "worktree": null,
                "cwd": dir.path(),
                "sessions": [],
                "pendingApprovals": 0,
                "forkedFrom": null,
                "lastError": null,
            },
            "command": ["stub"],
        }]);
        tokio::fs::write(data.join("agents.json"), serde_json::to_vec(&legacy_roster).unwrap())
            .await
            .unwrap();

        let manager = AgentManager::new(config(dir.path(), vec!["stub".to_owned()]))
            .await
            .unwrap();
        let default_project = manager.list_projects().await.into_iter().next().unwrap();
        let agents = manager.snapshot().await;
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].project_id, default_project.id);

        // The fix is persisted, not just applied in memory: a second start
        // from the same data dir reads the already-backfilled roster.
        let reopened = AgentManager::new(config(dir.path(), vec!["stub".to_owned()]))
            .await
            .unwrap();
        let reopened_agents = reopened.snapshot().await;
        assert_eq!(reopened_agents[0].project_id, default_project.id);
    }

    #[tokio::test]
    async fn new_loads_a_roster_persisted_before_model_profiles_existed() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        tokio::fs::create_dir_all(&data).await.unwrap();
        // No `modelProfileId`/`modelLabel` fields: the shape written before
        // model profiles existed (but after projects, hence `projectId`).
        // Both are `Option<String>`, so serde defaults a missing key to
        // `None` even without `#[serde(default)]` (unlike `project_id`
        // above, a non-`Option` field where the attribute is required).
        let legacy_roster = serde_json::json!([{
            "summary": {
                "id": "legacy-1",
                "name": "old agent",
                "projectId": "whatever",
                "status": "idle",
                "approvalMode": "always_ask",
                "worktree": null,
                "cwd": dir.path(),
                "sessions": [],
                "pendingApprovals": 0,
                "forkedFrom": null,
                "lastError": null,
            },
            "command": ["stub"],
        }]);
        tokio::fs::write(data.join("agents.json"), serde_json::to_vec(&legacy_roster).unwrap())
            .await
            .unwrap();

        let manager = AgentManager::new(config(dir.path(), vec!["stub".to_owned()]))
            .await
            .unwrap();
        let agents = manager.snapshot().await;
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].model_profile_id, None);
        assert_eq!(agents[0].model_label, None);
    }

    #[tokio::test]
    async fn create_agent_with_worktree_in_non_git_repo_errors() {
        let dir = tempfile::tempdir().unwrap();
        // repo_root is a plain directory, so resolving the base branch fails.
        let manager = AgentManager::new(config(dir.path(), vec!["stub".to_owned()]))
            .await
            .unwrap();
        let project_id = default_project_id(&manager).await;
        let err = manager
            .create_agent(CreateAgent {
                name: "x".to_owned(),
                project_id,
                use_worktree: true,
                base_branch: None,
                approval_mode: ApprovalMode::Auto,
                model_profile_id: None,
            })
            .await
            .unwrap_err();
        assert!(matches!(err, ManagerError::Git(_)));
    }

    #[tokio::test]
    async fn handle_acp_event_ignores_unknown_agent() {
        let dir = tempfile::tempdir().unwrap();
        let manager = AgentManager::new(config(dir.path(), vec!["stub".to_owned()]))
            .await
            .unwrap();
        // A response frame normally never reaches the handler (the pump
        // resolves it), and an event for an unknown agent is ignored.
        manager
            .handle_acp_event("ghost", AcpEvent::Response(serde_json::json!({})))
            .await;
        manager.handle_acp_event("ghost", AcpEvent::Closed).await;
    }

    #[tokio::test]
    async fn mark_error_on_unknown_agent_only_publishes() {
        let dir = tempfile::tempdir().unwrap();
        let manager = AgentManager::new(config(dir.path(), vec!["stub".to_owned()]))
            .await
            .unwrap();
        let mut receiver = manager.hub().subscribe();
        manager.mark_error("ghost", "boom").await;
        let event = receiver.recv().await.unwrap();
        assert!(matches!(event, crate::events::Event::AgentError { .. }));
    }

    #[tokio::test]
    async fn ensure_running_on_archived_agent_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        // A command that cannot spawn leaves the agent in Error with no runtime.
        let manager = AgentManager::new(config(dir.path(), vec!["/nonexistent/agent".to_owned()]))
            .await
            .unwrap();
        let project_id = default_project_id(&manager).await;
        let agent = manager
            .create_agent(CreateAgent {
                name: "doomed".to_owned(),
                project_id,
                use_worktree: false,
                base_branch: None,
                approval_mode: ApprovalMode::Auto,
                model_profile_id: None,
            })
            .await
            .unwrap();
        manager.archive(&agent.id, false).await.unwrap();
        let err = manager.ensure_running(&agent.id).await.unwrap_err();
        assert!(matches!(err, ManagerError::Archived));
    }

    #[tokio::test]
    async fn record_warns_when_transcript_write_fails() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        tokio::fs::create_dir_all(&data_dir).await.unwrap();
        // A file where the transcripts directory belongs makes every append fail.
        tokio::fs::write(data_dir.join("transcripts"), b"blocker")
            .await
            .unwrap();
        let manager = AgentManager::new(config(dir.path(), vec!["stub".to_owned()]))
            .await
            .unwrap();
        // The failing append is logged and swallowed; the event still publishes.
        let mut receiver = manager.hub().subscribe();
        manager
            .handle_update("a", "main", SessionUpdate::MessageChunk { text: "hi".to_owned() })
            .await;
        assert!(matches!(
            receiver.recv().await.unwrap(),
            crate::events::Event::MessageChunk { .. }
        ));
    }

    #[tokio::test]
    async fn permission_for_unknown_agent_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let manager = AgentManager::new(config(dir.path(), vec!["stub".to_owned()]))
            .await
            .unwrap();
        let request = crate::acp::PermissionRequest {
            rpc_id: serde_json::json!(1),
            acp_session_id: "s".to_owned(),
            tool_call: crate::model::ToolCallView {
                tool_call_id: "t".to_owned(),
                title: "x".to_owned(),
                kind: crate::model::ToolKind::Execute,
                status: crate::model::ToolCallStatus::Pending,
                content: vec![],
                locations: vec![],
            },
            options: vec![],
        };
        // No such agent, so the handler returns before touching any runtime.
        manager.handle_permission("ghost", request).await;
    }

    #[tokio::test]
    async fn tool_call_update_for_unknown_agent_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let manager = AgentManager::new(config(dir.path(), vec!["stub".to_owned()]))
            .await
            .unwrap();
        let patch = ToolCallPatch {
            tool_call_id: "t".to_owned(),
            title: None,
            kind: None,
            status: None,
            content: None,
            locations: None,
        };
        // No such agent, so the merge yields nothing and nothing is recorded.
        manager
            .handle_update("ghost", "main", SessionUpdate::ToolCallUpdate(patch))
            .await;
    }

    #[test]
    fn preamble_merges_chunks_and_labels_roles() {
        let items = vec![
            TranscriptItem::UserMessage { text: "hi".to_owned() },
            TranscriptItem::MessageChunk { text: "hel".to_owned() },
            TranscriptItem::MessageChunk { text: "lo".to_owned() },
            TranscriptItem::TurnEnded {
                stop_reason: StopReason::EndTurn,
            },
            TranscriptItem::UserMessage {
                text: "again".to_owned(),
            },
            TranscriptItem::MessageChunk {
                text: "sure".to_owned(),
            },
        ];
        let preamble = history_preamble(&items);
        assert!(preamble.contains("User: hi\nAssistant: hello\nUser: again\nAssistant: sure"));
        assert!(preamble.starts_with("<conversation-history>"));
        assert!(preamble.trim_end().ends_with("</conversation-history>"));
    }

    #[test]
    fn preamble_of_empty_history_is_empty() {
        assert_eq!(history_preamble(&[]), "");
        let items = vec![TranscriptItem::TurnEnded {
            stop_reason: StopReason::EndTurn,
        }];
        assert_eq!(history_preamble(&items), "");
    }

    #[test]
    fn preamble_truncates_from_the_front() {
        let items = vec![
            TranscriptItem::UserMessage {
                text: "x".repeat(20_000),
            },
            TranscriptItem::UserMessage {
                text: "recent".to_owned(),
            },
        ];
        let preamble = history_preamble(&items);
        assert!(preamble.len() < 20_000);
        assert!(preamble.contains("recent"));
    }
}
