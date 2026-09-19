import { useState } from 'react';

import type { ProfileEdit, RedactedProfile } from '../api/types';
import { errorMessage } from '../errors';
import { PROVIDER_LABELS, toProfileEdit, type ModelFormState } from '../state/providers';
import { ModelForm } from './ModelForm';

export interface ModelsDialogProps {
  profiles: RedactedProfile[];
  onCreate: (body: ProfileEdit) => Promise<RedactedProfile>;
  onUpdate: (profileId: string, body: ProfileEdit) => Promise<RedactedProfile>;
  onDelete: (profileId: string) => Promise<void>;
  onClose: () => void;
}

type Editing = { kind: 'list' } | { kind: 'new' } | { kind: 'edit'; profile: RedactedProfile };

export function ModelsDialog({ profiles, onCreate, onUpdate, onDelete, onClose }: ModelsDialogProps) {
  const [editing, setEditing] = useState<Editing>({ kind: 'list' });
  const [error, setError] = useState<string | null>(null);

  const save = async (form: ModelFormState) => {
    const body = toProfileEdit(form);
    if (editing.kind === 'edit') {
      await onUpdate(editing.profile.id, body);
    } else {
      await onCreate(body);
    }
    setEditing({ kind: 'list' });
  };

  const remove = async (profile: RedactedProfile) => {
    setError(null);
    try {
      await onDelete(profile.id);
    } catch (failure) {
      setError(errorMessage(failure));
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
            {profiles.length === 0 ? <div className="hint">No profiles yet.</div> : null}
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
