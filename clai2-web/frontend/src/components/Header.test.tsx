import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import type { AgentSummary, ApprovalView } from '../api/types';
import { Header } from './Header';

function makeAgent(id: string, name: string): AgentSummary {
  return {
    id,
    name,
    status: 'idle',
    approvalMode: 'always_ask',
    worktree: null,
    cwd: '/repo',
    sessions: [{ id: 'main', acpSessionId: null, label: 'Main', isMain: true }],
    pendingApprovals: 0,
    forkedFrom: null,
    lastError: null,
  };
}

function makeApproval(id: string, agentId: string): ApprovalView {
  return {
    id,
    agentId,
    sessionId: 'main',
    toolCall: {
      toolCallId: `tc-${id}`,
      title: `tool ${id}`,
      kind: 'execute',
      status: 'pending',
      content: [],
      locations: [],
    },
    options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
  };
}

describe('Header', () => {
  it('shows the brand text', () => {
    const { container } = render(<Header connected={true} approvals={[]} agents={[]} onResolveApproval={vi.fn()} />);
    expect(container.querySelector('.brand')).toHaveTextContent('CLAI Web');
  });

  it('shows connected state with the online class', () => {
    render(<Header connected={true} approvals={[]} agents={[]} onResolveApproval={vi.fn()} />);
    const connection = screen.getByText('connected');
    expect(connection.className).toBe('connection online');
  });

  it('shows reconnecting state with the offline class', () => {
    render(<Header connected={false} approvals={[]} agents={[]} onResolveApproval={vi.fn()} />);
    const connection = screen.getByText('reconnecting...');
    expect(connection.className).toBe('connection offline');
  });

  it('shows the badge only when approvals are pending', () => {
    const { container, rerender } = render(
      <Header connected={true} approvals={[]} agents={[]} onResolveApproval={vi.fn()} />,
    );
    expect(container.querySelector('.inbox-badge')).toBeNull();
    rerender(
      <Header
        connected={true}
        approvals={[makeApproval('ap1', 'a1'), makeApproval('ap2', 'a2')]}
        agents={[]}
        onResolveApproval={vi.fn()}
      />,
    );
    expect(container.querySelector('.inbox-badge')).toHaveTextContent('2');
  });

  it('toggles the inbox panel from the Approvals button', async () => {
    const user = userEvent.setup();
    render(<Header connected={true} approvals={[]} agents={[]} onResolveApproval={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: 'Approval inbox' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog', { name: 'Pending approvals' })).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: 'Pending approvals' })).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.queryByRole('dialog', { name: 'Pending approvals' })).toBeNull();
  });

  it('shows the empty state when nothing is pending', async () => {
    const user = userEvent.setup();
    render(<Header connected={true} approvals={[]} agents={[]} onResolveApproval={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Approval inbox' }));
    expect(screen.getByText('Nothing waiting for you.')).toBeInTheDocument();
  });

  it('lists approvals with agent names resolved from agents, falling back to the id', async () => {
    const user = userEvent.setup();
    const onResolveApproval = vi.fn();
    render(
      <Header
        connected={true}
        approvals={[makeApproval('ap1', 'a1'), makeApproval('ap2', 'ghost')]}
        agents={[makeAgent('a1', 'Alpha')]}
        onResolveApproval={onResolveApproval}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Approval inbox' }));
    const panel = screen.getByRole('dialog', { name: 'Pending approvals' });
    expect(screen.queryByText('Nothing waiting for you.')).toBeNull();
    expect(within(panel).getAllByRole('alertdialog')).toHaveLength(2);
    const first = within(panel).getByRole('alertdialog', { name: 'Approval needed: tool ap1' });
    const second = within(panel).getByRole('alertdialog', { name: 'Approval needed: tool ap2' });
    expect(within(first).getByText('Alpha')).toHaveClass('approval-agent');
    expect(within(second).getByText('ghost')).toHaveClass('approval-agent');
    await user.click(within(second).getByRole('button', { name: 'Allow once' }));
    expect(onResolveApproval).toHaveBeenCalledWith('ap2', 'allow-once');
  });
});
