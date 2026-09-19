//! Typed event stream fanned out to WebSocket subscribers.
//!
//! Producers publish through [`EventHub::publish`]; each WebSocket connection
//! holds a broadcast receiver. A slow subscriber that overflows its buffer is
//! disconnected by the WS layer rather than back-pressuring agents.

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::model::{AgentSummary, ApprovalView, PlanEntry, ProjectSummary, StopReason, ToolCallView, TurnUsage};

/// Everything the UI can observe, in one tagged union.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "type")]
pub enum Event {
    AgentAdded {
        agent: AgentSummary,
    },
    AgentUpdated {
        agent: AgentSummary,
    },
    AgentRemoved {
        agent_id: String,
    },
    ProjectAdded {
        project: ProjectSummary,
    },
    ProjectRemoved {
        project_id: String,
    },
    UserMessage {
        agent_id: String,
        session_id: String,
        text: String,
    },
    MessageChunk {
        agent_id: String,
        session_id: String,
        text: String,
    },
    ThoughtChunk {
        agent_id: String,
        session_id: String,
        text: String,
    },
    ToolCall {
        agent_id: String,
        session_id: String,
        tool_call: ToolCallView,
    },
    Plan {
        agent_id: String,
        session_id: String,
        entries: Vec<PlanEntry>,
    },
    ApprovalRequested {
        approval: ApprovalView,
    },
    ApprovalResolved {
        approval_id: String,
        agent_id: String,
        option_id: Option<String>,
    },
    TurnEnded {
        agent_id: String,
        session_id: String,
        stop_reason: StopReason,
        usage: Option<TurnUsage>,
    },
    AgentError {
        agent_id: String,
        message: String,
    },
}

/// Broadcast capacity. Sized for bursts from 50 agents streaming at once;
/// overflow drops the lagging subscriber, not the event.
const CAPACITY: usize = 4096;

#[derive(Debug, Clone)]
pub struct EventHub {
    sender: broadcast::Sender<Event>,
}

impl Default for EventHub {
    fn default() -> Self {
        Self::new()
    }
}

impl EventHub {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(CAPACITY);
        Self { sender }
    }

    /// Publish to all current subscribers. An event with no subscribers is
    /// dropped; transcripts, not the hub, are the durable record.
    pub fn publish(&self, event: Event) {
        let _ = self.sender.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.sender.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_serialize_with_camel_case_tag() {
        let event = Event::AgentRemoved {
            agent_id: "a1".to_owned(),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "agentRemoved");
        assert_eq!(json["agentId"], "a1");
    }

    #[tokio::test]
    async fn publish_reaches_subscribers() {
        let hub = EventHub::new();
        let mut receiver = hub.subscribe();
        hub.publish(Event::AgentRemoved {
            agent_id: "a2".to_owned(),
        });
        let event = receiver.recv().await.unwrap();
        assert_eq!(
            event,
            Event::AgentRemoved {
                agent_id: "a2".to_owned()
            }
        );
    }

    #[test]
    fn publish_without_subscribers_is_a_no_op() {
        let hub = EventHub::new();
        hub.publish(Event::AgentRemoved {
            agent_id: "a3".to_owned(),
        });
    }

    #[tokio::test]
    async fn default_hub_matches_new() {
        let hub = EventHub::default();
        let mut receiver = hub.subscribe();
        hub.publish(Event::AgentRemoved {
            agent_id: "a4".to_owned(),
        });
        assert_eq!(
            receiver.recv().await.unwrap(),
            Event::AgentRemoved {
                agent_id: "a4".to_owned()
            }
        );
    }
}
