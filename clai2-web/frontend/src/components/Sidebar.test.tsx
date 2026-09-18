import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import type { AgentStatus, AgentSummary } from '../api/types';
import { Sidebar } from './Sidebar';

function makeAgent(id: string, name: string, status: AgentStatus): AgentSummary {
  return {
    id,
    name,
    status,
    approvalMode: 'always_ask',
    worktree: null,
    cwd: '/repo',
    sessions: [{ id: 'main', acpSessionId: null, label: 'Main', isMain: true }],
    pendingApprovals: 0,
    forkedFrom: null,
    lastError: null,
  };
}

describe('Sidebar', () => {
  it('renders the groups in order with only non-empty groups', () => {
    const agents = [
      makeAgent('a1', 'Idler', 'idle'),
      makeAgent('a2', 'Worker', 'working'),
      makeAgent('a3', 'Booter', 'starting'),
      makeAgent('a4', 'Waiter', 'waiting_approval'),
      makeAgent('a5', 'Broken', 'error'),
      makeAgent('a6', 'Retired', 'archived'),
    ];
    const { container } = render(
      <Sidebar agents={agents} selectedAgentId={null} maxAgents={50} onSelect={vi.fn()} onNewAgent={vi.fn()} />,
    );
    const titles = Array.from(container.querySelectorAll('.sidebar-group-title')).map((node) => node.textContent);
    expect(titles).toEqual(['Needs attention', 'Working', 'Idle', 'Archived']);
    const attention = screen.getByRole('region', { name: 'Needs attention' });
    expect(Array.from(attention.querySelectorAll('.agent-row-name')).map((node) => node.textContent)).toEqual([
      'Waiter',
      'Broken',
    ]);
    const working = screen.getByRole('region', { name: 'Working' });
    expect(Array.from(working.querySelectorAll('.agent-row-name')).map((node) => node.textContent)).toEqual([
      'Worker',
      'Booter',
    ]);
  });

  it('omits empty groups', () => {
    const { container } = render(
      <Sidebar
        agents={[makeAgent('a1', 'Idler', 'idle')]}
        selectedAgentId={null}
        maxAgents={50}
        onSelect={vi.fn()}
        onNewAgent={vi.fn()}
      />,
    );
    const titles = Array.from(container.querySelectorAll('.sidebar-group-title')).map((node) => node.textContent);
    expect(titles).toEqual(['Idle']);
  });

  it('narrows agents through the filter input', async () => {
    const user = userEvent.setup();
    render(
      <Sidebar
        agents={[makeAgent('a1', 'Alpha', 'idle'), makeAgent('a2', 'Beta', 'idle')]}
        selectedAgentId={null}
        maxAgents={50}
        onSelect={vi.fn()}
        onNewAgent={vi.fn()}
      />,
    );
    await user.type(screen.getByLabelText('Filter agents'), 'alp');
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).toBeNull();
  });

  it('disables New at capacity, counting only live agents', () => {
    const { rerender } = render(
      <Sidebar
        agents={[makeAgent('a1', 'Alpha', 'idle'), makeAgent('a2', 'Beta', 'working')]}
        selectedAgentId={null}
        maxAgents={2}
        onSelect={vi.fn()}
        onNewAgent={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'New' })).toBeDisabled();
    rerender(
      <Sidebar
        agents={[makeAgent('a1', 'Alpha', 'idle'), makeAgent('a2', 'Beta', 'archived')]}
        selectedAgentId={null}
        maxAgents={2}
        onSelect={vi.fn()}
        onNewAgent={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'New' })).toBeEnabled();
  });

  it('shows the live-count capacity line', () => {
    const { container } = render(
      <Sidebar
        agents={[makeAgent('a1', 'Alpha', 'idle'), makeAgent('a2', 'Beta', 'archived')]}
        selectedAgentId={null}
        maxAgents={50}
        onSelect={vi.fn()}
        onNewAgent={vi.fn()}
      />,
    );
    expect(container.querySelector('.capacity')).toHaveTextContent('1/50 agents');
  });

  it('fires onNewAgent and onSelect', async () => {
    const user = userEvent.setup();
    const onNewAgent = vi.fn();
    const onSelect = vi.fn();
    render(
      <Sidebar
        agents={[makeAgent('a1', 'Alpha', 'idle')]}
        selectedAgentId={null}
        maxAgents={50}
        onSelect={onSelect}
        onNewAgent={onNewAgent}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'New' }));
    expect(onNewAgent).toHaveBeenCalledTimes(1);
    await user.click(screen.getByText('Alpha'));
    expect(onSelect).toHaveBeenCalledWith('a1');
  });

  it('marks the selected agent row', () => {
    render(
      <Sidebar
        agents={[makeAgent('a1', 'Alpha', 'idle'), makeAgent('a2', 'Beta', 'idle')]}
        selectedAgentId="a2"
        maxAgents={50}
        onSelect={vi.fn()}
        onNewAgent={vi.fn()}
      />,
    );
    expect(screen.getByText('Beta').closest('button')).toHaveClass('selected');
    expect(screen.getByText('Alpha').closest('button')).not.toHaveClass('selected');
  });
});
