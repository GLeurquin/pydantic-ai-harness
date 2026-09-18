import type { Story } from '@ladle/react';
import type { ReactNode } from 'react';

import { makeAgent, makeWorktree } from '../../.ladle/data';
import type { AgentSummary } from '../api/types';
import { Sidebar } from './Sidebar';

const noop = () => undefined;

const agents: AgentSummary[] = [
  makeAgent({
    id: 'a1',
    name: 'migrate-db',
    status: 'waiting_approval',
    pendingApprovals: 2,
    worktree: makeWorktree({ branch: 'clai/migrate-db' }),
  }),
  makeAgent({ id: 'a2', name: 'flaky-ci', status: 'error', lastError: 'agent process exited with code 1' }),
  makeAgent({ id: 'a3', name: 'fix-auth-bug', status: 'working', worktree: makeWorktree() }),
  makeAgent({ id: 'a4', name: 'update-docs', status: 'starting' }),
  makeAgent({ id: 'a5', name: 'triage-issues', status: 'idle' }),
  makeAgent({ id: 'a6', name: 'review-pr-42', status: 'idle', worktree: makeWorktree({ branch: 'clai/review-pr-42' }) }),
  makeAgent({ id: 'a7', name: 'old-refactor', status: 'archived' }),
  makeAgent({ id: 'a8', name: 'spike-caching', status: 'archived' }),
];

function Frame({ children }: { children: ReactNode }) {
  return <div style={{ width: 288, height: '80vh', display: 'flex', border: '1px solid var(--border)' }}>{children}</div>;
}

export const AllGroups: Story = () => (
  <Frame>
    <Sidebar agents={agents} selectedAgentId="a3" maxAgents={50} onSelect={noop} onNewAgent={noop} />
  </Frame>
);

export const AtCapacity: Story = () => (
  <Frame>
    <Sidebar agents={agents} selectedAgentId="a1" maxAgents={6} onSelect={noop} onNewAgent={noop} />
  </Frame>
);
