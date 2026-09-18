import type { AgentSummary, ApprovalView, TranscriptItem, WorktreeDiff } from '../api/types';
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
  onSetApprovalMode: SettingsPanelProps['onSetApprovalMode'];
  onArchive: SettingsPanelProps['onArchive'];
  onRename: SettingsPanelProps['onRename'];
}

export function MainPane(props: MainPaneProps) {
  const { agent, view } = props;
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
          onFork={props.onFork}
          onSideSession={props.onSideSession}
        />
      ) : null}
      {view.kind === 'changes' ? <DiffPanel agentId={agent.id} loadDiff={props.loadDiff} /> : null}
      {view.kind === 'settings' ? (
        <SettingsPanel
          agent={agent}
          onSetApprovalMode={props.onSetApprovalMode}
          onArchive={props.onArchive}
          onRename={props.onRename}
        />
      ) : null}
    </main>
  );
}
