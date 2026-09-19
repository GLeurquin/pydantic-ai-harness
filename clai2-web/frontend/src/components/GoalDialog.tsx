import { useState } from 'react';

import { errorMessage } from '../errors';

const DEFAULT_MAX_TURNS = 10;

export interface GoalDialogProps {
  agentName: string;
  onSubmit: (goal: string, maxTurns: number) => Promise<void>;
  onClose: () => void;
}

/** Set an autonomous goal: the agent keeps working turn-over-turn on its own
 * until it marks the goal complete, needs a human, or hits the turn limit. */
export function GoalDialog({ agentName, onSubmit, onClose }: GoalDialogProps) {
  const [goal, setGoal] = useState('');
  const [maxTurns, setMaxTurns] = useState(String(DEFAULT_MAX_TURNS));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!goal.trim()) {
      setError('Describe what the agent should accomplish.');
      return;
    }
    const parsedMaxTurns = Number(maxTurns);
    if (!Number.isInteger(parsedMaxTurns) || parsedMaxTurns < 1) {
      setError('Max turns must be a whole number of at least 1.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(goal.trim(), parsedMaxTurns);
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="Set a goal" onClick={(click) => click.stopPropagation()}>
        <h2>Set a goal</h2>
        <p className="hint">
          {agentName} will keep working on its own, turn after turn, until the goal is met, it needs your input, or it
          reaches the turn limit.
        </p>
        <label>
          Goal
          <textarea
            autoFocus
            value={goal}
            onChange={(change) => setGoal(change.target.value)}
            placeholder="Fix the failing auth tests and open a PR"
            rows={4}
          />
        </label>
        <label>
          Max turns
          <input
            type="number"
            min={1}
            step={1}
            value={maxTurns}
            onChange={(change) => setMaxTurns(change.target.value)}
          />
        </label>
        {error ? <div className="form-error">{error}</div> : null}
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Starting...' : 'Start working toward it'}
          </button>
        </div>
      </div>
    </div>
  );
}
