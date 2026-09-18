import type { Story } from '@ladle/react';
import type { ReactNode } from 'react';

import { makeAgent, makeWorktree } from '../../.ladle/data';
import { AgentRow } from './AgentRow';

const noop = () => undefined;

function Row({ children }: { children: ReactNode }) {
  return <div style={{ width: 288, border: '1px solid var(--border)' }}>{children}</div>;
}

export const Idle: Story = () => (
  <Row>
    <AgentRow agent={makeAgent({ name: 'triage-issues', status: 'idle' })} selected={false} onSelect={noop} />
  </Row>
);

export const WorkingWithBranch: Story = () => (
  <Row>
    <AgentRow
      agent={makeAgent({ name: 'fix-auth-bug', status: 'working', worktree: makeWorktree() })}
      selected={false}
      onSelect={noop}
    />
  </Row>
);

export const WaitingApprovalWithBadge: Story = () => (
  <Row>
    <AgentRow
      agent={makeAgent({ name: 'migrate-db', status: 'waiting_approval', pendingApprovals: 2 })}
      selected={false}
      onSelect={noop}
    />
  </Row>
);

export const Selected: Story = () => (
  <Row>
    <AgentRow
      agent={makeAgent({ name: 'fix-auth-bug', status: 'working', worktree: makeWorktree() })}
      selected={true}
      onSelect={noop}
    />
  </Row>
);

export const Archived: Story = () => (
  <Row>
    <AgentRow agent={makeAgent({ name: 'old-refactor', status: 'archived' })} selected={false} onSelect={noop} />
  </Row>
);
