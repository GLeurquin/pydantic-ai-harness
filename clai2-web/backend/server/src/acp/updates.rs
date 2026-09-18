//! Parsing of `session/update` notifications into domain types.
//!
//! ACP serializers omit fields equal to their defaults, so every lookup here
//! tolerates absent keys. Unknown update variants parse to [`SessionUpdate::Other`]
//! for forward compatibility.

use serde_json::Value;

use crate::model::{PlanEntry, ToolCallContent, ToolCallLocation, ToolCallStatus, ToolCallView, ToolKind};

/// One `session/update` payload, reduced to what the manager consumes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionUpdate {
    UserMessageChunk { text: String },
    MessageChunk { text: String },
    ThoughtChunk { text: String },
    ToolCall(ToolCallView),
    ToolCallUpdate(ToolCallPatch),
    Plan(Vec<PlanEntry>),
    Other,
}

/// Partial tool-call update: present fields replace the stored value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCallPatch {
    pub tool_call_id: String,
    pub title: Option<String>,
    pub kind: Option<ToolKind>,
    pub status: Option<ToolCallStatus>,
    pub content: Option<Vec<ToolCallContent>>,
    pub locations: Option<Vec<ToolCallLocation>>,
}

impl ToolCallPatch {
    /// Merge this patch onto a stored view.
    pub fn apply(self, view: &mut ToolCallView) {
        if let Some(title) = self.title {
            view.title = title;
        }
        if let Some(kind) = self.kind {
            view.kind = kind;
        }
        if let Some(status) = self.status {
            view.status = status;
        }
        if let Some(content) = self.content {
            view.content = content;
        }
        if let Some(locations) = self.locations {
            view.locations = locations;
        }
    }

    /// A view for a patch that arrived before its `tool_call` announcement.
    pub fn into_view(self) -> ToolCallView {
        let mut view = ToolCallView {
            tool_call_id: self.tool_call_id.clone(),
            title: self.tool_call_id.clone(),
            kind: ToolKind::Other,
            status: ToolCallStatus::Pending,
            content: vec![],
            locations: vec![],
        };
        self.apply(&mut view);
        view
    }
}

fn text_of_content_block(block: &Value) -> String {
    block.get("text").and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn parse_kind(value: &Value) -> Option<ToolKind> {
    value.as_str().map(|kind| match kind {
        "read" => ToolKind::Read,
        "edit" => ToolKind::Edit,
        "delete" => ToolKind::Delete,
        "move" => ToolKind::Move,
        "search" => ToolKind::Search,
        "execute" => ToolKind::Execute,
        "think" => ToolKind::Think,
        "fetch" => ToolKind::Fetch,
        "switch_mode" => ToolKind::SwitchMode,
        _ => ToolKind::Other,
    })
}

fn parse_status(value: &Value) -> Option<ToolCallStatus> {
    match value.as_str() {
        Some("pending") => Some(ToolCallStatus::Pending),
        Some("in_progress") => Some(ToolCallStatus::InProgress),
        Some("completed") => Some(ToolCallStatus::Completed),
        Some("failed") => Some(ToolCallStatus::Failed),
        _ => None,
    }
}

fn parse_content(value: &Value) -> Option<Vec<ToolCallContent>> {
    let items = value.as_array()?;
    Some(
        items
            .iter()
            .filter_map(|item| match item.get("type").and_then(Value::as_str) {
                Some("content") => Some(ToolCallContent::Text {
                    text: item.get("content").map(text_of_content_block).unwrap_or_default(),
                }),
                Some("diff") => Some(ToolCallContent::Diff {
                    path: item.get("path").and_then(Value::as_str).unwrap_or_default().to_owned(),
                    old_text: item.get("oldText").and_then(Value::as_str).map(str::to_owned),
                    new_text: item
                        .get("newText")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                }),
                Some("terminal") => Some(ToolCallContent::Terminal {
                    terminal_id: item
                        .get("terminalId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                }),
                _ => None,
            })
            .collect(),
    )
}

fn parse_locations(value: &Value) -> Option<Vec<ToolCallLocation>> {
    let items = value.as_array()?;
    Some(
        items
            .iter()
            .filter_map(|item| {
                let path = item.get("path").and_then(Value::as_str)?.to_owned();
                let line = item
                    .get("line")
                    .and_then(Value::as_u64)
                    .and_then(|n| u32::try_from(n).ok());
                Some(ToolCallLocation { path, line })
            })
            .collect(),
    )
}

/// Parse the `toolCall` object of a permission request or a `tool_call`
/// update. Absent fields fall back to protocol defaults.
pub fn parse_tool_call(value: &Value) -> ToolCallView {
    let patch = parse_tool_call_patch(value);
    patch.into_view()
}

fn parse_tool_call_patch(value: &Value) -> ToolCallPatch {
    ToolCallPatch {
        tool_call_id: value
            .get("toolCallId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        title: value.get("title").and_then(Value::as_str).map(str::to_owned),
        kind: value.get("kind").and_then(parse_kind),
        status: value.get("status").and_then(parse_status),
        content: value.get("content").and_then(parse_content),
        locations: value.get("locations").and_then(parse_locations),
    }
}

/// Parse the `update` object of one `session/update` notification.
pub fn parse_update(update: &Value) -> SessionUpdate {
    match update.get("sessionUpdate").and_then(Value::as_str) {
        Some("user_message_chunk") => SessionUpdate::UserMessageChunk {
            text: update.get("content").map(text_of_content_block).unwrap_or_default(),
        },
        Some("agent_message_chunk") => SessionUpdate::MessageChunk {
            text: update.get("content").map(text_of_content_block).unwrap_or_default(),
        },
        Some("agent_thought_chunk") => SessionUpdate::ThoughtChunk {
            text: update.get("content").map(text_of_content_block).unwrap_or_default(),
        },
        Some("tool_call") => SessionUpdate::ToolCall(parse_tool_call(update)),
        Some("tool_call_update") => SessionUpdate::ToolCallUpdate(parse_tool_call_patch(update)),
        Some("plan") => SessionUpdate::Plan(
            update
                .get("entries")
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .map(|entry| PlanEntry {
                            content: entry
                                .get("content")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_owned(),
                            priority: entry
                                .get("priority")
                                .and_then(Value::as_str)
                                .unwrap_or("medium")
                                .to_owned(),
                            status: entry
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or("pending")
                                .to_owned(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        ),
        _ => SessionUpdate::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_message_chunk() {
        let update = json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Hi"}});
        assert_eq!(
            parse_update(&update),
            SessionUpdate::MessageChunk { text: "Hi".to_owned() }
        );
    }

    #[test]
    fn parses_thought_chunk() {
        let update = json!({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "hm"}});
        assert_eq!(
            parse_update(&update),
            SessionUpdate::ThoughtChunk { text: "hm".to_owned() }
        );
    }

    #[test]
    fn parses_user_message_chunk() {
        let update = json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "u"}});
        assert_eq!(
            parse_update(&update),
            SessionUpdate::UserMessageChunk { text: "u".to_owned() }
        );
    }

    #[test]
    fn unknown_variant_is_other() {
        assert_eq!(
            parse_update(&json!({"sessionUpdate": "usage_update"})),
            SessionUpdate::Other
        );
        assert_eq!(parse_update(&json!({})), SessionUpdate::Other);
    }

    #[test]
    fn parses_full_tool_call() {
        let update = json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call_1",
            "title": "edit_file",
            "kind": "edit",
            "status": "pending",
            "content": [
                {"type": "diff", "path": "/ws/a.py", "oldText": "a", "newText": "b"},
                {"type": "content", "content": {"type": "text", "text": "note"}},
                {"type": "terminal", "terminalId": "t1"},
                {"type": "mystery"}
            ],
            "locations": [{"path": "/ws/a.py", "line": 3}, {"noPath": true}],
            "rawInput": {"path": "a.py"}
        });
        let SessionUpdate::ToolCall(view) = parse_update(&update) else {
            panic!("expected tool call");
        };
        assert_eq!(view.tool_call_id, "call_1");
        assert_eq!(view.title, "edit_file");
        assert_eq!(view.kind, ToolKind::Edit);
        assert_eq!(view.status, ToolCallStatus::Pending);
        assert_eq!(view.content.len(), 3);
        assert_eq!(
            view.content[0],
            ToolCallContent::Diff {
                path: "/ws/a.py".to_owned(),
                old_text: Some("a".to_owned()),
                new_text: "b".to_owned(),
            }
        );
        assert_eq!(
            view.content[1],
            ToolCallContent::Text {
                text: "note".to_owned()
            }
        );
        assert_eq!(
            view.content[2],
            ToolCallContent::Terminal {
                terminal_id: "t1".to_owned()
            }
        );
        assert_eq!(
            view.locations,
            vec![ToolCallLocation {
                path: "/ws/a.py".to_owned(),
                line: Some(3)
            }]
        );
    }

    #[test]
    fn tool_call_defaults_when_fields_absent() {
        let update = json!({"sessionUpdate": "tool_call", "toolCallId": "c2"});
        let SessionUpdate::ToolCall(view) = parse_update(&update) else {
            panic!("expected tool call");
        };
        assert_eq!(view.title, "c2");
        assert_eq!(view.kind, ToolKind::Other);
        assert_eq!(view.status, ToolCallStatus::Pending);
        assert!(view.content.is_empty());
        assert!(view.locations.is_empty());
    }

    #[test]
    fn all_kinds_and_statuses_parse() {
        for (name, kind) in [
            ("read", ToolKind::Read),
            ("delete", ToolKind::Delete),
            ("move", ToolKind::Move),
            ("search", ToolKind::Search),
            ("execute", ToolKind::Execute),
            ("think", ToolKind::Think),
            ("fetch", ToolKind::Fetch),
            ("switch_mode", ToolKind::SwitchMode),
            ("someday", ToolKind::Other),
        ] {
            let update = json!({"sessionUpdate": "tool_call", "toolCallId": "c", "kind": name});
            let SessionUpdate::ToolCall(view) = parse_update(&update) else {
                panic!("expected tool call");
            };
            assert_eq!(view.kind, kind, "kind {name}");
        }
        for (name, status) in [
            ("in_progress", ToolCallStatus::InProgress),
            ("completed", ToolCallStatus::Completed),
            ("failed", ToolCallStatus::Failed),
        ] {
            let update = json!({"sessionUpdate": "tool_call", "toolCallId": "c", "status": name});
            let SessionUpdate::ToolCall(view) = parse_update(&update) else {
                panic!("expected tool call");
            };
            assert_eq!(view.status, status, "status {name}");
        }
    }

    #[test]
    fn patch_applies_only_present_fields() {
        let update = json!({"sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed"});
        let SessionUpdate::ToolCallUpdate(patch) = parse_update(&update) else {
            panic!("expected patch");
        };
        let mut view = ToolCallView {
            tool_call_id: "c1".to_owned(),
            title: "edit_file".to_owned(),
            kind: ToolKind::Edit,
            status: ToolCallStatus::InProgress,
            content: vec![ToolCallContent::Text { text: "x".to_owned() }],
            locations: vec![],
        };
        patch.apply(&mut view);
        assert_eq!(view.status, ToolCallStatus::Completed);
        assert_eq!(view.title, "edit_file");
        assert_eq!(view.content.len(), 1);
    }

    #[test]
    fn patch_replaces_collections_when_present() {
        let update = json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "c1",
            "title": "renamed",
            "kind": "execute",
            "content": [],
            "locations": [{"path": "/b.py"}]
        });
        let SessionUpdate::ToolCallUpdate(patch) = parse_update(&update) else {
            panic!("expected patch");
        };
        let mut view = ToolCallView {
            tool_call_id: "c1".to_owned(),
            title: "old".to_owned(),
            kind: ToolKind::Edit,
            status: ToolCallStatus::Pending,
            content: vec![ToolCallContent::Text { text: "x".to_owned() }],
            locations: vec![],
        };
        patch.apply(&mut view);
        assert_eq!(view.title, "renamed");
        assert_eq!(view.kind, ToolKind::Execute);
        assert!(view.content.is_empty());
        assert_eq!(view.locations.len(), 1);
    }

    #[test]
    fn parses_plan_entries_with_defaults() {
        let update = json!({
            "sessionUpdate": "plan",
            "entries": [
                {"content": "step 1", "priority": "high", "status": "in_progress"},
                {"content": "step 2"}
            ]
        });
        let SessionUpdate::Plan(entries) = parse_update(&update) else {
            panic!("expected plan");
        };
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].priority, "high");
        assert_eq!(entries[1].priority, "medium");
        assert_eq!(entries[1].status, "pending");
    }
}
