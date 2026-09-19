import type { Story } from '@ladle/react';
import { useState } from 'react';

import {
  makeAgent,
  makeSession,
  makeWorktree,
  richTranscript,
  sampleDiff,
  sampleProfiles,
  streamingTranscript,
} from '../../.ladle/data';
import type { AgentSummary, TranscriptItem, WorktreeDiff } from '../api/types';
import type { MainView } from '../state/store';
import { MainPane } from './MainPane';

const noop = () => undefined;
const loadDiff = (): Promise<WorktreeDiff> => Promise.resolve(sampleDiff);

const sideSessionId = 'session-side';
const transcripts: Record<string, TranscriptItem[]> = {
  'session-main': richTranscript(),
  [sideSessionId]: streamingTranscript(),
};
const transcriptFor = (sessionId: string): TranscriptItem[] => transcripts[sessionId] ?? [];

function Frame({ agent, initialView }: { agent: AgentSummary; initialView: MainView }) {
  const [view, setView] = useState<MainView>(initialView);
  return (
    <div style={{ height: '85vh', display: 'flex', flexDirection: 'column', border: '1px solid var(--border)' }}>
      <MainPane
        agent={agent}
        view={view}
        approvals={[]}
        transcriptFor={transcriptFor}
        onSetView={setView}
        onPrompt={noop}
        onCancel={noop}
        onResolveApproval={noop}
        onFork={noop}
        onSideSession={noop}
        loadDiff={loadDiff}
        models={sampleProfiles}
        onSetApprovalMode={noop}
        onSetModel={noop}
        onManageModels={noop}
        onArchive={noop}
        onRename={noop}
        onSetGoal={noop}
        onClearGoal={noop}
      />
    </div>
  );
}

const withSideSession = (): AgentSummary =>
  makeAgent({
    worktree: makeWorktree(),
    sessions: [makeSession(), makeSession({ id: sideSessionId, acpSessionId: 'acp-0002', label: 'Side', isMain: false })],
  });

export const SessionView: Story = () => (
  <Frame agent={withSideSession()} initialView={{ kind: 'session', sessionId: 'session-main' }} />
);

export const SettingsView: Story = () => <Frame agent={withSideSession()} initialView={{ kind: 'settings' }} />;

export const SessionViewWithActiveGoal: Story = () => (
  <Frame
    agent={makeAgent({ goal: { goal: 'Fix the failing auth tests and open a PR', maxTurns: 10, turnsUsed: 3 } })}
    initialView={{ kind: 'session', sessionId: 'session-main' }}
  />
);

export const ArchivedAgent: Story = () => (
  <Frame
    agent={makeAgent({ status: 'archived', worktree: makeWorktree() })}
    initialView={{ kind: 'session', sessionId: 'session-main' }}
  />
);
