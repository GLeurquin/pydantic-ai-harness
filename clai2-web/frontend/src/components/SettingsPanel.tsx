import { useState } from 'react';

import type { AgentSummary, ApprovalMode } from '../api/types';

export interface SettingsPanelProps {
  agent: AgentSummary;
  onSetApprovalMode: (mode: ApprovalMode) => void;
  onArchive: (removeWorktree: boolean) => void;
  onRename: (name: string) => void;
}

export const MODE_LABELS: Record<ApprovalMode, string> = {
  always_ask: 'Always ask',
  accept_edits: 'Accept edits',
  auto: 'Auto-approve everything',
};

/** Keyed by `agent.id` in `SettingsPanel` so the draft resets when the
 * selected agent changes, without clobbering an in-progress edit on a
 * remote rename of the same agent. */
function NameField({ agent, onRename }: { agent: AgentSummary; onRename: (name: string) => void }) {
  const [draft, setDraft] = useState(agent.name);
  const archived = agent.status === 'archived';
  const trimmed = draft.trim();
  const dirty = trimmed !== '' && trimmed !== agent.name;
  return (
    <section>
      <h3>Name</h3>
      <div className="settings-row">
        <input
          value={draft}
          onChange={(change) => setDraft(change.target.value)}
          disabled={archived}
          aria-label="Agent name"
        />
        <button className="primary" disabled={!dirty || archived} onClick={() => onRename(trimmed)}>
          Rename
        </button>
      </div>
    </section>
  );
}

export function SettingsPanel({ agent, onSetApprovalMode, onArchive, onRename }: SettingsPanelProps) {
  const archived = agent.status === 'archived';
  return (
    <div className="settings">
      <NameField key={agent.id} agent={agent} onRename={onRename} />

      <section>
        <h3>Approval mode</h3>
        <div className="settings-row">
          <select
            value={agent.approvalMode}
            onChange={(change) => onSetApprovalMode(change.target.value as ApprovalMode)}
            disabled={archived}
            aria-label="Approval mode"
          >
            {Object.entries(MODE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {agent.approvalMode === 'auto' ? (
            <span className="mode-auto-warning">Every tool call runs without asking.</span>
          ) : null}
        </div>
        <p className="hint">Applies to permission requests arriving after the change.</p>
      </section>

      <section>
        <h3>Workspace</h3>
        <dl className="kv">
          <dt>Directory</dt>
          <dd>{agent.cwd}</dd>
          {agent.worktree ? (
            <>
              <dt>Branch</dt>
              <dd>{agent.worktree.branch}</dd>
              <dt>Base branch</dt>
              <dd>{agent.worktree.baseBranch}</dd>
            </>
          ) : null}
          {agent.forkedFrom ? (
            <>
              <dt>Forked from</dt>
              <dd>{agent.forkedFrom}</dd>
            </>
          ) : null}
          {agent.lastError ? (
            <>
              <dt>Last error</dt>
              <dd>{agent.lastError}</dd>
            </>
          ) : null}
        </dl>
      </section>

      {archived ? null : (
        <section className="danger-zone">
          <h3>Archive agent</h3>
          <p className="hint">Stops the agent process. The conversation history is kept.</p>
          <div className="settings-row">
            <button className="danger" onClick={() => onArchive(false)}>
              Archive
            </button>
            {agent.worktree ? (
              <button className="danger" onClick={() => onArchive(true)}>
                Archive and remove worktree
              </button>
            ) : null}
          </div>
        </section>
      )}
    </div>
  );
}
