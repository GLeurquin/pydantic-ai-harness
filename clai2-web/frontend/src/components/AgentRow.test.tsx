import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import type { AgentSummary } from '../api/types';
import { AgentRow } from './AgentRow';

function makeAgent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: 'a1',
    name: 'Alpha',
    projectId: 'project-1',
    status: 'idle',
    approvalMode: 'always_ask',
    worktree: null,
    cwd: '/repo',
    sessions: [{ id: 'main', acpSessionId: null, label: 'Main', isMain: true }],
    pendingApprovals: 0,
    forkedFrom: null,
    lastError: null,
    ...overrides,
  };
}

describe('AgentRow', () => {
  it('shows the name without a branch when there is no worktree', () => {
    render(<AgentRow agent={makeAgent()} selected={false} onSelect={vi.fn()} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(document.querySelector('.agent-row-branch')).toBeNull();
  });

  it('shows the worktree branch when present', () => {
    const agent = makeAgent({
      worktree: { repoRoot: '/repo', path: '/repo/.wt/a1', branch: 'clai/alpha', baseBranch: 'main' },
    });
    render(<AgentRow agent={agent} selected={false} onSelect={vi.fn()} />);
    const branch = screen.getByText('clai/alpha');
    expect(branch.className).toBe('agent-row-branch');
  });

  it('shows the pending badge only when pendingApprovals is above zero', () => {
    const { rerender } = render(<AgentRow agent={makeAgent()} selected={false} onSelect={vi.fn()} />);
    expect(document.querySelector('.badge')).toBeNull();
    rerender(<AgentRow agent={makeAgent({ pendingApprovals: 3 })} selected={false} onSelect={vi.fn()} />);
    const badge = document.querySelector('.badge');
    expect(badge).toHaveTextContent('3');
  });

  it('marks the selected row with the selected class and aria-current', () => {
    render(<AgentRow agent={makeAgent()} selected={true} onSelect={vi.fn()} />);
    const button = screen.getByRole('button');
    expect(button.className).toBe('agent-row selected');
    expect(button).toHaveAttribute('aria-current', 'true');
  });

  it('renders an unselected row without the selected class', () => {
    render(<AgentRow agent={makeAgent()} selected={false} onSelect={vi.fn()} />);
    const button = screen.getByRole('button');
    expect(button.className).toBe('agent-row');
    expect(button).toHaveAttribute('aria-current', 'false');
  });

  it('fires onSelect with the agent id on click', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<AgentRow agent={makeAgent({ id: 'agent-42' })} selected={false} onSelect={onSelect} />);
    await user.click(screen.getByRole('button'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('agent-42');
  });
});
