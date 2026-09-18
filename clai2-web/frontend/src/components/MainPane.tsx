import type { AgentSummary, ApprovalView, RedactedProfile, TranscriptItem, WorktreeDiff } from '../api/types';
import type { MainView } from '../state/store';
import { Conversation } from './Conversation';
import { DiffPanel } from './DiffPanel';
import { SettingsPanel } from './SettingsPanel';
import type { SettingsPanelProps } from './SettingsPanel';

export interface MainPaneProps {
  agent: AgentSummary;
  view: MainView;
  approvals: ApprovalView[];
  transcriptFor: (sessionId: string) => TranscriptItem[];
  onSetView: (view: MainView) => void;
  onPrompt: (sessionId: string, text: string) => void;
  onCancel: () => void;
  onResolveApproval: (approvalId: string, optionId: string) => void;
  onFork: () => void;
  onSideSession: () => void;
  loadDiff: (agentId: string) => Promise<WorktreeDiff>;
  models: RedactedProfile[];
  onSetApprovalMode: SettingsPanelProps['onSetApprovalMode'];
  onSetModel: SettingsPanelProps['onSetModel'];
  onManageModels: SettingsPanelProps['onManageModels'];
  onArchive: SettingsPanelProps['onArchive'];
}

export function MainPane(props: MainPaneProps) {
  const { agent, view } = props;
  const archived = agent.status === 'archived';
  return (
    <main className="main">
      <div className="tabs" role="tablist">
        {agent.sessions.map((session) => (
          <button
            key={session.id}
            role="tab"
            className={view.kind === 'session' && view.sessionId === session.id ? 'tab active' : 'tab'}
            aria-selected={view.kind === 'session' && view.sessionId === session.id}
            onClick={() => props.onSetView({ kind: 'session', sessionId: session.id })}
          >
            {session.label}
          </button>
        ))}
        {agent.worktree ? (
          <button
            role="tab"
            className={view.kind === 'changes' ? 'tab active' : 'tab'}
            aria-selected={view.kind === 'changes'}
            onClick={() => props.onSetView({ kind: 'changes' })}
          >
            Changes
          </button>
        ) : null}
        <button
          role="tab"
          className={view.kind === 'settings' ? 'tab active' : 'tab'}
          aria-selected={view.kind === 'settings'}
          onClick={() => props.onSetView({ kind: 'settings' })}
        >
          Settings
        </button>
        <span className="tab-actions">
          {archived ? null : (
            <>
              <button onClick={props.onSideSession} title="Open a side conversation with this agent">
                Side conversation
              </button>
              <button onClick={props.onFork} title="Fork this agent into a new worktree">
                Fork
              </button>
            </>
          )}
        </span>
      </div>
      {view.kind === 'session' ? (
        <Conversation
          agent={agent}
          sessionId={view.sessionId}
          items={props.transcriptFor(view.sessionId)}
          approvals={props.approvals}
          onPrompt={(text) => props.onPrompt(view.sessionId, text)}
          onCancel={props.onCancel}
          onResolveApproval={props.onResolveApproval}
        />
      ) : null}
      {view.kind === 'changes' ? <DiffPanel agentId={agent.id} loadDiff={props.loadDiff} /> : null}
      {view.kind === 'settings' ? (
        <SettingsPanel
          agent={agent}
          models={props.models}
          onSetApprovalMode={props.onSetApprovalMode}
          onSetModel={props.onSetModel}
          onManageModels={props.onManageModels}
          onArchive={props.onArchive}
        />
      ) : null}
    </main>
  );
}
