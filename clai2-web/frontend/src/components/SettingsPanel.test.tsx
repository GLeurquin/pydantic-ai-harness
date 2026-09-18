import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import type { AgentSummary, RedactedProfile } from '../api/types';
import { SettingsPanel } from './SettingsPanel';

const models: RedactedProfile[] = [
  {
    id: 'm1',
    label: 'Claude Sonnet',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    hasApiKey: true,
    projectId: null,
    region: null,
    hasCredentials: false,
    extraEnv: [],
  },
  {
    id: 'm2',
    label: 'GPT',
    provider: 'openai',
    model: 'gpt-6',
    hasApiKey: true,
    projectId: null,
    region: null,
    hasCredentials: false,
    extraEnv: [],
  },
];

function makeAgent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: 'a1',
    name: 'Alpha',
    status: 'idle',
    approvalMode: 'always_ask',
    worktree: null,
    cwd: '/repo',
    sessions: [{ id: 'main', acpSessionId: null, label: 'Main', isMain: true }],
    pendingApprovals: 0,
    forkedFrom: null,
    modelProfileId: null,
    modelLabel: null,
    lastError: null,
    ...overrides,
  };
}

function kvPairs(container: HTMLElement): [string, string][] {
  const dl = container.querySelector('.kv');
  const pairs: [string, string][] = [];
  const terms = Array.from(dl?.querySelectorAll('dt') ?? []);
  for (const term of terms) {
    pairs.push([term.textContent ?? '', term.nextElementSibling?.textContent ?? '']);
  }
  return pairs;
}

describe('SettingsPanel', () => {
  it('reflects the approval mode and fires onSetApprovalMode', async () => {
    const user = userEvent.setup();
    const onSetApprovalMode = vi.fn();
    render(
      <SettingsPanel agent={makeAgent({ approvalMode: 'accept_edits' })} onSetApprovalMode={onSetApprovalMode} models={[]} onSetModel={vi.fn()} onManageModels={vi.fn()} onArchive={vi.fn()} />,
    );
    const select = screen.getByLabelText('Approval mode');
    expect(select).toHaveValue('accept_edits');
    await user.selectOptions(select, 'auto');
    expect(onSetApprovalMode).toHaveBeenCalledTimes(1);
    expect(onSetApprovalMode).toHaveBeenCalledWith('auto');
  });

  it('offers the three mode labels', () => {
    render(<SettingsPanel agent={makeAgent()} onSetApprovalMode={vi.fn()} models={[]} onSetModel={vi.fn()} onManageModels={vi.fn()} onArchive={vi.fn()} />);
    const options = within(screen.getByLabelText('Approval mode')).getAllByRole('option');
    expect(options.map((option) => [option.getAttribute('value'), option.textContent])).toEqual([
      ['always_ask', 'Always ask'],
      ['accept_edits', 'Accept edits'],
      ['auto', 'Auto-approve everything'],
    ]);
  });

  it('shows the auto-mode warning only in auto mode', () => {
    const { rerender } = render(<SettingsPanel agent={makeAgent()} onSetApprovalMode={vi.fn()} models={[]} onSetModel={vi.fn()} onManageModels={vi.fn()} onArchive={vi.fn()} />);
    expect(screen.queryByText('Every tool call runs without asking.')).toBeNull();
    rerender(<SettingsPanel agent={makeAgent({ approvalMode: 'auto' })} onSetApprovalMode={vi.fn()} models={[]} onSetModel={vi.fn()} onManageModels={vi.fn()} onArchive={vi.fn()} />);
    expect(screen.getByText('Every tool call runs without asking.')).toHaveClass('mode-auto-warning');
  });

  it('renders only the directory when optional workspace fields are absent', () => {
    const { container } = render(<SettingsPanel agent={makeAgent()} onSetApprovalMode={vi.fn()} models={[]} onSetModel={vi.fn()} onManageModels={vi.fn()} onArchive={vi.fn()} />);
    expect(kvPairs(container)).toEqual([['Directory', '/repo']]);
  });

  it('renders branch, base branch, forkedFrom, and lastError when present', () => {
    const agent = makeAgent({
      worktree: { repoRoot: '/repo', path: '/repo/.wt/a1', branch: 'clai/alpha', baseBranch: 'main' },
      forkedFrom: 'agent-0',
      lastError: 'process exited',
    });
    const { container } = render(<SettingsPanel agent={agent} onSetApprovalMode={vi.fn()} models={[]} onSetModel={vi.fn()} onManageModels={vi.fn()} onArchive={vi.fn()} />);
    expect(kvPairs(container)).toEqual([
      ['Directory', '/repo'],
      ['Branch', 'clai/alpha'],
      ['Base branch', 'main'],
      ['Forked from', 'agent-0'],
      ['Last error', 'process exited'],
    ]);
  });

  it('archives without removing the worktree', async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    render(<SettingsPanel agent={makeAgent()} onSetApprovalMode={vi.fn()} models={[]} onSetModel={vi.fn()} onManageModels={vi.fn()} onArchive={onArchive} />);
    expect(screen.queryByRole('button', { name: 'Archive and remove worktree' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(onArchive).toHaveBeenCalledWith(false);
  });

  it('offers worktree removal only for worktree agents', async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    const agent = makeAgent({
      worktree: { repoRoot: '/repo', path: '/repo/.wt/a1', branch: 'clai/alpha', baseBranch: 'main' },
    });
    render(<SettingsPanel agent={agent} onSetApprovalMode={vi.fn()} models={[]} onSetModel={vi.fn()} onManageModels={vi.fn()} onArchive={onArchive} />);
    await user.click(screen.getByRole('button', { name: 'Archive and remove worktree' }));
    expect(onArchive).toHaveBeenCalledWith(true);
  });

  it('reflects the agent model profile and lists profiles under a default option', () => {
    render(
      <SettingsPanel
        agent={makeAgent({ modelProfileId: 'm2' })}
        models={models}
        onSetApprovalMode={vi.fn()}
        onSetModel={vi.fn()}
        onManageModels={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    const select = screen.getByLabelText('Model profile');
    expect(select).toHaveValue('m2');
    const options = within(select).getAllByRole('option');
    expect(options.map((option) => [option.getAttribute('value'), option.textContent])).toEqual([
      ['', 'Default (server environment)'],
      ['m1', 'Claude Sonnet'],
      ['m2', 'GPT'],
    ]);
  });

  it('fires onSetModel with the chosen id', async () => {
    const user = userEvent.setup();
    const onSetModel = vi.fn();
    render(
      <SettingsPanel
        agent={makeAgent()}
        models={models}
        onSetApprovalMode={vi.fn()}
        onSetModel={onSetModel}
        onManageModels={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    await user.selectOptions(screen.getByLabelText('Model profile'), 'm1');
    expect(onSetModel).toHaveBeenCalledTimes(1);
    expect(onSetModel).toHaveBeenCalledWith('m1');
  });

  it('fires onSetModel with null when the default option is chosen', async () => {
    const user = userEvent.setup();
    const onSetModel = vi.fn();
    render(
      <SettingsPanel
        agent={makeAgent({ modelProfileId: 'm1' })}
        models={models}
        onSetApprovalMode={vi.fn()}
        onSetModel={onSetModel}
        onManageModels={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    await user.selectOptions(screen.getByLabelText('Model profile'), 'Default (server environment)');
    expect(onSetModel).toHaveBeenCalledTimes(1);
    expect(onSetModel).toHaveBeenCalledWith(null);
  });

  it('shows an empty value when the agent has no model profile', () => {
    render(
      <SettingsPanel
        agent={makeAgent({ modelProfileId: null })}
        models={models}
        onSetApprovalMode={vi.fn()}
        onSetModel={vi.fn()}
        onManageModels={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Model profile')).toHaveValue('');
  });

  it('fires onManageModels from the Manage profiles button', async () => {
    const user = userEvent.setup();
    const onManageModels = vi.fn();
    render(
      <SettingsPanel
        agent={makeAgent()}
        models={models}
        onSetApprovalMode={vi.fn()}
        onSetModel={vi.fn()}
        onManageModels={onManageModels}
        onArchive={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Manage profiles' }));
    expect(onManageModels).toHaveBeenCalledTimes(1);
  });

  it('disables the model select and shows the busy hint when the agent is working', () => {
    render(
      <SettingsPanel
        agent={makeAgent({ status: 'working' })}
        models={models}
        onSetApprovalMode={vi.fn()}
        onSetModel={vi.fn()}
        onManageModels={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Model profile')).toBeDisabled();
    expect(screen.getByText('Finish or cancel the current turn before switching models.')).toHaveClass('hint');
  });

  it('disables the model select while waiting for approval', () => {
    render(
      <SettingsPanel
        agent={makeAgent({ status: 'waiting_approval' })}
        models={models}
        onSetApprovalMode={vi.fn()}
        onSetModel={vi.fn()}
        onManageModels={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Model profile')).toBeDisabled();
  });

  it('shows the switch hint and enables the model select when idle', () => {
    render(
      <SettingsPanel
        agent={makeAgent()}
        models={models}
        onSetApprovalMode={vi.fn()}
        onSetModel={vi.fn()}
        onManageModels={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Model profile')).toBeEnabled();
    expect(
      screen.getByText('Switching restarts the agent and replays the conversation to the new model.'),
    ).toHaveClass('hint');
  });

  it('disables the model select for an archived agent', () => {
    render(
      <SettingsPanel
        agent={makeAgent({ status: 'archived' })}
        models={models}
        onSetApprovalMode={vi.fn()}
        onSetModel={vi.fn()}
        onManageModels={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Model profile')).toBeDisabled();
  });

  it('hides the danger zone and disables the select for an archived agent', () => {
    const { container } = render(
      <SettingsPanel agent={makeAgent({ status: 'archived' })} onSetApprovalMode={vi.fn()} models={[]} onSetModel={vi.fn()} onManageModels={vi.fn()} onArchive={vi.fn()} />,
    );
    expect(container.querySelector('.danger-zone')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(screen.getByLabelText('Approval mode')).toBeDisabled();
  });
});
