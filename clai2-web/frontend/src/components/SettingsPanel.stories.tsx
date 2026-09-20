import type { Story } from '@ladle/react';

import { makeAgent, makeWorktree, sampleProfiles } from '../../.ladle/data';
import { SettingsPanel } from './SettingsPanel';

const noop = () => undefined;

export const AlwaysAskWithWorktree: Story = () => (
  <SettingsPanel
    agent={makeAgent({ approvalMode: 'always_ask', worktree: makeWorktree(), modelProfileId: 'profile-1' })}
    models={sampleProfiles}
    folders={[]}
    onSetApprovalMode={noop}
    onSetModel={noop}
    onManageModels={noop}
    onSetFolder={noop}
    onManageFolders={noop}
    onArchive={noop}
    onRename={noop}
    onSetGoal={noop}
    onClearGoal={noop}
    onSetCiTracking={noop}
    onClearCiTracking={noop}
    onViewDebugContext={noop}
  />
);

export const AutoModeWarning: Story = () => (
  <SettingsPanel
    agent={makeAgent({ approvalMode: 'auto', forkedFrom: 'triage-issues' })}
    models={sampleProfiles}
    folders={[]}
    onSetApprovalMode={noop}
    onSetModel={noop}
    onManageModels={noop}
    onSetFolder={noop}
    onManageFolders={noop}
    onArchive={noop}
    onRename={noop}
    onSetGoal={noop}
    onClearGoal={noop}
    onSetCiTracking={noop}
    onClearCiTracking={noop}
    onViewDebugContext={noop}
  />
);

export const WithActiveGoal: Story = () => (
  <SettingsPanel
    agent={makeAgent({ goal: { goal: 'Fix the failing auth tests and open a PR', maxTurns: 10, turnsUsed: 3 } })}
    models={sampleProfiles}
    folders={[]}
    onSetApprovalMode={noop}
    onSetModel={noop}
    onManageModels={noop}
    onSetFolder={noop}
    onManageFolders={noop}
    onArchive={noop}
    onRename={noop}
    onSetGoal={noop}
    onClearGoal={noop}
    onSetCiTracking={noop}
    onClearCiTracking={noop}
    onViewDebugContext={noop}
  />
);

export const WithFailingCi: Story = () => (
  <SettingsPanel
    agent={makeAgent({ ciTracking: { prRef: 'pydantic/pydantic-ai#123', lastState: 'failure' } })}
    models={sampleProfiles}
    folders={[]}
    onSetApprovalMode={noop}
    onSetModel={noop}
    onManageModels={noop}
    onSetFolder={noop}
    onManageFolders={noop}
    onArchive={noop}
    onRename={noop}
    onSetGoal={noop}
    onClearGoal={noop}
    onSetCiTracking={noop}
    onClearCiTracking={noop}
    onViewDebugContext={noop}
  />
);

export const ArchivedAgent: Story = () => (
  <SettingsPanel
    agent={makeAgent({
      status: 'archived',
      worktree: makeWorktree(),
      lastError: 'agent process exited with code 1',
    })}
    models={sampleProfiles}
    folders={[]}
    onSetApprovalMode={noop}
    onSetModel={noop}
    onManageModels={noop}
    onSetFolder={noop}
    onManageFolders={noop}
    onArchive={noop}
    onRename={noop}
    onSetGoal={noop}
    onClearGoal={noop}
    onSetCiTracking={noop}
    onClearCiTracking={noop}
    onViewDebugContext={noop}
  />
);
