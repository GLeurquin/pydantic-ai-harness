import { useEffect, useState } from 'react';

import { api } from '../api/client';
import type { RedactedProfile } from '../api/types';
import { PROVIDER_LABELS, toProfileEdit, type ModelFormState } from '../state/providers';
import { ModelForm } from './ModelForm';

export interface ModelsDialogProps {
  onClose: () => void;
  /** Notifies the parent whenever the profile list changes. */
  onChanged?: (profiles: RedactedProfile[]) => void;
}

type Editing = { kind: 'list' } | { kind: 'new' } | { kind: 'edit'; profile: RedactedProfile };

export function ModelsDialog({ onClose, onChanged }: ModelsDialogProps) {
  const [profiles, setProfiles] = useState<RedactedProfile[]>([]);
  const [editing, setEditing] = useState<Editing>({ kind: 'list' });
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = (next: RedactedProfile[]) => {
    setProfiles(next);
    onChanged?.(next);
  };

  useEffect(() => {
    api.listModels().then(
      (loadedProfiles) => {
        setProfiles(loadedProfiles);
        setLoaded(true);
      },
      (failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
        setLoaded(true);
      },
    );
  }, []);

  const save = async (form: ModelFormState) => {
    const body = toProfileEdit(form);
    if (editing.kind === 'edit') {
      const updated = await api.updateModel(editing.profile.id, body);
      refresh(profiles.map((profile) => (profile.id === updated.id ? updated : profile)));
    } else {
      const created = await api.createModel(body);
      refresh([...profiles, created]);
    }
    setEditing({ kind: 'list' });
  };

  const remove = async (profile: RedactedProfile) => {
    setError(null);
    try {
      await api.deleteModel(profile.id);
      refresh(profiles.filter((candidate) => candidate.id !== profile.id));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog wide" role="dialog" aria-label="Model profiles" onClick={(click) => click.stopPropagation()}>
        <h2>Model profiles</h2>
        <p className="hint">
          Profiles set the provider, model, and credentials each agent runs under. Secrets are stored on the server and
          never shown again.
        </p>
        {error ? <div className="form-error">{error}</div> : null}

        {editing.kind === 'list' ? (
          <>
            {loaded && profiles.length === 0 ? <div className="hint">No profiles yet.</div> : null}
            <ul className="model-list">
              {profiles.map((profile) => (
                <li key={profile.id} className="model-list-row">
                  <span className="model-list-name">
                    {profile.label}
                    <span className="model-list-meta">
                      {PROVIDER_LABELS[profile.provider]} · {profile.model}
                    </span>
                  </span>
                  <button onClick={() => setEditing({ kind: 'edit', profile })}>Edit</button>
                  <button className="danger" onClick={() => void remove(profile)}>
                    Delete
                  </button>
                </li>
              ))}
            </ul>
            <div className="dialog-actions">
              <button onClick={onClose}>Close</button>
              <button className="primary" onClick={() => setEditing({ kind: 'new' })}>
                New profile
              </button>
            </div>
          </>
        ) : (
          <ModelForm
            {...(editing.kind === 'edit' ? { profile: editing.profile } : {})}
            onSave={save}
            onCancel={() => setEditing({ kind: 'list' })}
          />
        )}
      </div>
    </div>
  );
}
