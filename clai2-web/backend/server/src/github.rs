//! GitHub integration: a stored personal access token, issue import, and
//! CI-status polling.
//!
//! Outbound only -- this fetches issues and check-run status from GitHub, on
//! a schedule for CI polling. There is no inbound webhook: the server only
//! ever binds `127.0.0.1`, so GitHub has nothing to reach.

use serde::{Deserialize, Serialize};

/// Default interval between CI-status checks for a tracked pull request,
/// before any backoff: 5 minutes.
fn default_poll_interval_secs() -> u64 {
    300
}

/// The stored GitHub personal access token, if one was configured, and the
/// base interval CI-status polling checks a tracked PR at.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubSettings {
    pub token: Option<String>,
    #[serde(default = "default_poll_interval_secs")]
    pub poll_interval_secs: u64,
}

impl Default for GithubSettings {
    fn default() -> Self {
        Self {
            token: None,
            poll_interval_secs: default_poll_interval_secs(),
        }
    }
}

/// A client-facing view with the token redacted to a presence flag.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RedactedGithubSettings {
    pub has_token: bool,
    pub poll_interval_secs: u64,
}

impl GithubSettings {
    pub fn redacted(&self) -> RedactedGithubSettings {
        RedactedGithubSettings {
            has_token: self.token.is_some(),
            poll_interval_secs: self.poll_interval_secs,
        }
    }
}

/// A parsed reference to one GitHub issue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueRef {
    pub owner: String,
    pub repo: String,
    pub number: u64,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("could not parse a GitHub issue from {0:?}; expected owner/repo#123 or a github.com issue URL")]
pub struct IssueRefError(String);

impl IssueRef {
    /// Parse `owner/repo#123` or `https://github.com/owner/repo/issues/123`.
    pub fn parse(input: &str) -> Result<Self, IssueRefError> {
        let input = input.trim();
        if let Some(rest) = input
            .strip_prefix("https://github.com/")
            .or_else(|| input.strip_prefix("http://github.com/"))
        {
            let mut parts = rest.trim_end_matches('/').splitn(4, '/');
            if let (Some(owner), Some(repo), Some("issues"), Some(number)) =
                (parts.next(), parts.next(), parts.next(), parts.next())
            {
                if let Ok(number) = number.parse() {
                    if !owner.is_empty() && !repo.is_empty() {
                        return Ok(Self {
                            owner: owner.to_owned(),
                            repo: repo.to_owned(),
                            number,
                        });
                    }
                }
            }
            return Err(IssueRefError(input.to_owned()));
        }
        if let Some((owner_repo, number)) = input.split_once('#') {
            if let Some((owner, repo)) = owner_repo.split_once('/') {
                if let Ok(number) = number.parse() {
                    if !owner.is_empty() && !repo.is_empty() {
                        return Ok(Self {
                            owner: owner.to_owned(),
                            repo: repo.to_owned(),
                            number,
                        });
                    }
                }
            }
        }
        Err(IssueRefError(input.to_owned()))
    }
}

/// Parse an `origin` remote URL into `(owner, repo)`, when it points at
/// `github.com`. Covers the three forms git itself produces: HTTPS
/// (`https://github.com/owner/repo(.git)?`), the SSH shorthand
/// (`git@github.com:owner/repo(.git)?`), and full SSH URLs
/// (`ssh://git@github.com/owner/repo(.git)?`). `None` for anything else
/// (a non-GitHub host, a local path, a malformed URL) -- there is no owner/repo
/// to open a pull request against.
pub fn parse_github_remote(url: &str) -> Option<(String, String)> {
    let rest = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))?;
    let rest = rest.strip_suffix(".git").unwrap_or(rest).trim_end_matches('/');
    let (owner, repo) = rest.split_once('/')?;
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }
    Some((owner.to_owned(), repo.to_owned()))
}

/// The subset of a fetched GitHub issue the UI needs to preview it and seed
/// an agent's first prompt.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FetchedIssue {
    pub title: String,
    pub body: String,
    pub url: String,
}

/// The prompt an agent created from an issue starts with.
pub fn issue_prompt(issue: &FetchedIssue) -> String {
    format!(
        "Work on this GitHub issue:\n\n# {}\n\n{}\n\n{}",
        issue.title, issue.body, issue.url
    )
}

#[derive(Debug, thiserror::Error)]
pub enum FetchIssueError {
    #[error("no GitHub token is configured")]
    NoToken,
    #[error(transparent)]
    InvalidRef(#[from] IssueRefError),
    #[error("GitHub returned {status}: {message}")]
    Github { status: u16, message: String },
    #[error(transparent)]
    Request(#[from] reqwest::Error),
}

/// GET `url` with the standard GitHub auth/accept headers and parse the
/// response as JSON, mapping a non-2xx status to [`FetchIssueError::Github`].
/// Shared by every GitHub REST call this module makes.
async fn get_json(client: &reqwest::Client, url: &str, token: &str) -> Result<serde_json::Value, FetchIssueError> {
    let response = client
        .get(url)
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "clai2-web")
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let message = response.text().await.unwrap_or_default();
        return Err(FetchIssueError::Github {
            status: status.as_u16(),
            message,
        });
    }
    Ok(response.json().await?)
}

/// POST `url` with the standard GitHub auth/accept headers and a JSON body, parsing the
/// response the same way [`get_json`] does. Shared by every GitHub REST call this module makes
/// that writes rather than reads.
async fn post_json(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, FetchIssueError> {
    let response = client
        .post(url)
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "clai2-web")
        .json(body)
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let message = response.text().await.unwrap_or_default();
        return Err(FetchIssueError::Github {
            status: status.as_u16(),
            message,
        });
    }
    Ok(response.json().await?)
}

/// A pull request just opened via [`create_pull_request`].
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreatedPullRequest {
    /// The PR's web URL (`html_url`), for the UI to link to.
    pub url: String,
    pub number: u64,
}

/// Open a pull request from `head` into `base`. `base_url` is
/// `https://api.github.com` in production; tests point it at a local server.
#[allow(clippy::too_many_arguments)]
pub async fn create_pull_request(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    owner: &str,
    repo: &str,
    title: &str,
    body: &str,
    head: &str,
    base: &str,
) -> Result<CreatedPullRequest, FetchIssueError> {
    let url = format!("{base_url}/repos/{owner}/{repo}/pulls");
    let payload = serde_json::json!({"title": title, "body": body, "head": head, "base": base});
    let response = post_json(client, &url, token, &payload).await?;
    Ok(CreatedPullRequest {
        url: response
            .get("html_url")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        number: response
            .get("number")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default(),
    })
}

/// Fetch one issue. `base_url` is `https://api.github.com` in production;
/// tests point it at a local server so this never depends on the real API.
pub async fn fetch_issue(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    issue_ref: &str,
) -> Result<FetchedIssue, FetchIssueError> {
    let issue = IssueRef::parse(issue_ref)?;
    let url = format!(
        "{base_url}/repos/{}/{}/issues/{}",
        issue.owner, issue.repo, issue.number
    );
    let body = get_json(client, &url, token).await?;
    let html_url = body
        .get("html_url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&url)
        .to_owned();
    Ok(FetchedIssue {
        title: body
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        body: body
            .get("body")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        url: html_url,
    })
}

/// The aggregate CI state of a pull request's head commit, as observed from
/// its check-runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CiCheckState {
    /// No check-runs exist yet for the head commit (CI hasn't started, or
    /// this PR has never been checked).
    #[default]
    Unknown,
    /// At least one check-run hasn't completed and none has failed yet.
    Pending,
    /// Every check-run completed with a passing conclusion.
    Success,
    /// At least one check-run completed with a failing conclusion.
    Failure,
}

/// One check-run as reported by GitHub's Checks API.
#[derive(Debug, Clone, Deserialize)]
struct CheckRun {
    name: String,
    status: String,
    conclusion: Option<String>,
}

/// Conclusions that count as a failure worth routing back to the agent.
/// `neutral`, `skipped`, and `stale` are deliberately not included here --
/// none of them mean the PR is broken.
const FAILING_CONCLUSIONS: [&str; 4] = ["failure", "timed_out", "action_required", "cancelled"];

/// Aggregate a PR's check-runs into one state: any completed failing run
/// wins over everything else, then any still-running run means `Pending`,
/// then `Success`; an empty list (CI hasn't reported anything yet) is
/// `Unknown` rather than `Success`, so a PR nobody has checked doesn't read
/// as passing.
fn aggregate_check_state(check_runs: &[CheckRun]) -> CiCheckState {
    if check_runs.is_empty() {
        return CiCheckState::Unknown;
    }
    let failing = check_runs.iter().any(|run| {
        run.status == "completed"
            && run
                .conclusion
                .as_deref()
                .is_some_and(|conclusion| FAILING_CONCLUSIONS.contains(&conclusion))
    });
    if failing {
        return CiCheckState::Failure;
    }
    if check_runs.iter().any(|run| run.status != "completed") {
        return CiCheckState::Pending;
    }
    CiCheckState::Success
}

/// A pull request's current CI status, as fetched for polling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrCiStatus {
    pub state: CiCheckState,
    /// Names of the check-runs that make the state `Failure`, empty
    /// otherwise.
    pub failing_checks: Vec<String>,
    pub html_url: String,
}

/// Fetch a pull request's aggregate CI status: its head commit's check-runs,
/// rolled up into one [`CiCheckState`]. `base_url` is `https://api.github.com`
/// in production; tests point it at a local server.
pub async fn fetch_pr_ci_status(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    pr_ref: &str,
) -> Result<PrCiStatus, FetchIssueError> {
    let pr = IssueRef::parse(pr_ref)?;
    let pr_url = format!("{base_url}/repos/{}/{}/pulls/{}", pr.owner, pr.repo, pr.number);
    let pr_body = get_json(client, &pr_url, token).await?;
    let sha = pr_body
        .get("head")
        .and_then(|head| head.get("sha"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let html_url = pr_body
        .get("html_url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&pr_url)
        .to_owned();

    let checks_url = format!("{base_url}/repos/{}/{}/commits/{sha}/check-runs", pr.owner, pr.repo);
    let checks_body = get_json(client, &checks_url, token).await?;
    let check_runs: Vec<CheckRun> = checks_body
        .get("check_runs")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();

    let state = aggregate_check_state(&check_runs);
    let failing_checks = if state == CiCheckState::Failure {
        check_runs
            .iter()
            .filter(|run| {
                run.status == "completed"
                    && run
                        .conclusion
                        .as_deref()
                        .is_some_and(|conclusion| FAILING_CONCLUSIONS.contains(&conclusion))
            })
            .map(|run| run.name.clone())
            .collect()
    } else {
        Vec::new()
    };

    Ok(PrCiStatus {
        state,
        failing_checks,
        html_url,
    })
}

/// Steps `consecutive_unchanged` must reach before the poll interval doubles
/// again.
const CI_BACKOFF_STEP: u32 = 3;

/// Ceiling CI polling backs off to: once a day.
pub const MAX_CI_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// The delay before the next CI check, given how many checks in a row found
/// no change. Doubles every [`CI_BACKOFF_STEP`] unchanged checks, capped at
/// [`MAX_CI_POLL_INTERVAL`], so a stable PR gets checked less and less often
/// while a newly changing one stays on the base interval.
pub fn ci_poll_interval(base: std::time::Duration, consecutive_unchanged: u32) -> std::time::Duration {
    let doublings = consecutive_unchanged / CI_BACKOFF_STEP;
    let multiplier = 1u32.checked_shl(doublings).unwrap_or(u32::MAX);
    base.saturating_mul(multiplier).min(MAX_CI_POLL_INTERVAL)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[test]
    fn redacted_hides_the_token_but_keeps_the_poll_interval() {
        let settings = GithubSettings {
            token: Some("secret".to_owned()),
            poll_interval_secs: 120,
        };
        assert_eq!(
            settings.redacted(),
            RedactedGithubSettings {
                has_token: true,
                poll_interval_secs: 120
            }
        );
        assert_eq!(
            GithubSettings::default().redacted(),
            RedactedGithubSettings {
                has_token: false,
                poll_interval_secs: 300
            }
        );
    }

    #[test]
    fn parses_owner_repo_hash_number() {
        assert_eq!(
            IssueRef::parse("pydantic/pydantic-ai#42").unwrap(),
            IssueRef {
                owner: "pydantic".to_owned(),
                repo: "pydantic-ai".to_owned(),
                number: 42,
            }
        );
    }

    #[test]
    fn parses_a_github_issue_url() {
        assert_eq!(
            IssueRef::parse("https://github.com/pydantic/pydantic-ai/issues/42").unwrap(),
            IssueRef {
                owner: "pydantic".to_owned(),
                repo: "pydantic-ai".to_owned(),
                number: 42,
            }
        );
    }

    #[test]
    fn parses_a_github_issue_url_with_a_trailing_slash() {
        assert_eq!(
            IssueRef::parse("https://github.com/pydantic/pydantic-ai/issues/42/").unwrap(),
            IssueRef {
                owner: "pydantic".to_owned(),
                repo: "pydantic-ai".to_owned(),
                number: 42,
            }
        );
    }

    #[test]
    fn rejects_malformed_references() {
        for bad in [
            "",
            "not-an-issue",
            "owner/repo",
            "owner/repo#not-a-number",
            "https://github.com/owner/repo/pulls/1",
            "https://gitlab.com/owner/repo/issues/1",
            "https://github.com//repo/issues/1",
            "#42",
            "/repo#42",
        ] {
            assert!(IssueRef::parse(bad).is_err(), "expected {bad:?} to be rejected");
        }
    }

    #[test]
    fn issue_prompt_includes_title_body_and_url() {
        let issue = FetchedIssue {
            title: "Bug: things break".to_owned(),
            body: "Steps to reproduce...".to_owned(),
            url: "https://github.com/o/r/issues/1".to_owned(),
        };
        let prompt = issue_prompt(&issue);
        assert!(prompt.contains("Bug: things break"));
        assert!(prompt.contains("Steps to reproduce..."));
        assert!(prompt.contains("https://github.com/o/r/issues/1"));
    }

    #[tokio::test]
    async fn fetch_issue_rejects_a_malformed_reference_before_any_request() {
        let client = reqwest::Client::new();
        let err = fetch_issue(&client, "http://127.0.0.1:1", "token", "not-an-issue")
            .await
            .unwrap_err();
        assert!(matches!(err, FetchIssueError::InvalidRef(_)));
    }

    /// Starts a local server on an OS-assigned port and returns its base URL.
    async fn serve(app: axum::Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn fetch_issue_returns_title_body_and_html_url_on_success() {
        let app = axum::Router::new().route(
            "/repos/pydantic/pydantic-ai/issues/42",
            axum::routing::get(|| async {
                axum::Json(serde_json::json!({
                    "title": "Bug: things break",
                    "body": "Steps to reproduce...",
                    "html_url": "https://github.com/pydantic/pydantic-ai/issues/42",
                }))
            }),
        );
        let base_url = serve(app).await;
        let client = reqwest::Client::new();
        let issue = fetch_issue(&client, &base_url, "secret-token", "pydantic/pydantic-ai#42")
            .await
            .unwrap();
        assert_eq!(issue.title, "Bug: things break");
        assert_eq!(issue.body, "Steps to reproduce...");
        assert_eq!(issue.url, "https://github.com/pydantic/pydantic-ai/issues/42");
    }

    #[tokio::test]
    async fn fetch_issue_sends_the_bearer_token_and_accept_header() {
        let captured: Arc<std::sync::Mutex<Option<(String, String)>>> = Arc::new(std::sync::Mutex::new(None));
        let captured_in_handler = Arc::clone(&captured);
        let app = axum::Router::new().route(
            "/repos/o/r/issues/1",
            axum::routing::get(move |headers: axum::http::HeaderMap| {
                let captured = Arc::clone(&captured_in_handler);
                async move {
                    let auth = headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default()
                        .to_owned();
                    let accept = headers
                        .get("accept")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default()
                        .to_owned();
                    *captured.lock().unwrap() = Some((auth, accept));
                    axum::Json(serde_json::json!({"title": "t", "body": "b", "html_url": "u"}))
                }
            }),
        );
        let base_url = serve(app).await;
        let client = reqwest::Client::new();
        fetch_issue(&client, &base_url, "secret-token", "o/r#1").await.unwrap();
        let (auth, accept) = captured.lock().unwrap().clone().unwrap();
        assert_eq!(auth, "Bearer secret-token");
        assert_eq!(accept, "application/vnd.github+json");
    }

    #[tokio::test]
    async fn fetch_issue_surfaces_githubs_status_and_body_on_error() {
        let app = axum::Router::new().route(
            "/repos/o/r/issues/404",
            axum::routing::get(|| async {
                (
                    axum::http::StatusCode::NOT_FOUND,
                    axum::Json(serde_json::json!({"message": "Not Found"})),
                )
            }),
        );
        let base_url = serve(app).await;
        let client = reqwest::Client::new();
        let err = fetch_issue(&client, &base_url, "secret-token", "o/r#404")
            .await
            .unwrap_err();
        match err {
            FetchIssueError::Github { status, message } => {
                assert_eq!(status, 404);
                assert!(message.contains("Not Found"), "unexpected message: {message}");
            }
            other => panic!("expected a Github error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn fetch_issue_falls_back_to_the_request_url_when_html_url_is_missing() {
        let app = axum::Router::new().route(
            "/repos/o/r/issues/1",
            axum::routing::get(|| async { axum::Json(serde_json::json!({"title": "t", "body": "b"})) }),
        );
        let base_url = serve(app).await;
        let client = reqwest::Client::new();
        let issue = fetch_issue(&client, &base_url, "secret-token", "o/r#1").await.unwrap();
        assert_eq!(issue.url, format!("{base_url}/repos/o/r/issues/1"));
    }

    fn check_run(status: &str, conclusion: Option<&str>) -> CheckRun {
        CheckRun {
            name: format!("{status}-{conclusion:?}"),
            status: status.to_owned(),
            conclusion: conclusion.map(str::to_owned),
        }
    }

    #[test]
    fn aggregate_check_state_of_no_runs_is_unknown() {
        assert_eq!(aggregate_check_state(&[]), CiCheckState::Unknown);
    }

    #[test]
    fn aggregate_check_state_is_success_when_every_run_passed() {
        let runs = [
            check_run("completed", Some("success")),
            check_run("completed", Some("neutral")),
        ];
        assert_eq!(aggregate_check_state(&runs), CiCheckState::Success);
    }

    #[test]
    fn aggregate_check_state_is_pending_while_any_run_is_still_going() {
        let runs = [check_run("completed", Some("success")), check_run("in_progress", None)];
        assert_eq!(aggregate_check_state(&runs), CiCheckState::Pending);
    }

    #[test]
    fn aggregate_check_state_is_failure_on_any_failing_conclusion() {
        for conclusion in ["failure", "timed_out", "action_required", "cancelled"] {
            let runs = [
                check_run("completed", Some("success")),
                check_run("completed", Some(conclusion)),
            ];
            assert_eq!(
                aggregate_check_state(&runs),
                CiCheckState::Failure,
                "expected {conclusion:?} to count as a failure"
            );
        }
    }

    #[test]
    fn aggregate_check_state_ignores_non_failing_conclusions() {
        for conclusion in ["success", "neutral", "skipped", "stale"] {
            let runs = [check_run("completed", Some(conclusion))];
            assert_eq!(
                aggregate_check_state(&runs),
                CiCheckState::Success,
                "expected {conclusion:?} not to count as a failure"
            );
        }
    }

    #[test]
    fn aggregate_check_state_prefers_failure_over_pending() {
        let runs = [check_run("completed", Some("failure")), check_run("queued", None)];
        assert_eq!(aggregate_check_state(&runs), CiCheckState::Failure);
    }

    #[test]
    fn ci_poll_interval_stays_at_base_until_the_backoff_step() {
        let base = std::time::Duration::from_secs(300);
        assert_eq!(ci_poll_interval(base, 0), base);
        assert_eq!(ci_poll_interval(base, 1), base);
        assert_eq!(ci_poll_interval(base, 2), base);
    }

    #[test]
    fn ci_poll_interval_doubles_every_three_unchanged_checks() {
        let base = std::time::Duration::from_secs(300);
        assert_eq!(ci_poll_interval(base, 3), base * 2);
        assert_eq!(ci_poll_interval(base, 5), base * 2);
        assert_eq!(ci_poll_interval(base, 6), base * 4);
    }

    #[test]
    fn ci_poll_interval_is_capped_at_24_hours() {
        let base = std::time::Duration::from_secs(300);
        assert_eq!(ci_poll_interval(base, 30), MAX_CI_POLL_INTERVAL);
        assert_eq!(ci_poll_interval(base, u32::MAX), MAX_CI_POLL_INTERVAL);
    }

    #[tokio::test]
    async fn fetch_pr_ci_status_rejects_a_malformed_reference_before_any_request() {
        let client = reqwest::Client::new();
        let err = fetch_pr_ci_status(&client, "http://127.0.0.1:1", "token", "not-a-pr")
            .await
            .unwrap_err();
        assert!(matches!(err, FetchIssueError::InvalidRef(_)));
    }

    #[tokio::test]
    async fn fetch_pr_ci_status_aggregates_a_failing_check_run() {
        let app = axum::Router::new()
            .route(
                "/repos/o/r/pulls/7",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({
                        "head": {"sha": "abc123"},
                        "html_url": "https://github.com/o/r/pull/7",
                    }))
                }),
            )
            .route(
                "/repos/o/r/commits/abc123/check-runs",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({
                        "check_runs": [
                            {"name": "lint", "status": "completed", "conclusion": "success"},
                            {"name": "test", "status": "completed", "conclusion": "failure"},
                        ],
                    }))
                }),
            );
        let base_url = serve(app).await;
        let client = reqwest::Client::new();
        let status = fetch_pr_ci_status(&client, &base_url, "secret-token", "o/r#7")
            .await
            .unwrap();
        assert_eq!(status.state, CiCheckState::Failure);
        assert_eq!(status.failing_checks, vec!["test".to_owned()]);
        assert_eq!(status.html_url, "https://github.com/o/r/pull/7");
    }

    #[tokio::test]
    async fn fetch_pr_ci_status_reports_success_with_no_failing_checks() {
        let app = axum::Router::new()
            .route(
                "/repos/o/r/pulls/7",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({"head": {"sha": "abc123"}, "html_url": "u"}))
                }),
            )
            .route(
                "/repos/o/r/commits/abc123/check-runs",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({
                        "check_runs": [{"name": "lint", "status": "completed", "conclusion": "success"}],
                    }))
                }),
            );
        let base_url = serve(app).await;
        let client = reqwest::Client::new();
        let status = fetch_pr_ci_status(&client, &base_url, "secret-token", "o/r#7")
            .await
            .unwrap();
        assert_eq!(status.state, CiCheckState::Success);
        assert!(status.failing_checks.is_empty());
    }

    #[tokio::test]
    async fn fetch_pr_ci_status_surfaces_a_missing_pr_as_a_github_error() {
        let app = axum::Router::new().route(
            "/repos/o/r/pulls/404",
            axum::routing::get(|| async {
                (
                    axum::http::StatusCode::NOT_FOUND,
                    axum::Json(serde_json::json!({"message": "Not Found"})),
                )
            }),
        );
        let base_url = serve(app).await;
        let client = reqwest::Client::new();
        let err = fetch_pr_ci_status(&client, &base_url, "secret-token", "o/r#404")
            .await
            .unwrap_err();
        assert!(matches!(err, FetchIssueError::Github { status: 404, .. }));
    }

    #[test]
    fn parses_every_form_of_github_remote_url() {
        for url in [
            "https://github.com/pydantic/pydantic-ai",
            "https://github.com/pydantic/pydantic-ai.git",
            "http://github.com/pydantic/pydantic-ai.git",
            "git@github.com:pydantic/pydantic-ai.git",
            "ssh://git@github.com/pydantic/pydantic-ai.git",
            "https://github.com/pydantic/pydantic-ai/",
        ] {
            assert_eq!(
                parse_github_remote(url),
                Some(("pydantic".to_owned(), "pydantic-ai".to_owned())),
                "failed to parse {url:?}"
            );
        }
    }

    #[test]
    fn rejects_a_non_github_or_malformed_remote_url() {
        for url in [
            "https://gitlab.com/pydantic/pydantic-ai.git",
            "/local/path/to/repo",
            "git@github.com:",
            "https://github.com/onlyowner",
            "https://github.com//pydantic-ai",
            "https://github.com/pydantic/",
        ] {
            assert_eq!(parse_github_remote(url), None, "expected {url:?} to be rejected");
        }
    }

    #[tokio::test]
    async fn create_pull_request_returns_the_html_url_and_number() {
        let app = axum::Router::new().route(
            "/repos/pydantic/pydantic-ai/pulls",
            axum::routing::post(|| async {
                axum::Json(serde_json::json!({
                    "html_url": "https://github.com/pydantic/pydantic-ai/pull/7",
                    "number": 7,
                }))
            }),
        );
        let base_url = serve(app).await;
        let client = reqwest::Client::new();
        let created = create_pull_request(
            &client,
            &base_url,
            "secret-token",
            "pydantic",
            "pydantic-ai",
            "Fix the bug",
            "Closes #1",
            "clai2/agents/fix-bug",
            "main",
        )
        .await
        .unwrap();
        assert_eq!(created.url, "https://github.com/pydantic/pydantic-ai/pull/7");
        assert_eq!(created.number, 7);
    }

    #[tokio::test]
    async fn create_pull_request_sends_the_title_body_head_and_base() {
        let captured: Arc<std::sync::Mutex<Option<serde_json::Value>>> = Arc::new(std::sync::Mutex::new(None));
        let captured_in_handler = Arc::clone(&captured);
        let app = axum::Router::new().route(
            "/repos/o/r/pulls",
            axum::routing::post(move |axum::Json(body): axum::Json<serde_json::Value>| {
                let captured = Arc::clone(&captured_in_handler);
                async move {
                    *captured.lock().unwrap() = Some(body);
                    axum::Json(serde_json::json!({"html_url": "https://github.com/o/r/pull/1", "number": 1}))
                }
            }),
        );
        let base_url = serve(app).await;
        let client = reqwest::Client::new();
        create_pull_request(
            &client,
            &base_url,
            "secret-token",
            "o",
            "r",
            "Fix the bug",
            "Closes #1",
            "clai2/agents/fix-bug",
            "main",
        )
        .await
        .unwrap();
        assert_eq!(
            captured.lock().unwrap().take().unwrap(),
            serde_json::json!({"title": "Fix the bug", "body": "Closes #1", "head": "clai2/agents/fix-bug", "base": "main"})
        );
    }

    #[tokio::test]
    async fn create_pull_request_surfaces_a_github_error() {
        let app = axum::Router::new().route(
            "/repos/o/r/pulls",
            axum::routing::post(|| async {
                (
                    axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                    axum::Json(serde_json::json!({"message": "A pull request already exists for o:branch."})),
                )
            }),
        );
        let base_url = serve(app).await;
        let client = reqwest::Client::new();
        let err = create_pull_request(
            &client,
            &base_url,
            "secret-token",
            "o",
            "r",
            "Title",
            "",
            "branch",
            "main",
        )
        .await
        .unwrap_err();
        assert!(matches!(err, FetchIssueError::Github { status: 422, .. }));
    }
}
