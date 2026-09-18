//! Durable state: agent roster metadata and per-session transcripts.
//!
//! Roster metadata lives in one JSON file rewritten atomically on change.
//! Transcripts are append-only JSONL, one file per session, so a streaming
//! turn is a sequence of cheap appends and replay is a linear read.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::model::{AgentSummary, TranscriptItem};
use crate::models::ModelProfile;

/// Restrict a file to owner read/write on Unix; a no-op elsewhere.
async fn restrict_permissions(path: &Path) -> Result<(), StoreError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(io_err(path))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

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

fn corrupt_err(path: &Path) -> impl FnOnce(serde_json::Error) -> StoreError + '_ {
    move |source| StoreError::Corrupt {
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
        let bytes = serde_json::to_vec_pretty(agents).map_err(corrupt_err(&path))?;
        tokio::fs::write(&tmp, bytes).await.map_err(io_err(&tmp))?;
        tokio::fs::rename(&tmp, &path).await.map_err(io_err(&path))?;
        Ok(())
    }

    fn models_path(&self) -> PathBuf {
        self.data_dir.join("models.json")
    }

    pub async fn load_models(&self) -> Result<Vec<ModelProfile>, StoreError> {
        let path = self.models_path();
        match tokio::fs::read(&path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|source| StoreError::Corrupt { path, source }),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(source) => Err(StoreError::Io { path, source }),
        }
    }

    /// Rewrite the model profiles atomically. The file holds provider secrets,
    /// so it is created with owner-only permissions on Unix.
    pub async fn save_models(&self, profiles: &[ModelProfile]) -> Result<(), StoreError> {
        tokio::fs::create_dir_all(&self.data_dir)
            .await
            .map_err(io_err(&self.data_dir))?;
        let path = self.models_path();
        let tmp = self.data_dir.join("models.json.tmp");
        let bytes = serde_json::to_vec_pretty(profiles).map_err(corrupt_err(&path))?;
        tokio::fs::write(&tmp, bytes).await.map_err(io_err(&tmp))?;
        restrict_permissions(&tmp).await?;
        tokio::fs::rename(&tmp, &path).await.map_err(io_err(&path))?;
        Ok(())
    }

    /// Write a Vertex service-account credentials file for one agent, owner-only,
    /// and return its path.
    pub async fn write_credentials(&self, agent_id: &str, contents: &str) -> Result<PathBuf, StoreError> {
        let dir = self.data_dir.join("credentials");
        tokio::fs::create_dir_all(&dir).await.map_err(io_err(&dir))?;
        let path = dir.join(format!("{agent_id}.json"));
        tokio::fs::write(&path, contents).await.map_err(io_err(&path))?;
        restrict_permissions(&path).await?;
        Ok(path)
    }

    /// Remove an agent's credentials file if present.
    pub async fn remove_credentials(&self, agent_id: &str) -> Result<(), StoreError> {
        let path = self.data_dir.join("credentials").join(format!("{agent_id}.json"));
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(StoreError::Io { path, source }),
        }
    }

    pub async fn append_transcript(
        &self,
        agent_id: &str,
        session_id: &str,
        item: &TranscriptItem,
    ) -> Result<(), StoreError> {
        let path = self.transcript_path(agent_id, session_id);
        let dir = path.parent().unwrap_or(&self.data_dir);
        tokio::fs::create_dir_all(dir).await.map_err(io_err(dir))?;
        let mut line = serde_json::to_vec(item).map_err(corrupt_err(&path))?;
        line.push(b'\n');
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .map_err(io_err(&path))?;
        file.write_all(&line).await.map_err(io_err(&path))?;
        // A tokio file schedules its write in the background and does not flush
        // on drop, so a read that races the append would miss it without this.
        file.flush().await.map_err(io_err(&path))?;
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
                model_profile_id: None,
                model_label: None,
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

    #[tokio::test]
    async fn load_transcript_skips_blank_lines() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned());
        store
            .append_transcript("a1", "s1", &TranscriptItem::UserMessage { text: "hi".to_owned() })
            .await
            .unwrap();
        let path = dir.path().join("transcripts").join("a1-s1.jsonl");
        let mut existing = tokio::fs::read_to_string(&path).await.unwrap();
        existing.push_str("\n   \n");
        tokio::fs::write(&path, existing).await.unwrap();
        let items = store.load_transcript("a1", "s1").await.unwrap();
        assert_eq!(items.len(), 1);
    }

    #[tokio::test]
    async fn save_roster_reports_corrupt_on_unserializable_path() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned());
        let mut entry = agent("a1");
        // A non-UTF-8 path cannot serialize to JSON, so `to_vec_pretty` fails.
        entry.summary.cwd = PathBuf::from(OsStr::from_bytes(b"/tmp/\xff\xfe"));
        assert!(matches!(
            store.save_roster(&[entry]).await,
            Err(StoreError::Corrupt { .. })
        ));
    }

    #[tokio::test]
    async fn load_roster_reports_io_error_when_path_is_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        // A directory where the roster file is expected makes `read` fail with
        // something other than NotFound.
        tokio::fs::create_dir(dir.path().join("agents.json")).await.unwrap();
        let store = Store::new(dir.path().to_owned());
        assert!(matches!(store.load_roster().await, Err(StoreError::Io { .. })));
    }

    #[tokio::test]
    async fn append_transcript_reports_io_error_when_parent_is_a_file() {
        let dir = tempfile::tempdir().unwrap();
        // A file where the transcripts directory is expected makes
        // `create_dir_all` fail, exercising the `io_err` mapping.
        tokio::fs::write(dir.path().join("transcripts"), b"blocker")
            .await
            .unwrap();
        let store = Store::new(dir.path().to_owned());
        let result = store
            .append_transcript("a1", "s1", &TranscriptItem::UserMessage { text: "hi".to_owned() })
            .await;
        assert!(matches!(result, Err(StoreError::Io { .. })));
    }

    #[tokio::test]
    async fn load_transcript_reports_io_error_when_path_is_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::create_dir_all(dir.path().join("transcripts").join("a1-s1.jsonl"))
            .await
            .unwrap();
        let store = Store::new(dir.path().to_owned());
        assert!(matches!(
            store.load_transcript("a1", "s1").await,
            Err(StoreError::Io { .. })
        ));
    }

    fn profile(id: &str) -> ModelProfile {
        ModelProfile {
            id: id.to_owned(),
            label: "M".to_owned(),
            provider: crate::models::Provider::Openai,
            model: "gpt-6".to_owned(),
            api_key: Some("k".to_owned()),
            project_id: None,
            region: None,
            credentials_json: None,
            extra_env: vec![],
        }
    }

    #[tokio::test]
    async fn models_missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned());
        assert!(store.load_models().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn models_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned());
        store.save_models(&[profile("m1")]).await.unwrap();
        assert_eq!(store.load_models().await.unwrap(), vec![profile("m1")]);
    }

    #[tokio::test]
    async fn corrupt_models_reports_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("models.json"), b"{not json")
            .await
            .unwrap();
        let store = Store::new(dir.path().to_owned());
        assert!(matches!(store.load_models().await, Err(StoreError::Corrupt { .. })));
    }

    #[tokio::test]
    async fn load_models_reports_io_error_when_path_is_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::create_dir(dir.path().join("models.json")).await.unwrap();
        let store = Store::new(dir.path().to_owned());
        assert!(matches!(store.load_models().await, Err(StoreError::Io { .. })));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn save_models_writes_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned());
        store.save_models(&[profile("m1")]).await.unwrap();
        let meta = std::fs::metadata(dir.path().join("models.json")).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    }

    #[tokio::test]
    async fn write_credentials_stores_contents_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned());
        let path = store
            .write_credentials("a1", "{\"type\":\"service_account\"}")
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read_to_string(&path).await.unwrap(),
            "{\"type\":\"service_account\"}"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = std::fs::metadata(&path).unwrap();
            assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        }
    }

    #[tokio::test]
    async fn remove_credentials_deletes_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned());
        let path = store.write_credentials("a1", "x").await.unwrap();
        store.remove_credentials("a1").await.unwrap();
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn remove_credentials_absent_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned());
        assert!(store.remove_credentials("nope").await.is_ok());
    }

    #[tokio::test]
    async fn remove_credentials_reports_io_error_when_path_is_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::create_dir_all(dir.path().join("credentials").join("a1.json"))
            .await
            .unwrap();
        let store = Store::new(dir.path().to_owned());
        assert!(matches!(
            store.remove_credentials("a1").await,
            Err(StoreError::Io { .. })
        ));
    }
}
