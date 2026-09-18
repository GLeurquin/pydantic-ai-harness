import { describe, expect, it } from 'vitest';

import type { Provider, RedactedProfile } from '../api/types';
import {
  emptyForm,
  formFromProfile,
  modelPlaceholder,
  PROVIDER_LABELS,
  PROVIDERS,
  providerFields,
  toProfileEdit,
  validateForm,
  type ModelFormState,
} from './providers';

function makeForm(overrides: Partial<ModelFormState> = {}): ModelFormState {
  return { ...emptyForm(), ...overrides };
}

function makeProfile(overrides: Partial<RedactedProfile> = {}): RedactedProfile {
  return {
    id: 'p1',
    label: 'Sonnet',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    hasApiKey: true,
    projectId: null,
    region: null,
    hasCredentials: false,
    extraEnv: [],
    ...overrides,
  };
}

describe('PROVIDERS', () => {
  it('lists every provider label key in declaration order', () => {
    expect(PROVIDERS).toEqual(['anthropic', 'openai', 'google_gla', 'google_vertex', 'bedrock', 'azure', 'custom']);
  });

  it('labels each provider', () => {
    expect(PROVIDER_LABELS).toEqual({
      anthropic: 'Anthropic',
      openai: 'OpenAI',
      google_gla: 'Google (Gemini API)',
      google_vertex: 'Google Vertex AI',
      bedrock: 'AWS Bedrock',
      azure: 'Azure OpenAI',
      custom: 'Custom',
    });
  });
});

describe('providerFields', () => {
  const cases: ReadonlyArray<[Provider, boolean, boolean]> = [
    ['anthropic', true, false],
    ['openai', true, false],
    ['google_gla', true, false],
    ['google_vertex', false, true],
    ['bedrock', false, false],
    ['azure', false, false],
    ['custom', false, false],
  ];

  it.each(cases)('%s surfaces apiKey=%s vertex=%s', (provider, apiKey, vertex) => {
    expect(providerFields(provider)).toEqual({ apiKey, vertex });
  });
});

describe('modelPlaceholder', () => {
  const cases: ReadonlyArray<[Provider, string]> = [
    ['anthropic', 'claude-sonnet-4-6'],
    ['openai', 'gpt-6'],
    ['google_gla', 'gemini-2.5-pro'],
    ['google_vertex', 'gemini-2.5-pro'],
    ['bedrock', 'anthropic.claude-sonnet-4-6'],
    ['azure', 'gpt-6'],
    ['custom', 'provider:model-name'],
  ];

  it.each(cases)('%s -> %s', (provider, placeholder) => {
    expect(modelPlaceholder(provider)).toBe(placeholder);
  });
});

describe('emptyForm', () => {
  it('returns a blank anthropic form', () => {
    expect(emptyForm()).toEqual({
      label: '',
      provider: 'anthropic',
      model: '',
      apiKey: '',
      projectId: '',
      region: '',
      credentialsJson: '',
      extraEnv: [],
    });
  });
});

describe('formFromProfile', () => {
  it('copies label, provider, and model and blanks the secret inputs', () => {
    const form = formFromProfile(makeProfile({ label: 'GPT', provider: 'openai', model: 'gpt-6' }));
    expect(form.label).toBe('GPT');
    expect(form.provider).toBe('openai');
    expect(form.model).toBe('gpt-6');
    expect(form.apiKey).toBe('');
    expect(form.credentialsJson).toBe('');
  });

  it('coerces null projectId and region to empty strings', () => {
    const form = formFromProfile(makeProfile({ projectId: null, region: null }));
    expect(form.projectId).toBe('');
    expect(form.region).toBe('');
  });

  it('keeps present projectId and region', () => {
    const form = formFromProfile(makeProfile({ projectId: 'my-project', region: 'us-central1' }));
    expect(form.projectId).toBe('my-project');
    expect(form.region).toBe('us-central1');
  });

  it('omits the value for a secret env entry and keeps it for a non-secret one', () => {
    const form = formFromProfile(
      makeProfile({
        extraEnv: [
          { name: 'TOKEN', value: null, secret: true },
          { name: 'PROXY', value: 'http://proxy', secret: false },
        ],
      }),
    );
    expect(form.extraEnv).toEqual([
      { name: 'TOKEN', secret: true },
      { name: 'PROXY', secret: false, value: 'http://proxy' },
    ]);
    expect(form.extraEnv.map((entry) => 'value' in entry)).toEqual([false, true]);
  });

  it('defaults a non-secret null value to an empty string', () => {
    const form = formFromProfile(makeProfile({ extraEnv: [{ name: 'FLAG', value: null, secret: false }] }));
    expect(form.extraEnv).toEqual([{ name: 'FLAG', secret: false, value: '' }]);
  });
});

describe('toProfileEdit', () => {
  it('trims the label and model', () => {
    const body = toProfileEdit(makeForm({ label: '  Sonnet  ', model: '  claude-sonnet-4-6  ' }));
    expect(body.label).toBe('Sonnet');
    expect(body.model).toBe('claude-sonnet-4-6');
  });

  it('sends the api key only for key providers and only when non-empty', () => {
    expect(toProfileEdit(makeForm({ provider: 'anthropic', apiKey: 'sk-1' })).apiKey).toBe('sk-1');
    expect(toProfileEdit(makeForm({ provider: 'anthropic', apiKey: '' })).apiKey).toBeUndefined();
    expect(toProfileEdit(makeForm({ provider: 'bedrock', apiKey: 'sk-1' })).apiKey).toBeUndefined();
  });

  it('omits vertex fields for non-vertex providers even when filled', () => {
    const body = toProfileEdit(
      makeForm({ provider: 'anthropic', projectId: 'my-project', region: 'us-central1', credentialsJson: '{}' }),
    );
    expect(body.projectId).toBeUndefined();
    expect(body.region).toBeUndefined();
    expect(body.credentialsJson).toBeUndefined();
  });

  it('includes vertex fields for google_vertex only when non-blank', () => {
    const body = toProfileEdit(
      makeForm({
        provider: 'google_vertex',
        projectId: '  my-project  ',
        region: '  us-central1  ',
        credentialsJson: '{"type":"service_account"}',
      }),
    );
    expect(body.projectId).toBe('my-project');
    expect(body.region).toBe('us-central1');
    expect(body.credentialsJson).toBe('{"type":"service_account"}');
  });

  it('drops blank vertex fields', () => {
    const body = toProfileEdit(
      makeForm({ provider: 'google_vertex', projectId: '   ', region: '   ', credentialsJson: '' }),
    );
    expect(body.projectId).toBeUndefined();
    expect(body.region).toBeUndefined();
    expect(body.credentialsJson).toBeUndefined();
  });

  it('filters env entries with blank names and trims the kept names', () => {
    const body = toProfileEdit(
      makeForm({
        extraEnv: [
          { name: '   ', value: 'ignored', secret: false },
          { name: '  KEEP  ', value: 'v', secret: false },
        ],
      }),
    );
    expect(body.extraEnv).toEqual([{ name: 'KEEP', value: 'v', secret: false }]);
  });

  it('omits an env value when it is undefined to keep a stored secret', () => {
    const body = toProfileEdit(makeForm({ extraEnv: [{ name: 'TOKEN', secret: true }] }));
    expect(body.extraEnv).toEqual([{ name: 'TOKEN', secret: true }]);
    expect(body.extraEnv.map((entry) => 'value' in entry)).toEqual([false]);
  });

  it('includes an env value when it is a defined empty string', () => {
    const body = toProfileEdit(makeForm({ extraEnv: [{ name: 'EMPTY', value: '', secret: false }] }));
    expect(body.extraEnv).toEqual([{ name: 'EMPTY', value: '', secret: false }]);
  });
});

describe('validateForm', () => {
  it('rejects a blank label', () => {
    expect(validateForm(makeForm({ label: '   ', model: 'm' }))).toBe('Give the profile a name.');
  });

  it('rejects a blank model', () => {
    expect(validateForm(makeForm({ label: 'l', model: '   ' }))).toBe('Enter a model.');
  });

  it('accepts a filled form', () => {
    expect(validateForm(makeForm({ label: 'l', model: 'm' }))).toBeNull();
  });
});
