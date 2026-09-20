import { useState } from 'react';

import type { CreatedPullRequest } from '../api/types';
import { errorMessage } from '../errors';

export interface CommitDialogProps {
  agentName: string;
  defaultMessage: string;
  onCommit: (message: string) => Promise<void>;
  onOpenPullRequest: (title: string, body: string) => Promise<CreatedPullRequest>;
  onClose: () => void;
}

/** Commit the worktree's changes, with an optional "also open a pull request" step
 * folded into the same dialog rather than a separate flow. */
export function CommitDialog({ agentName, defaultMessage, onCommit, onOpenPullRequest, onClose }: CommitDialogProps) {
  const [message, setMessage] = useState(defaultMessage);
  const [openPr, setOpenPr] = useState(false);
  const [title, setTitle] = useState(defaultMessage);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdPr, setCreatedPr] = useState<CreatedPullRequest | null>(null);

  const submit = async () => {
    if (!message.trim()) {
      setError('Describe what changed.');
      return;
    }
    if (openPr && !title.trim()) {
      setError('Give the pull request a title.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCommit(message.trim());
      if (openPr) {
        setCreatedPr(await onOpenPullRequest(title.trim(), body.trim()));
        setBusy(false);
        return;
      }
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  if (createdPr) {
    return (
      <div className="dialog-backdrop" onClick={onClose}>
        <div
          className="dialog"
          role="dialog"
          aria-label={`Pull request opened for ${agentName}`}
          onClick={(click) => click.stopPropagation()}
        >
          <h2>Pull request opened</h2>
          <p className="hint">
            <a href={createdPr.url} target="_blank" rel="noreferrer">
              #{createdPr.number} on GitHub
            </a>
          </p>
          <div className="dialog-actions">
            <button className="primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-label={`Commit changes in ${agentName}`}
        onClick={(click) => click.stopPropagation()}
      >
        <h2>Commit changes</h2>
        <label>
          Commit message
          <textarea autoFocus value={message} onChange={(change) => setMessage(change.target.value)} rows={3} />
        </label>
        <div className="dialog-row">
          <input id="open-pr" type="checkbox" checked={openPr} onChange={(change) => setOpenPr(change.target.checked)} />
          <label htmlFor="open-pr">Also open a pull request</label>
        </div>
        {openPr ? (
          <>
            <label>
              Pull request title
              <input value={title} onChange={(change) => setTitle(change.target.value)} />
            </label>
            <label>
              Description
              <textarea
                value={body}
                onChange={(change) => setBody(change.target.value)}
                rows={4}
                placeholder="Optional"
              />
            </label>
          </>
        ) : null}
        {error ? <div className="form-error">{error}</div> : null}
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Working...' : openPr ? 'Commit and open PR' : 'Commit'}
          </button>
        </div>
      </div>
    </div>
  );
}
