//! Model profiles: named provider + model configurations an agent runs under.
//!
//! A profile is an environment overlay plus a provider-qualified model string.
//! When an agent process is spawned, the selected profile's environment is
//! applied on top of the server's own, and `CLAI_MODEL` names the model for
//! the agent launcher to pass to its `Agent(...)`.
//!
//! Secrets (API keys, service-account JSON, env vars marked secret) are stored
//! but never returned to a client: reads go through [`ModelProfile::redacted`],
//! which replaces each secret value with a boolean presence flag.

use serde::{Deserialize, Serialize};

/// Providers the UI offers first-class fields for. `Custom` passes the model
/// string through verbatim and relies on explicit env entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Anthropic,
    Openai,
    GoogleGla,
    GoogleVertex,
    Bedrock,
    Azure,
    Custom,
}

impl Provider {
    /// The pydantic-ai model-string prefix, or `None` for `Custom`.
    ///
    /// `GoogleGla` and `GoogleVertex` both resolve through the same
    /// `pydantic_ai.providers.google.GoogleProvider`, whose registered name
    /// (and hence `infer_model` prefix) is `google` regardless of which
    /// transport it wraps -- Vertex vs. the direct Gemini API is decided by
    /// *how* the provider is constructed (an explicit `google.genai.Client`
    /// vs. reading `GOOGLE_API_KEY`), not by a distinct string prefix.
    /// `google-vertex` isn't a real `infer_model` prefix, so the agent
    /// launcher special-cases it to build that Vertex client itself.
    fn prefix(self) -> Option<&'static str> {
        match self {
            Provider::Anthropic => Some("anthropic"),
            Provider::Openai => Some("openai"),
            Provider::GoogleGla => Some("google"),
            Provider::GoogleVertex => Some("google-vertex"),
            Provider::Bedrock => Some("bedrock"),
            Provider::Azure => Some("azure"),
            Provider::Custom => None,
        }
    }

    /// Environment variable an API-key provider reads, if it is one.
    fn api_key_var(self) -> Option<&'static str> {
        match self {
            Provider::Anthropic => Some("ANTHROPIC_API_KEY"),
            Provider::Openai => Some("OPENAI_API_KEY"),
            Provider::GoogleGla => Some("GOOGLE_API_KEY"),
            Provider::GoogleVertex | Provider::Bedrock | Provider::Azure | Provider::Custom => None,
        }
    }
}

/// One environment variable overlaid on the agent process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub secret: bool,
}

/// A named provider + model configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfile {
    pub id: String,
    pub label: String,
    pub provider: Provider,
    /// Model name, without the provider prefix (e.g. `gemini-2.5-pro`). For
    /// `Custom`, the full model string as the launcher should receive it.
    pub model: String,
    /// API key for a key-based provider. Secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Google Cloud project (Vertex).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// Google Cloud location/region (Vertex).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    /// Service-account JSON (Vertex). Secret; written to a file at spawn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credentials_json: Option<String>,
    /// Extra environment variables overlaid last.
    #[serde(default)]
    pub extra_env: Vec<EnvVar>,
}

/// A client-facing view of a profile with secret values removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactedProfile {
    pub id: String,
    pub label: String,
    pub provider: Provider,
    pub model: String,
    pub has_api_key: bool,
    pub project_id: Option<String>,
    pub region: Option<String>,
    pub has_credentials: bool,
    pub extra_env: Vec<RedactedEnvVar>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactedEnvVar {
    pub name: String,
    /// Present only for non-secret entries.
    pub value: Option<String>,
    pub secret: bool,
}

impl ModelProfile {
    /// The provider-qualified model string, e.g. `google-vertex:gemini-2.5-pro`.
    pub fn model_string(&self) -> String {
        match self.provider.prefix() {
            Some(prefix) => format!("{prefix}:{}", self.model),
            None => self.model.clone(),
        }
    }

    /// Environment overlay for the agent process, excluding any credentials
    /// file path (the manager writes that file and adds the variable). Later
    /// entries win over earlier ones.
    pub fn base_env(&self) -> Vec<(String, String)> {
        let mut env: Vec<(String, String)> = vec![("CLAI_MODEL".to_owned(), self.model_string())];
        if let (Some(var), Some(key)) = (self.provider.api_key_var(), self.api_key.as_ref()) {
            env.push((var.to_owned(), key.clone()));
        }
        if self.provider == Provider::GoogleVertex {
            if let Some(project) = &self.project_id {
                env.push(("GOOGLE_CLOUD_PROJECT".to_owned(), project.clone()));
            }
            if let Some(region) = &self.region {
                env.push(("GOOGLE_CLOUD_LOCATION".to_owned(), region.clone()));
            }
        }
        for entry in &self.extra_env {
            env.push((entry.name.clone(), entry.value.clone()));
        }
        env
    }

    /// Whether a Vertex credentials file must be written before spawn.
    pub fn credentials(&self) -> Option<&str> {
        self.credentials_json.as_deref()
    }

    pub fn redacted(&self) -> RedactedProfile {
        RedactedProfile {
            id: self.id.clone(),
            label: self.label.clone(),
            provider: self.provider,
            model: self.model.clone(),
            has_api_key: self.api_key.is_some(),
            project_id: self.project_id.clone(),
            region: self.region.clone(),
            has_credentials: self.credentials_json.is_some(),
            extra_env: self
                .extra_env
                .iter()
                .map(|entry| RedactedEnvVar {
                    name: entry.name.clone(),
                    value: if entry.secret { None } else { Some(entry.value.clone()) },
                    secret: entry.secret,
                })
                .collect(),
        }
    }

    /// Merge an edit onto this profile. Secret fields left unset on the edit
    /// (`None`) keep their stored value, so the UI never has to round-trip a
    /// secret it was never shown. A secret field set to an empty string clears
    /// it.
    pub fn apply_edit(&mut self, edit: ProfileEdit) {
        self.label = edit.label;
        self.provider = edit.provider;
        self.model = edit.model;
        self.project_id = edit.project_id;
        self.region = edit.region;
        if let Some(api_key) = edit.api_key {
            self.api_key = non_empty(api_key);
        }
        if let Some(credentials) = edit.credentials_json {
            self.credentials_json = non_empty(credentials);
        }
        self.extra_env = merge_env(std::mem::take(&mut self.extra_env), edit.extra_env);
    }
}

fn non_empty(value: String) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// Merge edited env entries onto the stored ones. A secret entry whose value
/// is omitted (`None`) keeps the stored secret with the same name.
fn merge_env(stored: Vec<EnvVar>, edited: Vec<EnvEdit>) -> Vec<EnvVar> {
    edited
        .into_iter()
        .map(|entry| match entry.value {
            Some(value) => EnvVar {
                name: entry.name,
                value,
                secret: entry.secret,
            },
            None => {
                let previous = stored
                    .iter()
                    .find(|candidate| candidate.name == entry.name)
                    .map(|candidate| candidate.value.clone())
                    .unwrap_or_default();
                EnvVar {
                    name: entry.name,
                    value: previous,
                    secret: entry.secret,
                }
            }
        })
        .collect()
}

/// Fields accepted when creating or editing a profile. Secret fields are
/// optional so an edit can leave them unchanged.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileEdit {
    pub label: String,
    pub provider: Provider,
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub credentials_json: Option<String>,
    #[serde(default)]
    pub extra_env: Vec<EnvEdit>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvEdit {
    pub name: String,
    /// Omitted to keep a stored secret unchanged.
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub secret: bool,
}

impl ProfileEdit {
    /// Build a fresh profile with the given id from this edit.
    pub fn into_profile(self, id: String) -> ModelProfile {
        let mut profile = ModelProfile {
            id,
            label: self.label.clone(),
            provider: self.provider,
            model: self.model.clone(),
            api_key: None,
            project_id: None,
            region: None,
            credentials_json: None,
            extra_env: Vec::new(),
        };
        profile.apply_edit(self);
        profile
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.label.trim().is_empty() {
            return Err("model profile label must not be empty".to_owned());
        }
        if self.model.trim().is_empty() {
            return Err("model must not be empty".to_owned());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vertex() -> ModelProfile {
        ModelProfile {
            id: "p1".to_owned(),
            label: "Vertex Gemini".to_owned(),
            provider: Provider::GoogleVertex,
            model: "gemini-2.5-pro".to_owned(),
            api_key: None,
            project_id: Some("my-project".to_owned()),
            region: Some("us-central1".to_owned()),
            credentials_json: Some("{\"type\":\"service_account\"}".to_owned()),
            extra_env: vec![EnvVar {
                name: "EXTRA".to_owned(),
                value: "x".to_owned(),
                secret: false,
            }],
        }
    }

    #[test]
    fn vertex_model_string_is_prefixed() {
        assert_eq!(vertex().model_string(), "google-vertex:gemini-2.5-pro");
    }

    #[test]
    fn gla_model_string_uses_googles_infer_model_prefix() {
        // `google`, not `google-gla`: pydantic_ai.providers.google.GoogleProvider.name
        // is `'google'`, and `infer_model` looks up providers by that name, so a
        // generic `infer_model(profile.model_string())` launcher only resolves a
        // GLA profile with this exact prefix.
        let profile = ModelProfile {
            id: "p1".to_owned(),
            label: "Gemini".to_owned(),
            provider: Provider::GoogleGla,
            model: "gemini-2.5-pro".to_owned(),
            api_key: Some("k".to_owned()),
            project_id: None,
            region: None,
            credentials_json: None,
            extra_env: Vec::new(),
        };
        assert_eq!(profile.model_string(), "google:gemini-2.5-pro");
    }

    #[test]
    fn custom_model_string_is_verbatim() {
        let profile = ModelProfile {
            provider: Provider::Custom,
            model: "myhost:my-model".to_owned(),
            ..vertex()
        };
        assert_eq!(profile.model_string(), "myhost:my-model");
    }

    #[test]
    fn bedrock_and_azure_model_strings_are_prefixed() {
        let bedrock = ModelProfile {
            provider: Provider::Bedrock,
            model: "anthropic.claude".to_owned(),
            ..vertex()
        };
        assert_eq!(bedrock.model_string(), "bedrock:anthropic.claude");
        let azure = ModelProfile {
            provider: Provider::Azure,
            model: "gpt-4o".to_owned(),
            ..vertex()
        };
        assert_eq!(azure.model_string(), "azure:gpt-4o");
    }

    #[test]
    fn vertex_env_has_project_region_and_extras_but_no_creds_path() {
        let env = vertex().base_env();
        assert!(env.contains(&("CLAI_MODEL".to_owned(), "google-vertex:gemini-2.5-pro".to_owned())));
        assert!(env.contains(&("GOOGLE_CLOUD_PROJECT".to_owned(), "my-project".to_owned())));
        assert!(env.contains(&("GOOGLE_CLOUD_LOCATION".to_owned(), "us-central1".to_owned())));
        assert!(env.contains(&("EXTRA".to_owned(), "x".to_owned())));
        assert!(!env.iter().any(|(name, _)| name == "GOOGLE_APPLICATION_CREDENTIALS"));
        assert_eq!(vertex().credentials(), Some("{\"type\":\"service_account\"}"));
    }

    #[test]
    fn api_key_providers_set_their_key_var() {
        for (provider, var) in [
            (Provider::Anthropic, "ANTHROPIC_API_KEY"),
            (Provider::Openai, "OPENAI_API_KEY"),
            (Provider::GoogleGla, "GOOGLE_API_KEY"),
        ] {
            let profile = ModelProfile {
                provider,
                api_key: Some("secret-key".to_owned()),
                project_id: None,
                region: None,
                credentials_json: None,
                extra_env: vec![],
                ..vertex()
            };
            let env = profile.base_env();
            assert!(env.contains(&(var.to_owned(), "secret-key".to_owned())), "{var}");
            assert!(profile.credentials().is_none());
        }
    }

    #[test]
    fn api_key_absent_sets_no_var() {
        let profile = ModelProfile {
            provider: Provider::Anthropic,
            api_key: None,
            project_id: None,
            region: None,
            credentials_json: None,
            extra_env: vec![],
            ..vertex()
        };
        assert!(!profile.base_env().iter().any(|(name, _)| name == "ANTHROPIC_API_KEY"));
    }

    #[test]
    fn redacted_hides_secrets_and_flags_presence() {
        let redacted = vertex().redacted();
        assert!(redacted.has_credentials);
        assert!(!redacted.has_api_key);
        assert_eq!(redacted.project_id.as_deref(), Some("my-project"));
        assert_eq!(redacted.extra_env[0].value.as_deref(), Some("x"));

        let with_secret_env = ModelProfile {
            api_key: Some("k".to_owned()),
            extra_env: vec![EnvVar {
                name: "TOKEN".to_owned(),
                value: "shh".to_owned(),
                secret: true,
            }],
            ..vertex()
        };
        let redacted = with_secret_env.redacted();
        assert!(redacted.has_api_key);
        assert_eq!(redacted.extra_env[0].value, None);
        assert!(redacted.extra_env[0].secret);
    }

    #[test]
    fn edit_preserves_unset_secrets_and_clears_on_empty() {
        let mut profile = vertex();
        profile.apply_edit(ProfileEdit {
            label: "renamed".to_owned(),
            provider: Provider::GoogleVertex,
            model: "gemini-2.5-flash".to_owned(),
            api_key: None,
            project_id: Some("proj2".to_owned()),
            region: Some("us-east1".to_owned()),
            credentials_json: None,
            extra_env: vec![],
        });
        assert_eq!(profile.label, "renamed");
        assert_eq!(profile.model, "gemini-2.5-flash");
        assert_eq!(profile.project_id.as_deref(), Some("proj2"));
        // credentials left unset -> kept.
        assert!(profile.credentials_json.is_some());

        profile.apply_edit(ProfileEdit {
            label: "renamed".to_owned(),
            provider: Provider::GoogleVertex,
            model: "gemini-2.5-flash".to_owned(),
            api_key: None,
            project_id: None,
            region: None,
            credentials_json: Some(String::new()),
            extra_env: vec![],
        });
        // credentials cleared by empty string.
        assert!(profile.credentials_json.is_none());
    }

    #[test]
    fn env_edit_keeps_stored_secret_when_value_omitted() {
        let mut profile = ModelProfile {
            extra_env: vec![EnvVar {
                name: "TOKEN".to_owned(),
                value: "stored".to_owned(),
                secret: true,
            }],
            ..vertex()
        };
        profile.apply_edit(ProfileEdit {
            label: profile.label.clone(),
            provider: profile.provider,
            model: profile.model.clone(),
            api_key: None,
            project_id: profile.project_id.clone(),
            region: profile.region.clone(),
            credentials_json: None,
            extra_env: vec![
                EnvEdit {
                    name: "TOKEN".to_owned(),
                    value: None,
                    secret: true,
                },
                EnvEdit {
                    name: "NEW".to_owned(),
                    value: Some("v".to_owned()),
                    secret: false,
                },
            ],
        });
        assert_eq!(profile.extra_env[0].value, "stored");
        assert_eq!(profile.extra_env[1].value, "v");
    }

    #[test]
    fn env_edit_missing_stored_secret_defaults_empty() {
        let stored = vec![];
        let merged = super::merge_env(
            stored,
            vec![EnvEdit {
                name: "GONE".to_owned(),
                value: None,
                secret: true,
            }],
        );
        assert_eq!(merged[0].value, "");
    }

    #[test]
    fn into_profile_builds_from_edit() {
        let edit = ProfileEdit {
            label: "New".to_owned(),
            provider: Provider::Openai,
            model: "gpt-6".to_owned(),
            api_key: Some("k".to_owned()),
            project_id: None,
            region: None,
            credentials_json: None,
            extra_env: vec![],
        };
        let profile = edit.into_profile("id1".to_owned());
        assert_eq!(profile.id, "id1");
        assert_eq!(profile.api_key.as_deref(), Some("k"));
        assert_eq!(profile.model_string(), "openai:gpt-6");
    }

    #[test]
    fn validate_rejects_blank_label_and_model() {
        let base = ProfileEdit {
            label: "ok".to_owned(),
            provider: Provider::Openai,
            model: "gpt".to_owned(),
            api_key: None,
            project_id: None,
            region: None,
            credentials_json: None,
            extra_env: vec![],
        };
        assert!(base.validate().is_ok());
        assert!(ProfileEdit {
            label: "  ".to_owned(),
            ..base.clone()
        }
        .validate()
        .is_err());
        assert!(ProfileEdit {
            model: "".to_owned(),
            ..base
        }
        .validate()
        .is_err());
    }
}
