import { useState } from 'react';

import type { RedactedGithubSettings } from '../api/types';
import { errorMessage } from '../errors';

export interface GithubSettingsDialogProps {
  settings: RedactedGithubSettings;
  onSaveToken: (token: string) => Promise<void>;
  onClearToken: () => Promise<void>;
  onSavePollInterval: (pollIntervalSecs: number) => Promise<void>;
  onClose: () => void;
}

/** GitHub settings shared by every agent: the personal access token used to
 * import issues and poll CI status, and the base CI-polling interval. */
export function GithubSettingsDialog({
  settings,
  onSaveToken,
  onClearToken,
  onSavePollInterval,
  onClose,
}: GithubSettingsDialogProps) {
  const [tokenDraft, setTokenDraft] = useState('');
  const [pollMinutes, setPollMinutes] = useState(() => String(settings.pollIntervalSecs / 60));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const saveToken = async () => {
    if (!tokenDraft.trim()) {
      setError('Enter a token.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSaveToken(tokenDraft.trim());
      setTokenDraft('');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const clearToken = async () => {
    setBusy(true);
    setError(null);
    try {
      await onClearToken();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const savePollInterval = async () => {
    const minutes = Number(pollMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      setError('Poll interval must be a positive number of minutes.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSavePollInterval(Math.round(minutes * 60));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="GitHub settings" onClick={(click) => click.stopPropagation()}>
        <h2>GitHub settings</h2>
        <p className="hint">
          Used to import issues as an agent's starting prompt, and to poll a tracked pull request's CI checks.
        </p>
        {error ? <div className="form-error">{error}</div> : null}

        <label>
          Personal access token
          <input
            type="password"
            value={tokenDraft}
            onChange={(change) => setTokenDraft(change.target.value)}
            placeholder={settings.hasToken ? 'unchanged' : 'ghp_...'}
          />
        </label>
        <div className="dialog-row">
          <button onClick={() => void saveToken()} disabled={busy}>
            Save token
          </button>
          {settings.hasToken ? (
            <button className="danger" onClick={() => void clearToken()} disabled={busy}>
              Clear token
            </button>
          ) : null}
        </div>

        <label>
          Poll interval (minutes)
          <input
            type="number"
            min={0.5}
            step={0.5}
            value={pollMinutes}
            onChange={(change) => setPollMinutes(change.target.value)}
          />
        </label>
        <p className="hint">Backs off toward once a day while a tracked PR's CI status stays unchanged.</p>
        <div className="dialog-row">
          <button onClick={() => void savePollInterval()} disabled={busy}>
            Save interval
          </button>
        </div>

        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
