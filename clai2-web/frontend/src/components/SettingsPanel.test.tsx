import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import type { AgentSummary, RedactedProfile } from '../api/types';
import { SettingsPanel } from './SettingsPanel';

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
    modelProfileId: null,
    modelLabel: null,
    lastError: null,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<RedactedProfile> = {}): RedactedProfile {
  return {
    id: 'm1',
    label: 'Sonnet',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    hasApiKey: true,
    projectId: null,
    region: null,
    hasCredentials: false,
    extraEnv: [],
    ...overrides,
  };
}

const models: RedactedProfile[] = [makeProfile(), makeProfile({ id: 'm2', label: 'GPT', provider: 'openai', model: 'gpt-6' })];

function kvPairs(container: HTMLElement): [string, string][] {
  const dl = container.querySelector('.kv');
  const pairs: [string, string][] = [];
  const terms = Array.from(dl?.querySelectorAll('dt') ?? []);
  for (const term of terms) {
    pairs.push([term.textContent ?? '', term.nextElementSibling?.textContent ?? '']);
  }
  return pairs;
}

function renderSettings(props: Partial<Parameters<typeof SettingsPanel>[0]> = {}) {
  const defaults = {
    agent: makeAgent(),
    models,
    onSetApprovalMode: vi.fn(),
    onSetModel: vi.fn(),
    onManageModels: vi.fn(),
    onArchive: vi.fn(),
    onRename: vi.fn(),
  };
  const merged = { ...defaults, ...props };
  return { ...render(<SettingsPanel {...merged} />), props: merged };
}

describe('SettingsPanel', () => {
  it('reflects the approval mode and fires onSetApprovalMode', async () => {
    const user = userEvent.setup();
    const { props } = renderSettings({ agent: makeAgent({ approvalMode: 'accept_edits' }) });
    const select = screen.getByLabelText('Approval mode');
    expect(select).toHaveValue('accept_edits');
    await user.selectOptions(select, 'auto');
    expect(props.onSetApprovalMode).toHaveBeenCalledTimes(1);
    expect(props.onSetApprovalMode).toHaveBeenCalledWith('auto');
  });

  it('offers the three mode labels', () => {
    renderSettings();
    const options = within(screen.getByLabelText('Approval mode')).getAllByRole('option');
    expect(options.map((option) => [option.getAttribute('value'), option.textContent])).toEqual([
      ['always_ask', 'Always ask'],
      ['accept_edits', 'Accept edits'],
      ['auto', 'Auto-approve everything'],
    ]);
  });

  it('shows the auto-mode warning only in auto mode', () => {
    const { rerender, props } = renderSettings();
    expect(screen.queryByText('Every tool call runs without asking.')).toBeNull();
    rerender(<SettingsPanel {...props} agent={makeAgent({ approvalMode: 'auto' })} />);
    expect(screen.getByText('Every tool call runs without asking.')).toHaveClass('mode-auto-warning');
  });

  it('renders only the directory when optional workspace fields are absent', () => {
    const { container } = renderSettings();
    expect(kvPairs(container)).toEqual([['Directory', '/repo']]);
  });

  it('renders branch, base branch, forkedFrom, and lastError when present', () => {
    const agent = makeAgent({
      worktree: { repoRoot: '/repo', path: '/repo/.wt/a1', branch: 'clai/alpha', baseBranch: 'main' },
      forkedFrom: 'agent-0',
      lastError: 'process exited',
    });
    const { container } = renderSettings({ agent });
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
    const { props } = renderSettings();
    expect(screen.queryByRole('button', { name: 'Archive and remove worktree' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(props.onArchive).toHaveBeenCalledWith(false);
  });

  it('offers worktree removal only for worktree agents', async () => {
    const user = userEvent.setup();
    const agent = makeAgent({
      worktree: { repoRoot: '/repo', path: '/repo/.wt/a1', branch: 'clai/alpha', baseBranch: 'main' },
    });
    const { props } = renderSettings({ agent });
    await user.click(screen.getByRole('button', { name: 'Archive and remove worktree' }));
    expect(props.onArchive).toHaveBeenCalledWith(true);
  });

  it('hides the danger zone and disables the select for an archived agent', () => {
    const { container } = renderSettings({ agent: makeAgent({ status: 'archived' }) });
    expect(container.querySelector('.danger-zone')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(screen.getByLabelText('Approval mode')).toBeDisabled();
  });

  it('shows the agent name and disables Rename until the draft changes', async () => {
    const user = userEvent.setup();
    renderSettings({ agent: makeAgent({ name: 'Original' }) });
    const input = screen.getByLabelText('Agent name');
    expect(input).toHaveValue('Original');
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
    await user.clear(input);
    await user.type(input, 'Renamed');
    expect(screen.getByRole('button', { name: 'Rename' })).toBeEnabled();
  });

  it('fires onRename with the trimmed draft', async () => {
    const user = userEvent.setup();
    const { props } = renderSettings({ agent: makeAgent({ name: 'Original' }) });
    const input = screen.getByLabelText('Agent name');
    await user.clear(input);
    await user.type(input, '  Renamed  ');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(props.onRename).toHaveBeenCalledWith('Renamed');
  });

  it('disables Rename for a blank draft', async () => {
    const user = userEvent.setup();
    renderSettings({ agent: makeAgent({ name: 'Original' }) });
    const input = screen.getByLabelText('Agent name');
    await user.clear(input);
    await user.type(input, '   ');
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
  });

  it('resets the name draft when the selected agent changes', () => {
    const { rerender, props } = renderSettings({ agent: makeAgent({ id: 'a1', name: 'First' }) });
    expect(screen.getByLabelText('Agent name')).toHaveValue('First');
    rerender(<SettingsPanel {...props} agent={makeAgent({ id: 'a2', name: 'Second' })} />);
    expect(screen.getByLabelText('Agent name')).toHaveValue('Second');
  });

  it('disables the name field and Rename for an archived agent', () => {
    renderSettings({ agent: makeAgent({ status: 'archived' }) });
    expect(screen.getByLabelText('Agent name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
  });

  it('reflects the agent model and lists the default plus every profile', () => {
    renderSettings({ agent: makeAgent({ modelProfileId: 'm2' }) });
    const select = screen.getByLabelText('Model profile');
    expect(select).toHaveValue('m2');
    const options = within(select).getAllByRole('option');
    expect(options.map((option) => [option.getAttribute('value'), option.textContent])).toEqual([
      ['', 'Default (server environment)'],
      ['m1', 'Sonnet'],
      ['m2', 'GPT'],
    ]);
  });

  it('defaults the model select to the server environment when no profile is set', () => {
    renderSettings();
    expect(screen.getByLabelText('Model profile')).toHaveValue('');
  });

  it('fires onSetModel with the chosen profile id', async () => {
    const user = userEvent.setup();
    const { props } = renderSettings();
    await user.selectOptions(screen.getByLabelText('Model profile'), 'm2');
    expect(props.onSetModel).toHaveBeenCalledTimes(1);
    expect(props.onSetModel).toHaveBeenCalledWith('m2');
  });

  it('fires onSetModel with null when switching back to the default', async () => {
    const user = userEvent.setup();
    const { props } = renderSettings({ agent: makeAgent({ modelProfileId: 'm1' }) });
    await user.selectOptions(screen.getByLabelText('Model profile'), 'Default (server environment)');
    expect(props.onSetModel).toHaveBeenCalledWith(null);
  });

  it('fires onManageModels from the Manage profiles button', async () => {
    const user = userEvent.setup();
    const { props } = renderSettings();
    await user.click(screen.getByRole('button', { name: 'Manage profiles' }));
    expect(props.onManageModels).toHaveBeenCalledTimes(1);
  });

  it('shows the switch hint and enables the model select when idle', () => {
    renderSettings();
    expect(screen.getByLabelText('Model profile')).toBeEnabled();
    expect(
      screen.getByText('Switching restarts the agent and replays the conversation to the new model.'),
    ).toHaveClass('hint');
  });

  it('disables the model select and shows the busy hint while a turn is in flight', () => {
    renderSettings({ agent: makeAgent({ status: 'working' }) });
    expect(screen.getByLabelText('Model profile')).toBeDisabled();
    expect(
      screen.getByText('Finish or cancel the current turn before switching models.'),
    ).toHaveClass('hint');
  });

  it('disables the model select while waiting on an approval', () => {
    renderSettings({ agent: makeAgent({ status: 'waiting_approval' }) });
    expect(screen.getByLabelText('Model profile')).toBeDisabled();
  });

  it('disables the model select for an archived agent', () => {
    renderSettings({ agent: makeAgent({ status: 'archived' }) });
    expect(screen.getByLabelText('Model profile')).toBeDisabled();
  });
});
