//! Git worktree lifecycle for agent isolation.
//!
//! Every agent that opts in gets its own worktree and branch, so parallel
//! agents never write into each other's checkouts. Forking copies the parent
//! worktree's uncommitted state (tracked edits and untracked files) onto a
//! fresh worktree cut at the parent's `HEAD`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::process::Command;

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("failed to run git: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("git {args} failed: {stderr}")]
    Command { args: String, stderr: String },
    #[error("path is not valid UTF-8: {0}")]
    NonUtf8Path(PathBuf),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    /// Repository the worktree belongs to.
    pub repo_root: PathBuf,
    /// Checkout directory the agent runs in.
    pub path: PathBuf,
    /// Branch created for the agent.
    pub branch: String,
    /// Branch the agent branched from (diff baseline).
    pub base_branch: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDiff {
    /// Unified diff of the working tree against the base branch.
    pub diff: String,
    /// Untracked files, rendered as new-file diffs.
    pub untracked_diff: String,
    /// `git status --porcelain` of the worktree.
    pub status: String,
}

#[derive(Debug, Clone)]
pub struct WorktreeService {
    worktrees_dir: PathBuf,
}

async fn git(repo: &Path, args: &[&str]) -> Result<String, GitError> {
    let output = Command::new("git").arg("-C").arg(repo).args(args).output().await?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(GitError::Command {
            args: args.join(" "),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        })
    }
}

fn utf8(path: &Path) -> Result<&str, GitError> {
    // Paths from the config are UTF-8 in practice; the eager error keeps this a
    // single covered expression (a non-UTF-8 path is not reproducible in a
    // hermetic test).
    path.to_str().ok_or(GitError::NonUtf8Path(path.to_owned()))
}

/// Make a path absolute without touching the filesystem.
///
/// Worktree paths are handed to `git -C <repo> worktree add`, which resolves a
/// relative path against the repo directory rather than the process working
/// directory. Absolutizing first keeps the stored path (used as the agent's
/// cwd) and the created worktree in the same place.
fn absolutize(path: &Path) -> Result<PathBuf, GitError> {
    if path.is_absolute() {
        Ok(path.to_owned())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

/// Reduce an agent name to a filesystem- and branch-safe slug.
pub fn slugify(name: &str) -> String {
    let mut slug = String::with_capacity(name.len());
    let mut last_dash = true;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        "agent".to_owned()
    } else {
        slug.to_owned()
    }
}

impl WorktreeService {
    pub fn new(worktrees_dir: PathBuf) -> Self {
        Self { worktrees_dir }
    }

    pub fn worktrees_dir(&self) -> &Path {
        &self.worktrees_dir
    }

    /// Resolve the branch currently checked out at `repo`.
    pub async fn current_branch(&self, repo: &Path) -> Result<String, GitError> {
        Ok(git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await?
            .trim()
            .to_owned())
    }

    /// Create a worktree and dedicated branch for a new agent.
    pub async fn create(
        &self,
        repo_root: &Path,
        base_branch: &str,
        unique_slug: &str,
    ) -> Result<WorktreeInfo, GitError> {
        tokio::fs::create_dir_all(&self.worktrees_dir).await?;
        let path = absolutize(&self.worktrees_dir.join(unique_slug))?;
        let branch = format!("clai2/agents/{unique_slug}");
        git(
            repo_root,
            &["worktree", "add", "-b", &branch, utf8(&path)?, base_branch],
        )
        .await?;
        Ok(WorktreeInfo {
            repo_root: repo_root.to_owned(),
            path,
            branch,
            base_branch: base_branch.to_owned(),
        })
    }

    /// Fork `parent`: a new worktree cut at the parent's `HEAD`, carrying the
    /// parent's uncommitted tracked edits and untracked files.
    pub async fn fork(&self, parent: &WorktreeInfo, unique_slug: &str) -> Result<WorktreeInfo, GitError> {
        tokio::fs::create_dir_all(&self.worktrees_dir).await?;
        let path = absolutize(&self.worktrees_dir.join(unique_slug))?;
        let branch = format!("clai2/agents/{unique_slug}");
        let parent_head = git(&parent.path, &["rev-parse", "HEAD"]).await?.trim().to_owned();
        git(
            &parent.repo_root,
            &["worktree", "add", "-b", &branch, utf8(&path)?, &parent_head],
        )
        .await?;

        let tracked = git(&parent.path, &["diff", "--binary", "HEAD"]).await?;
        if !tracked.is_empty() {
            apply_patch(&path, &tracked).await?;
        }
        let untracked = git(&parent.path, &["ls-files", "--others", "--exclude-standard", "-z"]).await?;
        for file in untracked.split('\0').filter(|f| !f.is_empty()) {
            let src = parent.path.join(file);
            let dst = path.join(file);
            let dir = dst.parent().unwrap_or(&path);
            tokio::fs::create_dir_all(dir).await?;
            tokio::fs::copy(&src, &dst).await?;
        }

        Ok(WorktreeInfo {
            repo_root: parent.repo_root.clone(),
            path,
            branch,
            base_branch: parent.base_branch.clone(),
        })
    }

    /// Remove the worktree; optionally delete its branch too.
    pub async fn remove(&self, info: &WorktreeInfo, delete_branch: bool) -> Result<(), GitError> {
        git(&info.repo_root, &["worktree", "remove", "--force", utf8(&info.path)?]).await?;
        if delete_branch {
            git(&info.repo_root, &["branch", "-D", &info.branch]).await?;
        }
        Ok(())
    }

    /// Diff the worktree (committed and uncommitted work) against its base branch.
    pub async fn diff(&self, info: &WorktreeInfo) -> Result<WorktreeDiff, GitError> {
        let diff = git(&info.path, &["diff", &info.base_branch]).await?;
        let status = git(&info.path, &["status", "--porcelain"]).await?;
        let untracked = git(&info.path, &["ls-files", "--others", "--exclude-standard", "-z"]).await?;
        let mut untracked_diff = String::new();
        for file in untracked.split('\0').filter(|f| !f.is_empty()) {
            untracked_diff.push_str(&untracked_file_diff(&info.path, file).await?);
        }
        Ok(WorktreeDiff {
            diff,
            untracked_diff,
            status,
        })
    }
}

async fn apply_patch(worktree: &Path, patch: &str) -> Result<(), GitError> {
    use tokio::io::AsyncWriteExt;
    let mut child = Command::new("git")
        .arg("-C")
        .arg(worktree)
        .args(["apply", "--whitespace=nowarn", "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    // stdin is piped above, so `take` yields Some; the eager error keeps this a
    // single covered expression rather than a branch that never runs.
    let mut stdin = child.stdin.take().ok_or(GitError::Command {
        args: "apply".to_owned(),
        stderr: "git apply stdin unavailable".to_owned(),
    })?;
    stdin.write_all(patch.as_bytes()).await?;
    drop(stdin);
    let output = child.wait_with_output().await?;
    if output.status.success() {
        Ok(())
    } else {
        Err(GitError::Command {
            args: "apply".to_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        })
    }
}

async fn untracked_file_diff(worktree: &Path, file: &str) -> Result<String, GitError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(worktree)
        .args(["diff", "--no-index", "--", "/dev/null", file])
        .output()
        .await?;
    // `git diff --no-index` exits 1 when the files differ; that is the expected case.
    match output.status.code() {
        Some(0 | 1) => Ok(String::from_utf8_lossy(&output.stdout).into_owned()),
        _ => Err(GitError::Command {
            args: format!("diff --no-index /dev/null {file}"),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::{absolutize, apply_patch, slugify, untracked_file_diff, GitError, WorktreeInfo, WorktreeService};
    use std::path::{Path, PathBuf};
    use std::process::Command as StdCommand;

    fn git_sync(repo: &Path, args: &[&str]) {
        let output = StdCommand::new("git").arg("-C").arg(repo).args(args).output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "git {args:?}: {stderr}");
    }

    fn init_repo(repo: &Path) {
        std::fs::create_dir_all(repo).unwrap();
        git_sync(repo, &["init", "-b", "main"]);
        git_sync(repo, &["config", "user.email", "t@example.com"]);
        git_sync(repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("README.md"), "# demo\n").unwrap();
        git_sync(repo, &["add", "."]);
        git_sync(repo, &["commit", "-m", "init"]);
    }

    #[tokio::test]
    async fn git_command_failure_surfaces_as_command_error() {
        let dir = tempfile::tempdir().unwrap();
        let service = WorktreeService::new(dir.path().join("worktrees"));
        // `git -C <nonexistent>` exits non-zero, so the helper reports Command.
        let err = service.current_branch(&dir.path().join("nope")).await.unwrap_err();
        assert!(matches!(err, GitError::Command { .. }));
    }

    #[test]
    fn worktrees_dir_exposes_configured_path() {
        let service = WorktreeService::new(PathBuf::from("/tmp/wt-root"));
        assert_eq!(service.worktrees_dir(), Path::new("/tmp/wt-root"));
    }

    #[tokio::test]
    async fn create_with_bad_base_branch_errors() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        init_repo(&repo);
        let service = WorktreeService::new(dir.path().join("worktrees"));
        let err = service.create(&repo, "no-such-branch", "slug").await.unwrap_err();
        assert!(matches!(err, GitError::Command { .. }));
    }

    #[tokio::test]
    async fn current_branch_reports_checked_out_branch() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        init_repo(&repo);
        let service = WorktreeService::new(dir.path().join("worktrees"));
        assert_eq!(service.current_branch(&repo).await.unwrap(), "main");
    }

    #[tokio::test]
    async fn clean_fork_skips_patch_and_untracked_copy() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        init_repo(&repo);
        let service = WorktreeService::new(dir.path().join("worktrees"));
        let parent = service.create(&repo, "main", "parent").await.unwrap();
        // No tracked edits and no untracked files: the fork copies nothing.
        let fork = service.fork(&parent, "child").await.unwrap();
        assert!(fork.path.join("README.md").exists());
        assert!(!fork.path.join("notes.txt").exists());
    }

    #[tokio::test]
    async fn fork_copies_nested_untracked_files() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        init_repo(&repo);
        let service = WorktreeService::new(dir.path().join("worktrees"));
        let parent = service.create(&repo, "main", "parent").await.unwrap();
        std::fs::create_dir_all(parent.path.join("sub")).unwrap();
        std::fs::write(parent.path.join("sub/note.txt"), "nested\n").unwrap();
        let fork = service.fork(&parent, "child").await.unwrap();
        assert_eq!(
            std::fs::read_to_string(fork.path.join("sub/note.txt")).unwrap(),
            "nested\n"
        );
    }

    #[tokio::test]
    async fn remove_without_deleting_branch_keeps_branch() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        init_repo(&repo);
        let service = WorktreeService::new(dir.path().join("worktrees"));
        let info = service.create(&repo, "main", "keep").await.unwrap();
        service.remove(&info, false).await.unwrap();
        assert!(!info.path.exists());
        // The branch is still present because delete_branch was false.
        let branches = StdCommand::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["branch", "--list", &info.branch])
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&branches.stdout).contains(&info.branch));
    }

    #[tokio::test]
    async fn diff_of_clean_worktree_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        init_repo(&repo);
        let service = WorktreeService::new(dir.path().join("worktrees"));
        let info = service.create(&repo, "main", "clean").await.unwrap();
        let diff = service.diff(&info).await.unwrap();
        assert!(diff.diff.is_empty());
        assert!(diff.untracked_diff.is_empty());
        assert!(diff.status.is_empty());
    }

    fn bogus_info(dir: &Path) -> WorktreeInfo {
        WorktreeInfo {
            repo_root: dir.join("not-a-repo"),
            path: dir.join("not-a-worktree"),
            branch: "clai2/agents/x".to_owned(),
            base_branch: "main".to_owned(),
        }
    }

    #[tokio::test]
    async fn fork_of_non_git_parent_errors() {
        let dir = tempfile::tempdir().unwrap();
        let service = WorktreeService::new(dir.path().join("worktrees"));
        let err = service.fork(&bogus_info(dir.path()), "child").await.unwrap_err();
        assert!(matches!(err, GitError::Command { .. }));
    }

    #[tokio::test]
    async fn remove_of_missing_worktree_errors() {
        let dir = tempfile::tempdir().unwrap();
        let service = WorktreeService::new(dir.path().join("worktrees"));
        let err = service.remove(&bogus_info(dir.path()), true).await.unwrap_err();
        assert!(matches!(err, GitError::Command { .. }));
    }

    #[tokio::test]
    async fn diff_of_non_git_worktree_errors() {
        let dir = tempfile::tempdir().unwrap();
        let service = WorktreeService::new(dir.path().join("worktrees"));
        let err = service.diff(&bogus_info(dir.path())).await.unwrap_err();
        assert!(matches!(err, GitError::Command { .. }));
    }

    #[tokio::test]
    async fn apply_patch_reports_command_error_on_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        init_repo(&repo);
        let err = apply_patch(&repo, "not a valid patch\n").await.unwrap_err();
        assert!(matches!(err, GitError::Command { .. }));
    }

    #[tokio::test]
    async fn untracked_file_diff_reports_command_error_on_bad_worktree() {
        let missing = PathBuf::from("/nonexistent-worktree-xyz");
        let err = untracked_file_diff(&missing, "file.txt").await.unwrap_err();
        assert!(matches!(err, GitError::Command { .. }));
    }

    #[tokio::test]
    async fn untracked_file_diff_renders_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        init_repo(&repo);
        std::fs::write(repo.join("added.txt"), "content\n").unwrap();
        let rendered = untracked_file_diff(&repo, "added.txt").await.unwrap();
        assert!(rendered.contains("content"));
    }

    #[tokio::test]
    async fn info_round_trips_through_serde() {
        let info = WorktreeInfo {
            repo_root: PathBuf::from("/repo"),
            path: PathBuf::from("/wt"),
            branch: "b".to_owned(),
            base_branch: "main".to_owned(),
        };
        let json = serde_json::to_string(&info).unwrap();
        let back: WorktreeInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(info, back);
    }

    #[test]
    fn absolutize_keeps_absolute_paths() {
        let path = Path::new("/tmp/worktrees/agent");
        assert_eq!(absolutize(path).unwrap(), path);
    }

    #[test]
    fn absolutize_roots_relative_paths_at_cwd() {
        let resolved = absolutize(Path::new("wt/agent")).unwrap();
        assert!(resolved.is_absolute());
        assert!(resolved.ends_with("wt/agent"));
    }

    #[test]
    fn slugify_lowercases_and_dashes() {
        assert_eq!(slugify("Fix Auth Bug!"), "fix-auth-bug");
    }

    #[test]
    fn slugify_collapses_runs_and_trims() {
        assert_eq!(slugify("  a -- b  "), "a-b");
    }

    #[test]
    fn slugify_empty_falls_back() {
        assert_eq!(slugify("!!!"), "agent");
    }
}
