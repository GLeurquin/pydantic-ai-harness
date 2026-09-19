import type { Story } from '@ladle/react';

import { makeAgent, makeApproval, makeToolCall } from '../../.ladle/data';
import type { AgentSummary, ApprovalView } from '../api/types';
import { Header } from './Header';

const noop = () => undefined;

const agents: AgentSummary[] = [
  makeAgent({ id: 'a1', name: 'fix-auth-bug', status: 'waiting_approval', pendingApprovals: 2 }),
  makeAgent({ id: 'a2', name: 'migrate-db', status: 'waiting_approval', pendingApprovals: 1 }),
];

const approvals: ApprovalView[] = [
  makeApproval({ id: 'ap1', agentId: 'a1' }),
  makeApproval({
    id: 'ap2',
    agentId: 'a1',
    toolCall: makeToolCall({ toolCallId: 'tool-2', title: 'Edit src/auth/session.py', kind: 'edit' }),
  }),
  makeApproval({
    id: 'ap3',
    agentId: 'a2',
    toolCall: makeToolCall({ toolCallId: 'tool-3', title: 'alembic upgrade head', kind: 'execute' }),
  }),
];

export const ConnectedWithApprovals: Story = () => (
  <div style={{ border: '1px solid var(--border)' }}>
    <Header
      connected={true}
      approvals={approvals}
      agents={agents}
      onResolveApproval={noop}
      onManageProjects={noop}
      onManageModels={noop}
      onManageGithub={noop}
      onToggleSidebar={noop}
    />
    <div style={{ height: 200 }} />
  </div>
);

export const Disconnected: Story = () => (
  <div style={{ border: '1px solid var(--border)' }}>
    <Header
      connected={false}
      approvals={[]}
      agents={[]}
      onResolveApproval={noop}
      onManageProjects={noop}
      onManageModels={noop}
      onManageGithub={noop}
      onToggleSidebar={noop}
    />
    <div style={{ height: 200 }} />
  </div>
);
