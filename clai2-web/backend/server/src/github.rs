//! GitHub integration: a stored personal access token and issue import.
//!
//! Outbound only -- this fetches an issue from GitHub to seed an agent's
//! first prompt. There is no inbound webhook (CI-failure auto-routing):
//! the server only ever binds `127.0.0.1`, so GitHub has nothing to reach.

use serde::{Deserialize, Serialize};

/// The stored GitHub personal access token, if one was configured.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubSettings {
    pub token: Option<String>,
}

/// A client-facing view with the token redacted to a presence flag.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RedactedGithubSettings {
    pub has_token: bool,
}

impl GithubSettings {
    pub fn redacted(&self) -> RedactedGithubSettings {
        RedactedGithubSettings {
            has_token: self.token.is_some(),
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
    let response = client
        .get(&url)
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
    let body: serde_json::Value = response.json().await?;
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[test]
    fn redacted_hides_the_token() {
        let settings = GithubSettings {
            token: Some("secret".to_owned()),
        };
        assert_eq!(settings.redacted(), RedactedGithubSettings { has_token: true });
        assert_eq!(
            GithubSettings::default().redacted(),
            RedactedGithubSettings { has_token: false }
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
}
