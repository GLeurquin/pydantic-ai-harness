import type { AgentSummary, ApprovalView, FolderSummary, RedactedProfile, TranscriptItem, WorktreeDiff } from '../api/types';
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
  folders: FolderSummary[];
  onSetApprovalMode: SettingsPanelProps['onSetApprovalMode'];
  onSetModel: SettingsPanelProps['onSetModel'];
  onManageModels: SettingsPanelProps['onManageModels'];
  onSetFolder: SettingsPanelProps['onSetFolder'];
  onManageFolders: SettingsPanelProps['onManageFolders'];
  onArchive: SettingsPanelProps['onArchive'];
  onRename: SettingsPanelProps['onRename'];
  onSetGoal: SettingsPanelProps['onSetGoal'];
  onClearGoal: SettingsPanelProps['onClearGoal'];
  onSetCiTracking: SettingsPanelProps['onSetCiTracking'];
  onClearCiTracking: SettingsPanelProps['onClearCiTracking'];
  onViewDebugContext: SettingsPanelProps['onViewDebugContext'];
}

export function MainPane(props: MainPaneProps) {
  const { agent, view } = props;
  const activeSession = view.kind === 'session' ? agent.sessions.find((session) => session.id === view.sessionId) : undefined;
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
        {agent.goal || agent.ciTracking || (activeSession && activeSession.totalTokens > 0) ? (
          <div className="tabs-meta">
            {agent.goal ? (
              <span className="tabs-goal" title={agent.goal.goal}>
                Goal: turn {agent.goal.turnsUsed}/{agent.goal.maxTurns}
              </span>
            ) : null}
            {agent.ciTracking ? (
              <span
                className={agent.ciTracking.lastState === 'failure' ? 'tabs-ci failing' : 'tabs-ci'}
                title={agent.ciTracking.prRef}
              >
                CI: {agent.ciTracking.lastState}
              </span>
            ) : null}
            {activeSession && activeSession.totalTokens > 0 ? (
              <span className="tabs-usage" title="Total tokens used in this session">
                {activeSession.totalInputTokens.toLocaleString()} in / {activeSession.totalOutputTokens.toLocaleString()}{' '}
                out
              </span>
            ) : null}
          </div>
        ) : null}
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
          models={props.models}
          folders={props.folders}
          onSetApprovalMode={props.onSetApprovalMode}
          onSetModel={props.onSetModel}
          onManageModels={props.onManageModels}
          onSetFolder={props.onSetFolder}
          onManageFolders={props.onManageFolders}
          onArchive={props.onArchive}
          onRename={props.onRename}
          onSetGoal={props.onSetGoal}
          onClearGoal={props.onClearGoal}
          onSetCiTracking={props.onSetCiTracking}
          onClearCiTracking={props.onClearCiTracking}
          onViewDebugContext={props.onViewDebugContext}
        />
      ) : null}
    </main>
  );
}
