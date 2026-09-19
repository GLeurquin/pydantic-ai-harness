import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import type { AgentStatus, AgentSummary, ProjectSummary } from '../api/types';
import { Sidebar } from './Sidebar';

function makeAgent(id: string, name: string, status: AgentStatus, projectId = 'p1'): AgentSummary {
  return {
    id,
    name,
    projectId,
    status,
    approvalMode: 'always_ask',
    worktree: null,
    cwd: '/repo',
    sessions: [{ id: 'main', acpSessionId: null, label: 'Main', isMain: true, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 }],
    pendingApprovals: 0,
    forkedFrom: null,
    modelProfileId: null,
    modelLabel: null,
    lastError: null,
    goal: null,
    ciTracking: null,
  };
}

const projects: ProjectSummary[] = [
  { id: 'p1', name: 'clai', repoRoot: '/repo' },
  { id: 'p2', name: 'other-repo', repoRoot: '/other' },
];

const baseProps = {
  projects,
  selectedProjectId: 'all' as const,
  maxAgents: 50,
  open: false,
  onSelect: vi.fn(),
  onSelectProject: vi.fn(),
  onNewAgent: vi.fn(),
};

beforeEach(() => {
  localStorage.clear();
});

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
    const { container } = render(<Sidebar {...baseProps} agents={agents} selectedAgentId={null} />);
    const titles = Array.from(container.querySelectorAll('.sidebar-group-title')).map((node) => node.textContent);
    expect(titles).toEqual(['▾Needs attention', '▾Working', '▾Idle', '▾Archived']);
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
      <Sidebar {...baseProps} agents={[makeAgent('a1', 'Idler', 'idle')]} selectedAgentId={null} />,
    );
    const titles = Array.from(container.querySelectorAll('.sidebar-group-title')).map((node) => node.textContent);
    expect(titles).toEqual(['▾Idle']);
  });

  it('collapses and expands a group from its title, persisting across remounts', async () => {
    const user = userEvent.setup();
    const agents = [makeAgent('a1', 'Alpha', 'idle'), makeAgent('a2', 'Beta', 'working')];
    const { unmount } = render(<Sidebar {...baseProps} agents={agents} selectedAgentId={null} />);
    const idleToggle = screen.getByRole('button', { name: '▾ Idle' });
    expect(idleToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Alpha')).toBeInTheDocument();

    await user.click(idleToggle);
    expect(screen.getByRole('button', { name: '▸ Idle' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Alpha')).toBeNull();
    expect(screen.getByText('Beta')).toBeInTheDocument();

    unmount();
    render(<Sidebar {...baseProps} agents={agents} selectedAgentId={null} />);
    expect(screen.getByRole('button', { name: '▸ Idle' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  it('falls back to expanded groups when localStorage is unavailable', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const agents = [makeAgent('a1', 'Alpha', 'idle')];
    render(<Sidebar {...baseProps} agents={agents} selectedAgentId={null} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    getItem.mockRestore();
  });

  it('does not crash when localStorage.setItem throws', async () => {
    const user = userEvent.setup();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const agents = [makeAgent('a1', 'Alpha', 'idle')];
    render(<Sidebar {...baseProps} agents={agents} selectedAgentId={null} />);
    await user.click(screen.getByRole('button', { name: '▾ Idle' }));
    expect(screen.queryByText('Alpha')).toBeNull();
    setItem.mockRestore();
  });

  it('narrows agents through the filter input', async () => {
    const user = userEvent.setup();
    render(
      <Sidebar
        {...baseProps}
        agents={[makeAgent('a1', 'Alpha', 'idle'), makeAgent('a2', 'Beta', 'idle')]}
        selectedAgentId={null}
      />,
    );
    await user.type(screen.getByLabelText('Filter agents'), 'alp');
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).toBeNull();
  });

  it('disables New at capacity, counting only live agents', () => {
    const { rerender } = render(
      <Sidebar
        {...baseProps}
        agents={[makeAgent('a1', 'Alpha', 'idle'), makeAgent('a2', 'Beta', 'working')]}
        selectedAgentId={null}
        maxAgents={2}
      />,
    );
    expect(screen.getByRole('button', { name: 'New' })).toBeDisabled();
    rerender(
      <Sidebar
        {...baseProps}
        agents={[makeAgent('a1', 'Alpha', 'idle'), makeAgent('a2', 'Beta', 'archived')]}
        selectedAgentId={null}
        maxAgents={2}
      />,
    );
    expect(screen.getByRole('button', { name: 'New' })).toBeEnabled();
  });

  it('shows the live-count capacity line', () => {
    const { container } = render(
      <Sidebar
        {...baseProps}
        agents={[makeAgent('a1', 'Alpha', 'idle'), makeAgent('a2', 'Beta', 'archived')]}
        selectedAgentId={null}
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
        {...baseProps}
        agents={[makeAgent('a1', 'Alpha', 'idle')]}
        selectedAgentId={null}
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
        {...baseProps}
        agents={[makeAgent('a1', 'Alpha', 'idle'), makeAgent('a2', 'Beta', 'idle')]}
        selectedAgentId="a2"
      />,
    );
    expect(screen.getByText('Beta').closest('button')).toHaveClass('selected');
    expect(screen.getByText('Alpha').closest('button')).not.toHaveClass('selected');
  });

  it('applies the open class only when the drawer is open', () => {
    const { container, rerender } = render(<Sidebar {...baseProps} agents={[]} selectedAgentId={null} />);
    expect(container.querySelector('nav')).toHaveClass('sidebar');
    expect(container.querySelector('nav')).not.toHaveClass('open');
    rerender(<Sidebar {...baseProps} agents={[]} selectedAgentId={null} open={true} />);
    expect(container.querySelector('nav')).toHaveClass('sidebar', 'open');
  });

  it('lists every project plus an All projects option', () => {
    render(<Sidebar {...baseProps} agents={[]} selectedAgentId={null} />);
    const select = screen.getByLabelText('Filter by project') as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((option) => option.textContent);
    expect(optionLabels).toEqual(['All projects', 'clai', 'other-repo']);
  });

  it('narrows the agent list to the selected project', () => {
    const agents = [makeAgent('a1', 'InProject', 'idle', 'p1'), makeAgent('a2', 'InOther', 'idle', 'p2')];
    render(<Sidebar {...baseProps} agents={agents} selectedAgentId={null} selectedProjectId="p1" />);
    expect(screen.getByText('InProject')).toBeInTheDocument();
    expect(screen.queryByText('InOther')).toBeNull();
  });

  it('fires onSelectProject when the project filter changes', async () => {
    const user = userEvent.setup();
    const onSelectProject = vi.fn();
    render(<Sidebar {...baseProps} agents={[]} selectedAgentId={null} onSelectProject={onSelectProject} />);
    await user.selectOptions(screen.getByLabelText('Filter by project'), 'p2');
    expect(onSelectProject).toHaveBeenCalledWith('p2');
  });
});
