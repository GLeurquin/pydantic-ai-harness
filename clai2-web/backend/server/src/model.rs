//! Domain types shared by the API, the event stream, and persistence.
//!
//! Everything here serializes with camelCase field names: these types are the
//! wire contract with the frontend.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::worktrees::WorktreeInfo;

/// How permission requests from an agent are answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalMode {
    /// Park every permission request for a human.
    AlwaysAsk,
    /// Auto-approve file edits; park execution and everything else.
    AcceptEdits,
    /// Auto-approve everything.
    Auto,
}

/// Where an agent is in its lifecycle. Driven only by protocol and process
/// events, never inferred.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Starting,
    Idle,
    Working,
    WaitingApproval,
    Error,
    Archived,
}

/// A conversation with the agent process. Every agent has one main session;
/// side sessions share the process and worktree.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    /// Backend identifier, stable across process restarts.
    pub id: String,
    /// Identifier assigned by the agent over ACP, present once opened.
    pub acp_session_id: Option<String>,
    pub label: String,
    pub is_main: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub id: String,
    pub name: String,
    pub status: AgentStatus,
    pub approval_mode: ApprovalMode,
    pub worktree: Option<WorktreeInfo>,
    /// Directory the agent process runs in (worktree path or the repo itself).
    pub cwd: PathBuf,
    pub sessions: Vec<SessionSummary>,
    pub pending_approvals: u32,
    /// Agent this one was forked from, if any.
    pub forked_from: Option<String>,
    /// Last error message when `status == Error`.
    pub last_error: Option<String>,
}

/// One entry of a permission request's option list, as offered by the agent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: PermissionOptionKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionOptionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
}

/// A permission request parked for a human decision.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalView {
    pub id: String,
    pub agent_id: String,
    pub session_id: String,
    pub tool_call: ToolCallView,
    pub options: Vec<PermissionOption>,
}

/// Kind of work a tool call performs, as reported over ACP.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    SwitchMode,
    #[default]
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    #[default]
    Pending,
    InProgress,
    Completed,
    Failed,
}

/// UI-facing projection of an ACP tool call.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallView {
    pub tool_call_id: String,
    pub title: String,
    pub kind: ToolKind,
    pub status: ToolCallStatus,
    /// Text and diff blocks reported for the call, flattened for display.
    pub content: Vec<ToolCallContent>,
    /// Files the call touches, for jump-to-file affordances.
    pub locations: Vec<ToolCallLocation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "type")]
pub enum ToolCallContent {
    Text {
        text: String,
    },
    Diff {
        path: String,
        old_text: Option<String>,
        new_text: String,
    },
    Terminal {
        terminal_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallLocation {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
}

/// Why a prompt turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
    Cancelled,
}

/// One item of a session transcript, persisted and replayed to the UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "type")]
pub enum TranscriptItem {
    UserMessage { text: String },
    MessageChunk { text: String },
    ThoughtChunk { text: String },
    ToolCall { tool_call: ToolCallView },
    Plan { entries: Vec<PlanEntry> },
    TurnEnded { stop_reason: StopReason },
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub content: String,
    pub priority: String,
    pub status: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_mode_wire_names_are_snake_case() {
        let json = serde_json::to_string(&ApprovalMode::AcceptEdits).unwrap_or_default();
        assert_eq!(json, "\"accept_edits\"");
    }

    #[test]
    fn tool_call_content_tags_by_type() {
        let content = ToolCallContent::Diff {
            path: "a.py".to_owned(),
            old_text: None,
            new_text: "x = 1\n".to_owned(),
        };
        let json = serde_json::to_value(&content).unwrap_or_default();
        assert_eq!(json["type"], "diff");
        assert_eq!(json["newText"], "x = 1\n");
    }
}
