import type { Story } from '@ladle/react';

import { makeAgent, makeWorktree } from '../../.ladle/data';
import { SettingsPanel } from './SettingsPanel';

const noop = () => undefined;

export const AlwaysAskWithWorktree: Story = () => (
  <SettingsPanel
    agent={makeAgent({ approvalMode: 'always_ask', worktree: makeWorktree() })}
    onSetApprovalMode={noop}
    onArchive={noop}
    onRename={noop}
  />
);

export const AutoModeWarning: Story = () => (
  <SettingsPanel
    agent={makeAgent({ approvalMode: 'auto', forkedFrom: 'triage-issues' })}
    onSetApprovalMode={noop}
    onArchive={noop}
    onRename={noop}
  />
);

export const ArchivedAgent: Story = () => (
  <SettingsPanel
    agent={makeAgent({
      status: 'archived',
      worktree: makeWorktree(),
      lastError: 'agent process exited with code 1',
    })}
    onSetApprovalMode={noop}
    onArchive={noop}
    onRename={noop}
  />
);
