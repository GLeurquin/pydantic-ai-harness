/** Provider metadata and model-form logic, kept pure for testing. */

import type { EnvEdit, Provider, ProfileEdit, RedactedProfile } from '../api/types';

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google_gla: 'Google (Gemini API)',
  google_vertex: 'Google Vertex AI',
  bedrock: 'AWS Bedrock',
  azure: 'Azure OpenAI',
  custom: 'Custom',
};

export const PROVIDERS = Object.keys(PROVIDER_LABELS) as Provider[];

/** Which optional fields a provider surfaces in the form. */
export interface ProviderFields {
  apiKey: boolean;
  vertex: boolean;
}

export function providerFields(provider: Provider): ProviderFields {
  return {
    apiKey: provider === 'anthropic' || provider === 'openai' || provider === 'google_gla',
    vertex: provider === 'google_vertex',
  };
}

/** Example model string shown as the input placeholder. */
export function modelPlaceholder(provider: Provider): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-sonnet-4-6';
    case 'openai':
      return 'gpt-6';
    case 'google_gla':
      return 'gemini-2.5-pro';
    case 'google_vertex':
      return 'gemini-2.5-pro';
    case 'bedrock':
      return 'anthropic.claude-sonnet-4-6';
    case 'azure':
      return 'gpt-6';
    case 'custom':
      return 'provider:model-name';
  }
}

/** Editable form state, mirroring the fields the UI collects. */
export interface ModelFormState {
  label: string;
  provider: Provider;
  model: string;
  apiKey: string;
  projectId: string;
  region: string;
  credentialsJson: string;
  extraEnv: EnvEdit[];
}

export function emptyForm(): ModelFormState {
  return {
    label: '',
    provider: 'anthropic',
    model: '',
    apiKey: '',
    projectId: '',
    region: '',
    credentialsJson: '',
    extraEnv: [],
  };
}

/** Seed a form from an existing profile. Secret values are never returned by
 * the server, so their inputs start blank; a blank secret on save leaves the
 * stored value unchanged. */
export function formFromProfile(profile: RedactedProfile): ModelFormState {
  return {
    label: profile.label,
    provider: profile.provider,
    model: profile.model,
    apiKey: '',
    projectId: profile.projectId ?? '',
    region: profile.region ?? '',
    credentialsJson: '',
    extraEnv: profile.extraEnv.map((entry) => ({
      name: entry.name,
      secret: entry.secret,
      // A non-secret value round-trips; a secret is left undefined to keep it.
      ...(entry.secret ? {} : { value: entry.value ?? '' }),
    })),
  };
}

/** Build the request body. `editing` controls secret handling: when editing,
 * a blank secret field is omitted so the stored secret is kept; when creating,
 * a blank secret is simply not sent. Fields irrelevant to the provider are
 * dropped. */
export function toProfileEdit(form: ModelFormState): ProfileEdit {
  const fields = providerFields(form.provider);
  const body: ProfileEdit = {
    label: form.label.trim(),
    provider: form.provider,
    model: form.model.trim(),
    extraEnv: form.extraEnv
      .filter((entry) => entry.name.trim() !== '')
      .map((entry) => {
        const name = entry.name.trim();
        if (entry.value === undefined) {
          return { name, secret: entry.secret };
        }
        return { name, value: entry.value, secret: entry.secret };
      }),
  };
  if (fields.apiKey && form.apiKey !== '') {
    body.apiKey = form.apiKey;
  }
  if (fields.vertex) {
    if (form.projectId.trim() !== '') {
      body.projectId = form.projectId.trim();
    }
    if (form.region.trim() !== '') {
      body.region = form.region.trim();
    }
    if (form.credentialsJson !== '') {
      body.credentialsJson = form.credentialsJson;
    }
  }
  return body;
}

export function validateForm(form: ModelFormState): string | null {
  if (form.label.trim() === '') {
    return 'Give the profile a name.';
  }
  if (form.model.trim() === '') {
    return 'Enter a model.';
  }
  return null;
}
