import { useState } from 'react';

import type { RedactedProfile } from '../api/types';
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
} from '../state/providers';

export interface ModelFormProps {
  /** Profile to edit, or undefined to create a new one. */
  profile?: RedactedProfile;
  onSave: (form: ModelFormState) => Promise<void>;
  onCancel: () => void;
}

export function ModelForm({ profile, onSave, onCancel }: ModelFormProps) {
  const [form, setForm] = useState<ModelFormState>(() => (profile ? formFromProfile(profile) : emptyForm()));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fields = providerFields(form.provider);
  const editing = profile !== undefined;

  const set = <K extends keyof ModelFormState>(key: K, value: ModelFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    const invalid = validateForm(form);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(form);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  };

  return (
    <div className="model-form">
      <label>
        Name
        <input value={form.label} onChange={(change) => set('label', change.target.value)} placeholder="Vertex Gemini" />
      </label>
      <label>
        Provider
        <select value={form.provider} onChange={(change) => set('provider', change.target.value as ModelFormState['provider'])}>
          {PROVIDERS.map((provider) => (
            <option key={provider} value={provider}>
              {PROVIDER_LABELS[provider]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Model
        <input
          value={form.model}
          onChange={(change) => set('model', change.target.value)}
          placeholder={modelPlaceholder(form.provider)}
        />
      </label>

      {fields.apiKey ? (
        <label>
          API key
          <input
            type="password"
            value={form.apiKey}
            onChange={(change) => set('apiKey', change.target.value)}
            placeholder={editing ? 'unchanged' : ''}
          />
        </label>
      ) : null}

      {fields.vertex ? (
        <>
          <label>
            Google Cloud project
            <input value={form.projectId} onChange={(change) => set('projectId', change.target.value)} placeholder="my-project" />
          </label>
          <label>
            Region
            <input value={form.region} onChange={(change) => set('region', change.target.value)} placeholder="us-central1" />
          </label>
          <label>
            Service account JSON
            <textarea
              value={form.credentialsJson}
              onChange={(change) => set('credentialsJson', change.target.value)}
              placeholder={editing ? 'unchanged' : '{ "type": "service_account", ... }'}
              rows={4}
            />
          </label>
        </>
      ) : null}

      <fieldset className="env-editor">
        <legend>Environment variables</legend>
        {form.extraEnv.map((entry, index) => (
          <div className="env-row" key={index}>
            <input
              aria-label={`env name ${index}`}
              value={entry.name}
              placeholder="NAME"
              onChange={(change) =>
                set(
                  'extraEnv',
                  form.extraEnv.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, name: change.target.value } : item,
                  ),
                )
              }
            />
            <input
              aria-label={`env value ${index}`}
              value={entry.value ?? ''}
              type={entry.secret ? 'password' : 'text'}
              placeholder={entry.value === undefined ? 'unchanged' : 'value'}
              onChange={(change) =>
                set(
                  'extraEnv',
                  form.extraEnv.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, value: change.target.value } : item,
                  ),
                )
              }
            />
            <label className="env-secret">
              <input
                type="checkbox"
                checked={entry.secret}
                onChange={(change) =>
                  set(
                    'extraEnv',
                    form.extraEnv.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, secret: change.target.checked } : item,
                    ),
                  )
                }
              />
              secret
            </label>
            <button
              className="danger"
              aria-label={`remove env ${index}`}
              onClick={() => set('extraEnv', form.extraEnv.filter((_, itemIndex) => itemIndex !== index))}
            >
              &times;
            </button>
          </div>
        ))}
        <button onClick={() => set('extraEnv', [...form.extraEnv, { name: '', value: '', secret: false }])}>
          Add variable
        </button>
      </fieldset>

      {error ? <div className="form-error">{error}</div> : null}
      <div className="dialog-actions">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Saving...' : editing ? 'Save changes' : 'Add profile'}
        </button>
      </div>
    </div>
  );
}

/** Convert form state to the request body; re-exported for tests and callers. */
export { toProfileEdit };
