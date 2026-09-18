import { useState } from 'react';

/** Small shared dialog for actions that need one name: fork, side session. */
export interface NameDialogProps {
  title: string;
  placeholder: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}

export function NameDialog({ title, placeholder, submitLabel, onSubmit, onClose }: NameDialogProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      setError('A name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label={title} onClick={(click) => click.stopPropagation()}>
        <h2>{title}</h2>
        <label>
          Name
          <input autoFocus value={name} onChange={(change) => setName(change.target.value)} placeholder={placeholder} />
        </label>
        {error ? <div className="form-error">{error}</div> : null}
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Working...' : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
