//! Approval policy and the pending-approval ledger.
//!
//! An agent's permission request is either answered immediately by its
//! approval mode or parked here until a human resolves it through the API.

use std::collections::HashMap;

use tokio::sync::{oneshot, Mutex};

use crate::model::{ApprovalMode, ApprovalView, PermissionOption, PermissionOptionKind, ToolKind};

/// What the policy decided for one permission request.
#[derive(Debug, PartialEq, Eq)]
pub enum PolicyDecision {
    /// Answer now with this option id.
    AutoSelect(String),
    /// Park for a human.
    Ask,
}

/// Pick the option a mode auto-selects for a tool call, if any.
///
/// Auto-selection always prefers a one-shot allow over a standing one: the
/// operator can change modes at any time, and a standing grant recorded by
/// the agent would outlive the mode that made it.
pub fn decide(mode: ApprovalMode, tool_kind: ToolKind, options: &[PermissionOption]) -> PolicyDecision {
    let auto = match mode {
        ApprovalMode::AlwaysAsk => false,
        ApprovalMode::Auto => true,
        ApprovalMode::AcceptEdits => matches!(
            tool_kind,
            ToolKind::Edit | ToolKind::Move | ToolKind::Read | ToolKind::Search | ToolKind::Think
        ),
    };
    if !auto {
        return PolicyDecision::Ask;
    }
    options
        .iter()
        .find(|option| option.kind == PermissionOptionKind::AllowOnce)
        .or_else(|| {
            options
                .iter()
                .find(|option| option.kind == PermissionOptionKind::AllowAlways)
        })
        .map_or(PolicyDecision::Ask, |option| {
            PolicyDecision::AutoSelect(option.option_id.clone())
        })
}

/// How a parked approval was resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalOutcome {
    /// A human picked this option id.
    Selected(String),
    /// The turn was cancelled before anyone answered.
    Cancelled,
}

struct Pending {
    view: ApprovalView,
    responder: oneshot::Sender<ApprovalOutcome>,
}

/// Parked approvals across all agents, keyed by approval id.
#[derive(Default)]
pub struct ApprovalLedger {
    pending: Mutex<HashMap<String, Pending>>,
}

impl ApprovalLedger {
    /// Park a request; the returned receiver resolves when a human answers or
    /// the turn is cancelled.
    pub async fn park(&self, view: ApprovalView) -> oneshot::Receiver<ApprovalOutcome> {
        let (responder, receiver) = oneshot::channel();
        let mut pending = self.pending.lock().await;
        pending.insert(view.id.clone(), Pending { view, responder });
        receiver
    }

    /// Resolve a parked approval with the given option id. Returns the
    /// approval's view, or `None` when the id is unknown (already resolved).
    pub async fn resolve(&self, approval_id: &str, option_id: String) -> Option<ApprovalView> {
        let entry = self.pending.lock().await.remove(approval_id)?;
        let _ = entry.responder.send(ApprovalOutcome::Selected(option_id));
        Some(entry.view)
    }

    /// Cancel every parked approval belonging to `agent_id`, returning them.
    pub async fn cancel_for_agent(&self, agent_id: &str) -> Vec<ApprovalView> {
        let mut pending = self.pending.lock().await;
        let ids: Vec<String> = pending
            .iter()
            .filter(|(_, entry)| entry.view.agent_id == agent_id)
            .map(|(id, _)| id.clone())
            .collect();
        let mut cancelled = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(entry) = pending.remove(&id) {
                let _ = entry.responder.send(ApprovalOutcome::Cancelled);
                cancelled.push(entry.view);
            }
        }
        cancelled
    }

    /// Snapshot of parked approvals for one agent.
    pub async fn pending_for_agent(&self, agent_id: &str) -> Vec<ApprovalView> {
        let pending = self.pending.lock().await;
        let mut views: Vec<ApprovalView> = pending
            .values()
            .filter(|entry| entry.view.agent_id == agent_id)
            .map(|entry| entry.view.clone())
            .collect();
        views.sort_by(|a, b| a.id.cmp(&b.id));
        views
    }

    /// Snapshot of every parked approval, for the global inbox.
    pub async fn pending_all(&self) -> Vec<ApprovalView> {
        let pending = self.pending.lock().await;
        let mut views: Vec<ApprovalView> = pending.values().map(|entry| entry.view.clone()).collect();
        views.sort_by(|a, b| a.id.cmp(&b.id));
        views
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ToolCallStatus, ToolCallView};

    fn options() -> Vec<PermissionOption> {
        vec![
            PermissionOption {
                option_id: "allow".to_owned(),
                name: "Allow".to_owned(),
                kind: PermissionOptionKind::AllowOnce,
            },
            PermissionOption {
                option_id: "always".to_owned(),
                name: "Always allow".to_owned(),
                kind: PermissionOptionKind::AllowAlways,
            },
            PermissionOption {
                option_id: "reject".to_owned(),
                name: "Reject".to_owned(),
                kind: PermissionOptionKind::RejectOnce,
            },
        ]
    }

    #[test]
    fn always_ask_parks_everything() {
        assert_eq!(
            decide(ApprovalMode::AlwaysAsk, ToolKind::Read, &options()),
            PolicyDecision::Ask
        );
    }

    #[test]
    fn auto_selects_allow_once_first() {
        assert_eq!(
            decide(ApprovalMode::Auto, ToolKind::Execute, &options()),
            PolicyDecision::AutoSelect("allow".to_owned())
        );
    }

    #[test]
    fn auto_falls_back_to_allow_always() {
        let options = vec![PermissionOption {
            option_id: "always".to_owned(),
            name: "Always".to_owned(),
            kind: PermissionOptionKind::AllowAlways,
        }];
        assert_eq!(
            decide(ApprovalMode::Auto, ToolKind::Execute, &options),
            PolicyDecision::AutoSelect("always".to_owned())
        );
    }

    #[test]
    fn auto_with_no_allow_option_asks() {
        let options = vec![PermissionOption {
            option_id: "reject".to_owned(),
            name: "Reject".to_owned(),
            kind: PermissionOptionKind::RejectOnce,
        }];
        assert_eq!(
            decide(ApprovalMode::Auto, ToolKind::Execute, &options),
            PolicyDecision::Ask
        );
    }

    #[test]
    fn accept_edits_approves_edits_but_parks_execute() {
        assert_eq!(
            decide(ApprovalMode::AcceptEdits, ToolKind::Edit, &options()),
            PolicyDecision::AutoSelect("allow".to_owned())
        );
        assert_eq!(
            decide(ApprovalMode::AcceptEdits, ToolKind::Execute, &options()),
            PolicyDecision::Ask
        );
        assert_eq!(
            decide(ApprovalMode::AcceptEdits, ToolKind::Other, &options()),
            PolicyDecision::Ask
        );
        assert_eq!(
            decide(ApprovalMode::AcceptEdits, ToolKind::Delete, &options()),
            PolicyDecision::Ask
        );
    }

    fn view(id: &str, agent: &str) -> ApprovalView {
        ApprovalView {
            id: id.to_owned(),
            agent_id: agent.to_owned(),
            session_id: "s1".to_owned(),
            tool_call: ToolCallView {
                tool_call_id: "t1".to_owned(),
                title: "run tests".to_owned(),
                kind: ToolKind::Execute,
                status: ToolCallStatus::Pending,
                content: vec![],
                locations: vec![],
            },
            options: options(),
        }
    }

    #[tokio::test]
    async fn resolve_answers_the_parked_request() {
        let ledger = ApprovalLedger::default();
        let receiver = ledger.park(view("ap1", "agent1")).await;
        let resolved = ledger.resolve("ap1", "allow".to_owned()).await;
        assert!(resolved.is_some());
        assert_eq!(receiver.await.unwrap(), ApprovalOutcome::Selected("allow".to_owned()));
        assert!(ledger.pending_all().await.is_empty());
    }

    #[tokio::test]
    async fn resolve_unknown_id_is_none() {
        let ledger = ApprovalLedger::default();
        assert!(ledger.resolve("nope", "allow".to_owned()).await.is_none());
    }

    #[tokio::test]
    async fn cancel_for_agent_only_hits_that_agent() {
        let ledger = ApprovalLedger::default();
        let receiver1 = ledger.park(view("ap1", "agent1")).await;
        let _receiver2 = ledger.park(view("ap2", "agent2")).await;
        let cancelled = ledger.cancel_for_agent("agent1").await;
        assert_eq!(cancelled.len(), 1);
        assert_eq!(receiver1.await.unwrap(), ApprovalOutcome::Cancelled);
        assert_eq!(ledger.pending_for_agent("agent2").await.len(), 1);
        assert_eq!(ledger.pending_for_agent("agent1").await.len(), 0);
    }
}
