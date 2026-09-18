import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, vi } from 'vitest';

import type { AgentSummary, TranscriptItem, WorktreeDiff } from '../api/types';
import type { MainView } from '../state/store';
import { MainPane } from './MainPane';

beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollTo', { value: vi.fn(), writable: true });
});

function makeAgent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: 'a1',
    name: 'Alpha',
    projectId: 'project-1',
    status: 'idle',
    approvalMode: 'always_ask',
    worktree: null,
    cwd: '/repo',
    sessions: [
      { id: 'main', acpSessionId: null, label: 'Main', isMain: true },
      { id: 'side', acpSessionId: null, label: 'Side chat', isMain: false },
    ],
    pendingApprovals: 0,
    forkedFrom: null,
    modelProfileId: null,
    modelLabel: null,
    lastError: null,
    ...overrides,
  };
}

const worktree = { repoRoot: '/repo', path: '/repo/.wt/a1', branch: 'clai/alpha', baseBranch: 'main' };

function renderPane(overrides: Partial<Parameters<typeof MainPane>[0]> = {}) {
  const props = {
    agent: makeAgent(),
    view: { kind: 'session', sessionId: 'main' } as MainView,
    approvals: [],
    transcriptFor: vi.fn<(sessionId: string) => TranscriptItem[]>().mockReturnValue([]),
    onSetView: vi.fn(),
    onPrompt: vi.fn(),
    onCancel: vi.fn(),
    onResolveApproval: vi.fn(),
    onFork: vi.fn(),
    onSideSession: vi.fn(),
    loadDiff: vi.fn<(agentId: string) => Promise<WorktreeDiff>>(() => new Promise<WorktreeDiff>(() => undefined)),
    models: [],
    onSetApprovalMode: vi.fn(),
    onSetModel: vi.fn(),
    onManageModels: vi.fn(),
    onArchive: vi.fn(),
    onRename: vi.fn(),
    ...overrides,
  };
  return { ...render(<MainPane {...props} />), props };
}

describe('MainPane', () => {
  it('renders one tab per session plus Settings, with the active tab following the view', () => {
    renderPane({ view: { kind: 'session', sessionId: 'side' } });
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Main', 'Side chat', 'Settings']);
    expect(screen.getByRole('tab', { name: 'Side chat' })).toHaveClass('tab', 'active');
    expect(screen.getByRole('tab', { name: 'Side chat' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Main' })).not.toHaveClass('active');
    expect(screen.getByRole('tab', { name: 'Main' })).toHaveAttribute('aria-selected', 'false');
  });

  it('shows the Changes tab only for worktree agents', () => {
    const { rerender, props } = renderPane();
    expect(screen.queryByRole('tab', { name: 'Changes' })).toBeNull();
    rerender(<MainPane {...props} agent={makeAgent({ worktree })} />);
    expect(screen.getByRole('tab', { name: 'Changes' })).toBeInTheDocument();
  });

  it('switching tabs calls onSetView with the right view', async () => {
    const user = userEvent.setup();
    const { props } = renderPane({ agent: makeAgent({ worktree }) });
    await user.click(screen.getByRole('tab', { name: 'Side chat' }));
    expect(props.onSetView).toHaveBeenLastCalledWith({ kind: 'session', sessionId: 'side' });
    await user.click(screen.getByRole('tab', { name: 'Changes' }));
    expect(props.onSetView).toHaveBeenLastCalledWith({ kind: 'changes' });
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(props.onSetView).toHaveBeenLastCalledWith({ kind: 'settings' });
  });

  it('fires the Fork and Side conversation callbacks', async () => {
    const user = userEvent.setup();
    const { props } = renderPane();
    await user.click(screen.getByRole('button', { name: 'Fork' }));
    expect(props.onFork).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Side conversation' }));
    expect(props.onSideSession).toHaveBeenCalledTimes(1);
  });

  it('hides Fork and Side conversation for archived agents', () => {
    renderPane({ agent: makeAgent({ status: 'archived' }) });
    expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Side conversation' })).toBeNull();
  });

  it('renders the conversation for a session view with that session transcript', () => {
    const transcriptFor = vi
      .fn<(sessionId: string) => TranscriptItem[]>()
      .mockReturnValue([{ type: 'userMessage', text: 'hello from side' }]);
    renderPane({ view: { kind: 'session', sessionId: 'side' }, transcriptFor });
    expect(transcriptFor).toHaveBeenCalledWith('side');
    expect(screen.getByText('hello from side')).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt')).toBeInTheDocument();
  });

  it('routes prompts to the viewed session', async () => {
    const user = userEvent.setup();
    const { props } = renderPane({ view: { kind: 'session', sessionId: 'side' } });
    await user.type(screen.getByLabelText('Prompt'), 'ping');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(props.onPrompt).toHaveBeenCalledWith('side', 'ping');
  });

  it('renders the diff panel for the changes view', () => {
    const { props } = renderPane({ agent: makeAgent({ worktree }), view: { kind: 'changes' } });
    expect(screen.getByText('Loading diff...')).toBeInTheDocument();
    expect(props.loadDiff).toHaveBeenCalledWith('a1');
    expect(screen.queryByLabelText('Prompt')).toBeNull();
  });

  it('renders the settings panel for the settings view', () => {
    renderPane({ view: { kind: 'settings' } });
    expect(screen.getByLabelText('Approval mode')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Archive agent' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Prompt')).toBeNull();
  });

  it('wires onRename through to the settings panel', async () => {
    const user = userEvent.setup();
    const { props } = renderPane({ view: { kind: 'settings' } });
    const input = screen.getByLabelText('Agent name');
    await user.clear(input);
    await user.type(input, 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(props.onRename).toHaveBeenCalledWith('Renamed');
  });
});
