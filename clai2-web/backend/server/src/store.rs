//! Durable state: agent roster metadata and per-session transcripts.
//!
//! Roster metadata lives in one JSON file rewritten atomically on change.
//! Transcripts are append-only JSONL, one file per session, so a streaming
//! turn is a sequence of cheap appends and replay is a linear read.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::model::{AgentSummary, TranscriptItem};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("io error at {path}: {source}")]
    Io { path: PathBuf, source: std::io::Error },
    #[error("corrupt store file {path}: {source}")]
    Corrupt { path: PathBuf, source: serde_json::Error },
}

fn io_err(path: &Path) -> impl FnOnce(std::io::Error) -> StoreError + '_ {
    move |source| StoreError::Io {
        path: path.to_owned(),
        source,
    }
}

/// Persisted roster entry: the public summary plus what is needed to respawn.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedAgent {
    pub summary: AgentSummary,
    /// argv used to spawn the agent process.
    pub command: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Store {
    data_dir: PathBuf,
}

impl Store {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    fn roster_path(&self) -> PathBuf {
        self.data_dir.join("agents.json")
    }

    fn transcript_path(&self, agent_id: &str, session_id: &str) -> PathBuf {
        self.data_dir
            .join("transcripts")
            .join(format!("{agent_id}-{session_id}.jsonl"))
    }

    pub async fn load_roster(&self) -> Result<Vec<PersistedAgent>, StoreError> {
        let path = self.roster_path();
        match tokio::fs::read(&path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|source| StoreError::Corrupt { path, source }),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(source) => Err(StoreError::Io { path, source }),
        }
    }

    /// Rewrite the roster atomically (write to a sibling temp file, rename).
    pub async fn save_roster(&self, agents: &[PersistedAgent]) -> Result<(), StoreError> {
        tokio::fs::create_dir_all(&self.data_dir)
            .await
            .map_err(io_err(&self.data_dir))?;
        let path = self.roster_path();
        let tmp = self.data_dir.join("agents.json.tmp");
        let bytes = serde_json::to_vec_pretty(agents).map_err(|source| StoreError::Corrupt {
            path: path.clone(),
            source,
        })?;
        tokio::fs::write(&tmp, bytes).await.map_err(io_err(&tmp))?;
        tokio::fs::rename(&tmp, &path).await.map_err(io_err(&path))?;
        Ok(())
    }

    pub async fn append_transcript(
        &self,
        agent_id: &str,
        session_id: &str,
        item: &TranscriptItem,
    ) -> Result<(), StoreError> {
        let path = self.transcript_path(agent_id, session_id);
        if let Some(dir) = path.parent() {
            tokio::fs::create_dir_all(dir).await.map_err(io_err(dir))?;
        }
        let mut line = serde_json::to_vec(item).map_err(|source| StoreError::Corrupt {
            path: path.clone(),
            source,
        })?;
        line.push(b'\n');
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .map_err(io_err(&path))?;
        file.write_all(&line).await.map_err(io_err(&path))?;
        Ok(())
    }

    pub async fn load_transcript(&self, agent_id: &str, session_id: &str) -> Result<Vec<TranscriptItem>, StoreError> {
        let path = self.transcript_path(agent_id, session_id);
        let text = match tokio::fs::read_to_string(&path).await {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(source) => return Err(StoreError::Io { path, source }),
        };
        let mut items = Vec::new();
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let item = serde_json::from_str(line).map_err(|source| StoreError::Corrupt {
                path: path.clone(),
                source,
            })?;
            items.push(item);
        }
        Ok(items)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AgentStatus, ApprovalMode, StopReason};

    fn agent(id: &str) -> PersistedAgent {
        PersistedAgent {
            summary: AgentSummary {
                id: id.to_owned(),
                name: "demo".to_owned(),
                status: AgentStatus::Idle,
                approval_mode: ApprovalMode::AlwaysAsk,
                worktree: None,
                cwd: PathBuf::from("/tmp/demo"),
                sessions: vec![],
                pending_approvals: 0,
                forked_from: None,
                last_error: None,
            },
            command: vec!["stub-agent".to_owned()],
        }
    }

    #[tokio::test]
    async fn roster_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned());
        assert!(store.load_roster().await.unwrap().is_empty());
        store.save_roster(&[agent("a1")]).await.unwrap();
        let loaded = store.load_roster().await.unwrap();
        assert_eq!(loaded, vec![agent("a1")]);
    }

    #[tokio::test]
    async fn corrupt_roster_reports_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("agents.json"), b"{not json")
            .await
            .unwrap();
        let store = Store::new(dir.path().to_owned());
        assert!(matches!(store.load_roster().await, Err(StoreError::Corrupt { .. })));
    }

    #[tokio::test]
    async fn transcript_appends_and_replays() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned());
        assert!(store.load_transcript("a1", "s1").await.unwrap().is_empty());
        store
            .append_transcript("a1", "s1", &TranscriptItem::UserMessage { text: "hi".to_owned() })
            .await
            .unwrap();
        store
            .append_transcript(
                "a1",
                "s1",
                &TranscriptItem::TurnEnded {
                    stop_reason: StopReason::EndTurn,
                },
            )
            .await
            .unwrap();
        let items = store.load_transcript("a1", "s1").await.unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0], TranscriptItem::UserMessage { text: "hi".to_owned() });
    }

    #[tokio::test]
    async fn corrupt_transcript_line_reports_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned());
        store
            .append_transcript("a1", "s1", &TranscriptItem::UserMessage { text: "hi".to_owned() })
            .await
            .unwrap();
        let path = dir.path().join("transcripts").join("a1-s1.jsonl");
        let mut existing = tokio::fs::read_to_string(&path).await.unwrap();
        existing.push_str("garbage\n");
        tokio::fs::write(&path, existing).await.unwrap();
        assert!(matches!(
            store.load_transcript("a1", "s1").await,
            Err(StoreError::Corrupt { .. })
        ));
    }
}
