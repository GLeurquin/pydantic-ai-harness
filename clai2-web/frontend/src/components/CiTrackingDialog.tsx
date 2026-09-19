import { useState } from 'react';

import { errorMessage } from '../errors';

export interface CiTrackingDialogProps {
  agentName: string;
  onSubmit: (prRef: string) => Promise<void>;
  onClose: () => void;
}

/** Start polling a GitHub pull request's CI checks in the background: the
 * agent gets auto-prompted the moment the checks turn failing. */
export function CiTrackingDialog({ agentName, onSubmit, onClose }: CiTrackingDialogProps) {
  const [prRef, setPrRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!prRef.trim()) {
      setError('Give the pull request to track.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(prRef.trim());
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="Track a PR" onClick={(click) => click.stopPropagation()}>
        <h2>Track a PR</h2>
        <p className="hint">{agentName} will get a prompt the moment this PR's CI checks turn failing.</p>
        <label>
          Pull request
          <input
            autoFocus
            value={prRef}
            onChange={(change) => setPrRef(change.target.value)}
            placeholder="owner/repo#123 or a github.com pull request URL"
          />
        </label>
        {error ? <div className="form-error">{error}</div> : null}
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Starting...' : 'Start tracking'}
          </button>
        </div>
      </div>
    </div>
  );
}
