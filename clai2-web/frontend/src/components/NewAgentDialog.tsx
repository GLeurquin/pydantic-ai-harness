import { useState } from 'react';

import type { ApprovalMode, CreateAgentRequest, RedactedProfile } from '../api/types';
import { MODE_LABELS } from './SettingsPanel';

export interface NewAgentDialogProps {
  models: RedactedProfile[];
  onCreate: (request: CreateAgentRequest) => Promise<void>;
  onClose: () => void;
  onManageModels: () => void;
}

export function NewAgentDialog({ models, onCreate, onClose, onManageModels }: NewAgentDialogProps) {
  const [name, setName] = useState('');
  const [useWorktree, setUseWorktree] = useState(true);
  const [baseBranch, setBaseBranch] = useState('');
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('always_ask');
  const [modelProfileId, setModelProfileId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      setError('Give the agent a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const request: CreateAgentRequest = { name: name.trim(), useWorktree, approvalMode };
      if (useWorktree && baseBranch.trim()) {
        request.baseBranch = baseBranch.trim();
      }
      if (modelProfileId) {
        request.modelProfileId = modelProfileId;
      }
      await onCreate(request);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="New agent" onClick={(click) => click.stopPropagation()}>
        <h2>New agent</h2>
        <label>
          Name
          <input
            autoFocus
            value={name}
            onChange={(change) => setName(change.target.value)}
            placeholder="fix-auth-bug"
          />
        </label>
        <div className="dialog-row">
          <input
            id="use-worktree"
            type="checkbox"
            checked={useWorktree}
            onChange={(change) => setUseWorktree(change.target.checked)}
          />
          <label htmlFor="use-worktree">Create an isolated worktree and branch</label>
        </div>
        {useWorktree ? (
          <label>
            Base branch (blank for the current branch)
            <input value={baseBranch} onChange={(change) => setBaseBranch(change.target.value)} placeholder="main" />
          </label>
        ) : null}
        <label>
          Approval mode
          <select value={approvalMode} onChange={(change) => setApprovalMode(change.target.value as ApprovalMode)}>
            {Object.entries(MODE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model
          <select value={modelProfileId} onChange={(change) => setModelProfileId(change.target.value)}>
            <option value="">Default (server environment)</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>
        <button className="link-button" onClick={onManageModels}>
          Manage model profiles
        </button>
        {error ? <div className="form-error">{error}</div> : null}
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Starting...' : 'Start agent'}
          </button>
        </div>
      </div>
    </div>
  );
}
