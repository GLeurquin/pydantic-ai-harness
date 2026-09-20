import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, vi } from 'vitest';

import { App } from './App';
import type { AgentSummary, ApprovalView, FolderSummary, ProjectSummary, RedactedProfile, TranscriptItem } from './api/types';
import { useAppStore } from './state/store';
import type { WsHandlers } from './ws';

const apiMock = vi.hoisted(() => ({
  listAgents: vi.fn(),
  createAgent: vi.fn(),
  getAgent: vi.fn(),
  archiveAgent: vi.fn(),
  prompt: vi.fn(),
  cancel: vi.fn(),
  fork: vi.fn(),
  openSideSession: vi.fn(),
  setApprovalMode: vi.fn(),
  rename: vi.fn(),
  listProjects: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  listFolders: vi.fn(),
  createFolder: vi.fn(),
  deleteFolder: vi.fn(),
  setAgentFolder: vi.fn(),
  pendingApprovals: vi.fn(),
  resolveApproval: vi.fn(),
  transcript: vi.fn(),
  diff: vi.fn(),
  debugContext: vi.fn(),
  listModels: vi.fn(),
  createModel: vi.fn(),
  updateModel: vi.fn(),
  deleteModel: vi.fn(),
  setAgentModel: vi.fn(),
  setGoal: vi.fn(),
  clearGoal: vi.fn(),
  setCiTracking: vi.fn(),
  clearCiTracking: vi.fn(),
  githubSettings: vi.fn(),
  setGithubToken: vi.fn(),
  clearGithubToken: vi.fn(),
  setGithubPollInterval: vi.fn(),
  fetchGithubIssue: vi.fn(),
}));

const ws = vi.hoisted(() => ({
  handlers: null as unknown,
  close: vi.fn(),
  connect: vi.fn(),
  url: vi.fn(() => 'ws://test/api/ws'),
}));

vi.mock('./api/client', () => ({ api: apiMock }));

vi.mock('./ws', () => ({
  wsUrl: ws.url,
  connectWs: ws.connect.mockImplementation((_url: string, handlers: unknown) => {
    ws.handlers = handlers;
    return { close: ws.close };
  }),
}));

function handlers(): WsHandlers {
  return ws.handlers as WsHandlers;
}

function makeAgent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: 'a1',
    name: 'Alpha',
    projectId: 'project-1',
    status: 'idle',
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
    folderId: null,
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

function makeApproval(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: 'ap1',
    agentId: 'a1',
    sessionId: 'main',
    toolCall: {
      toolCallId: 'tc1',
      title: 'run tests',
      kind: 'execute',
      status: 'pending',
      content: [],
      locations: [],
    },
    options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return { id: 'project-1', name: 'clai', repoRoot: '/repo', ...overrides };
}

async function snapshot(
  agents: AgentSummary[],
  approvals: ApprovalView[] = [],
  projects: ProjectSummary[] = [makeProject()],
  maxAgents = 100,
  folders: FolderSummary[] = [],
) {
  await act(async () => {
    handlers().onSnapshot({ agents, approvals, projects, folders, maxAgents });
  });
}

beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollTo', { value: vi.fn(), writable: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  ws.handlers = null;
  useAppStore.setState({
    connected: false,
    agents: [],
    approvals: [],
    models: [],
    githubSettings: { hasToken: false, pollIntervalSecs: 300 },
    projects: [],
    selectedProjectId: 'all',
    maxAgents: 100,
    notifications: [],
    transcripts: {},
    selectedAgentId: null,
    view: { kind: 'session', sessionId: 'main' },
  });
  apiMock.transcript.mockResolvedValue([]);
  apiMock.prompt.mockResolvedValue({ ok: true });
  apiMock.resolveApproval.mockResolvedValue({ ok: true });
  apiMock.setApprovalMode.mockResolvedValue(makeAgent());
  apiMock.rename.mockResolvedValue(makeAgent());
  apiMock.archiveAgent.mockResolvedValue(makeAgent({ status: 'archived' }));
  apiMock.setAgentModel.mockResolvedValue(makeAgent());
  apiMock.setAgentFolder.mockResolvedValue(makeAgent());
  apiMock.setGoal.mockResolvedValue(makeAgent());
  apiMock.clearGoal.mockResolvedValue({ ok: true });
  apiMock.listModels.mockResolvedValue([]);
  apiMock.githubSettings.mockResolvedValue({ hasToken: false, pollIntervalSecs: 300 });
});

describe('App', () => {
  it('shows the empty state with no agents', () => {
    render(<App />);
    expect(screen.getByText('Start an agent to get going.')).toBeInTheDocument();
    expect(ws.connect).toHaveBeenCalledTimes(1);
    expect(ws.url).toHaveBeenCalledWith(window.location);
  });

  it('populates the sidebar from a snapshot and selects the first agent', async () => {
    render(<App />);
    await snapshot([makeAgent(), makeAgent({ id: 'a2', name: 'Beta' })]);
    expect(screen.queryByText('Start an agent to get going.')).toBeNull();
    const sidebar = screen.getByRole('navigation', { name: 'Agents' });
    expect(within(sidebar).getByText('Alpha')).toBeInTheDocument();
    expect(within(sidebar).getByText('Beta')).toBeInTheDocument();
    expect(within(sidebar).getByText('Alpha').closest('button')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByLabelText('Prompt')).toHaveAttribute('placeholder', 'Message Alpha');
  });

  it('toggles the sidebar drawer from the header hamburger and via the backdrop', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await snapshot([makeAgent()]);
    const sidebar = screen.getByRole('navigation', { name: 'Agents' });
    expect(sidebar).not.toHaveClass('open');
    await user.click(screen.getByRole('button', { name: 'Toggle agent list' }));
    expect(sidebar).toHaveClass('open');
    expect(container.querySelector('.sidebar-backdrop')).toHaveClass('open');
    await user.click(container.querySelector('.sidebar-backdrop') as HTMLElement);
    expect(sidebar).not.toHaveClass('open');
  });

  it('closes the sidebar drawer when an agent is selected', async () => {
    const user = userEvent.setup();
    render(<App />);
    await snapshot([makeAgent(), makeAgent({ id: 'a2', name: 'Beta' })]);
    const sidebar = screen.getByRole('navigation', { name: 'Agents' });
    await user.click(screen.getByRole('button', { name: 'Toggle agent list' }));
    expect(sidebar).toHaveClass('open');
    await user.click(within(sidebar).getByText('Beta'));
    expect(sidebar).not.toHaveClass('open');
  });

  it('fetches the persisted transcript for the selected session and renders it', async () => {
    apiMock.transcript.mockResolvedValue([{ type: 'userMessage', text: 'stored message' }] as TranscriptItem[]);
    render(<App />);
    await snapshot([makeAgent()]);
    await waitFor(() => expect(screen.getByText('stored message')).toBeInTheDocument());
    expect(apiMock.transcript).toHaveBeenCalledTimes(1);
    expect(apiMock.transcript).toHaveBeenCalledWith('a1', 'main');
  });

  it('skips the transcript fetch when the session transcript is already loaded', async () => {
    useAppStore.getState().setTranscript('a1', 'main', []);
    render(<App />);
    await snapshot([makeAgent()]);
    expect(apiMock.transcript).not.toHaveBeenCalled();
  });

  it('keeps a longer live transcript over a shorter fetched one', async () => {
    let resolveFetch!: (items: TranscriptItem[]) => void;
    apiMock.transcript.mockImplementation(
      () =>
        new Promise<TranscriptItem[]>((res) => {
          resolveFetch = res;
        }),
    );
    render(<App />);
    await snapshot([makeAgent()]);
    await act(async () => {
      handlers().onEvent({ type: 'userMessage', agentId: 'a1', sessionId: 'main', text: 'live one' });
      handlers().onEvent({ type: 'messageChunk', agentId: 'a1', sessionId: 'main', text: 'live two' });
    });
    await act(async () => {
      resolveFetch([{ type: 'userMessage', text: 'stale persisted' }]);
    });
    expect(screen.getByText('live one')).toBeInTheDocument();
    expect(screen.getByText('live two')).toBeInTheDocument();
    expect(screen.queryByText('stale persisted')).toBeNull();
  });

  it('ignores a failed transcript fetch', async () => {
    apiMock.transcript.mockRejectedValue(new Error('offline'));
    render(<App />);
    await snapshot([makeAgent()]);
    expect(apiMock.transcript).toHaveBeenCalledWith('a1', 'main');
    expect(screen.getByLabelText('Prompt')).toBeInTheDocument();
  });

  it('cancels the selected agent', async () => {
    const user = userEvent.setup();
    apiMock.cancel.mockResolvedValue({ ok: true });
    render(<App />);
    await snapshot([makeAgent({ status: 'working' })]);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(apiMock.cancel).toHaveBeenCalledTimes(1);
    expect(apiMock.cancel).toHaveBeenCalledWith('a1');
  });

  it('sends prompts for the selected agent and session', async () => {
    const user = userEvent.setup();
    render(<App />);
    await snapshot([makeAgent()]);
    await user.type(screen.getByLabelText('Prompt'), 'do the thing');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(apiMock.prompt).toHaveBeenCalledTimes(1);
    expect(apiMock.prompt).toHaveBeenCalledWith('a1', 'main', 'do the thing');
  });

  it('resolves approvals through the api', async () => {
    const user = userEvent.setup();
    render(<App />);
    await snapshot([makeAgent({ status: 'waiting_approval' })], [makeApproval()]);
    await user.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(apiMock.resolveApproval).toHaveBeenCalledTimes(1);
    expect(apiMock.resolveApproval).toHaveBeenCalledWith('ap1', 'allow-once');
  });

  it('creates an agent from the dialog and selects it', async () => {
    const user = userEvent.setup();
    const created = makeAgent({ id: 'b1', name: 'Builder' });
    apiMock.createAgent.mockResolvedValue(created);
    render(<App />);
    await snapshot([makeAgent()]);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.type(screen.getByPlaceholderText('fix-auth-bug'), 'Builder');
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(apiMock.createAgent).toHaveBeenCalledWith({
      name: 'Builder',
      projectId: 'project-1',
      useWorktree: true,
      approvalMode: 'always_ask',
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New agent' })).toBeNull());
    const sidebar = screen.getByRole('navigation', { name: 'Agents' });
    expect(within(sidebar).getByText('Builder').closest('button')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByLabelText('Prompt')).toHaveAttribute('placeholder', 'Message Builder');
  });

  it('forks the selected agent and selects the fork', async () => {
    const user = userEvent.setup();
    const fork = makeAgent({ id: 'f1', name: 'Alpha two' });
    apiMock.fork.mockResolvedValue(fork);
    render(<App />);
    await snapshot([makeAgent()]);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Fork' }));
    const dialog = screen.getByRole('dialog', { name: 'Fork Alpha' });
    await user.type(within(dialog).getByPlaceholderText('Alpha fork'), 'Alpha two');
    await user.click(within(dialog).getByRole('button', { name: 'Fork agent' }));
    expect(apiMock.fork).toHaveBeenCalledWith('a1', { name: 'Alpha two' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Fork Alpha' })).toBeNull());
    const sidebar = screen.getByRole('navigation', { name: 'Agents' });
    expect(within(sidebar).getByText('Alpha two').closest('button')).toHaveAttribute('aria-current', 'true');
  });

  it('opens a side session and switches to its tab', async () => {
    const user = userEvent.setup();
    const updated = makeAgent({
      sessions: [
        { id: 'main', acpSessionId: null, label: 'Main', isMain: true, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 },
        { id: 's2', acpSessionId: null, label: 'Approach chat', isMain: false, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 },
      ],
    });
    apiMock.openSideSession.mockResolvedValue(updated);
    render(<App />);
    await snapshot([makeAgent()]);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Side conversation' }));
    const dialog = screen.getByRole('dialog', { name: 'Side conversation' });
    await user.type(within(dialog).getByPlaceholderText('Ask about the approach'), 'Approach chat');
    await user.click(within(dialog).getByRole('button', { name: 'Open' }));
    expect(apiMock.openSideSession).toHaveBeenCalledWith('a1', 'Approach chat');
    const tab = await screen.findByRole('tab', { name: 'Approach chat' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
  });

  it('loads the diff when switching to the Changes tab', async () => {
    const user = userEvent.setup();
    apiMock.diff.mockResolvedValue({ diff: '+wired up', untrackedDiff: '', status: 'M src/a.ts' });
    const agent = makeAgent({
      worktree: { repoRoot: '/repo', path: '/repo/.wt/a1', branch: 'clai/alpha', baseBranch: 'main' },
    });
    render(<App />);
    await snapshot([agent]);
    await user.click(screen.getByRole('tab', { name: 'Changes' }));
    expect(apiMock.diff).toHaveBeenCalledWith('a1');
    expect(await screen.findByText('+wired up')).toBeInTheDocument();
    expect(screen.getByText('M src/a.ts')).toBeInTheDocument();
  });

  it('wires approval mode and archive from the Settings tab', async () => {
    const user = userEvent.setup();
    render(<App />);
    await snapshot([makeAgent()]);
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.selectOptions(screen.getByLabelText('Approval mode'), 'accept_edits');
    expect(apiMock.setApprovalMode).toHaveBeenCalledWith('a1', 'accept_edits');
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(apiMock.archiveAgent).toHaveBeenCalledWith('a1', false);
  });

  it('sets a goal from the Settings tab and closes the dialog', async () => {
    const user = userEvent.setup();
    render(<App />);
    await snapshot([makeAgent()]);
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Set a goal' }));
    await user.type(screen.getByPlaceholderText('Fix the failing auth tests and open a PR'), 'Ship it');
    await user.click(screen.getByRole('button', { name: 'Start working toward it' }));
    expect(apiMock.setGoal).toHaveBeenCalledWith('a1', 'Ship it', 10);
    // The WS stream, not this response, is what updates the goal indicator --
    // applying this response directly would race it (see App.tsx).
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Set a goal' })).toBeNull());
  });

  it('clears the active goal from the Settings tab', async () => {
    const user = userEvent.setup();
    render(<App />);
    await snapshot([makeAgent({ goal: { goal: 'Ship it', maxTurns: 6, turnsUsed: 2 } })]);
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(apiMock.clearGoal).toHaveBeenCalledWith('a1');
  });

  it('renames the selected agent from the Settings tab', async () => {
    const user = userEvent.setup();
    render(<App />);
    await snapshot([makeAgent()]);
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    const input = screen.getByLabelText('Agent name');
    await user.clear(input);
    await user.type(input, 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(apiMock.rename).toHaveBeenCalledWith('a1', 'Renamed');
  });

  it('filters the sidebar by project and defaults new-agent dialog to it', async () => {
    const user = userEvent.setup();
    const otherProject = makeProject({ id: 'project-2', name: 'other-repo' });
    render(<App />);
    await snapshot(
      [makeAgent({ id: 'a1', name: 'InClai' }), makeAgent({ id: 'a2', name: 'InOther', projectId: 'project-2' })],
      [],
      [makeProject(), otherProject],
    );
    await user.selectOptions(screen.getByLabelText('Filter by project'), 'project-2');
    const sidebar = screen.getByRole('navigation', { name: 'Agents' });
    expect(within(sidebar).queryByText('InClai')).toBeNull();
    expect(within(sidebar).getByText('InOther')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New' }));
    expect(within(screen.getByRole('dialog', { name: 'New agent' })).getByLabelText('Project')).toHaveValue('project-2');
  });

  it('creates a project inline from the new-agent dialog', async () => {
    const user = userEvent.setup();
    const project = makeProject({ id: 'project-9', name: 'brand-new', repoRoot: '/brand-new' });
    apiMock.createProject.mockResolvedValue(project);
    render(<App />);
    await snapshot([makeAgent()]);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('button', { name: '+ New project' }));
    await user.type(screen.getByPlaceholderText('my-other-repo'), 'brand-new');
    await user.type(screen.getByPlaceholderText('/Users/you/code/my-other-repo'), '/brand-new');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    expect(apiMock.createProject).toHaveBeenCalledWith({ name: 'brand-new', path: '/brand-new' });
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue('project-9'));
  });

  it('opens the projects dialog from the header, adds and removes a project, and closes it', async () => {
    const user = userEvent.setup();
    const project = makeProject({ id: 'project-9', name: 'brand-new', repoRoot: '/brand-new' });
    apiMock.createProject.mockResolvedValue(project);
    apiMock.deleteProject.mockResolvedValue({ ok: true });
    render(<App />);
    await snapshot([makeAgent()]);

    await user.click(screen.getByRole('button', { name: 'Projects' }));
    const dialog = await screen.findByRole('dialog', { name: 'Projects' });

    await user.click(within(dialog).getByRole('button', { name: 'New project' }));
    await user.type(within(dialog).getByPlaceholderText('my-other-repo'), 'brand-new');
    await user.type(within(dialog).getByPlaceholderText('/Users/you/code/my-other-repo'), '/brand-new');
    await user.click(within(dialog).getByRole('button', { name: 'Add project' }));
    expect(apiMock.createProject).toHaveBeenCalledWith({ name: 'brand-new', path: '/brand-new' });
    expect(await within(dialog).findByText('brand-new')).toBeInTheDocument();

    const [firstRemove] = within(dialog).getAllByRole('button', { name: 'Remove' });
    await user.click(firstRemove!);
    expect(apiMock.deleteProject).toHaveBeenCalledWith('project-1');

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Projects' })).toBeNull());
  });

  it('loads model profiles on mount and stores them', async () => {
    apiMock.listModels.mockResolvedValue([makeProfile()]);
    render(<App />);
    await waitFor(() => expect(useAppStore.getState().models).toEqual([makeProfile()]));
    expect(apiMock.listModels).toHaveBeenCalledTimes(1);
  });

  it('ignores a failed model profiles fetch', async () => {
    apiMock.listModels.mockRejectedValue(new Error('offline'));
    render(<App />);
    await snapshot([makeAgent()]);
    expect(useAppStore.getState().models).toEqual([]);
  });

  it('opens the model profiles dialog from the header and closes it', async () => {
    const user = userEvent.setup();
    render(<App />);
    await snapshot([makeAgent()]);
    await user.click(screen.getByRole('button', { name: 'Model profiles' }));
    expect(await screen.findByRole('dialog', { name: 'Model profiles' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Model profiles' })).toBeNull());
  });

  it('stores the updated profile list when the dialog reports a change', async () => {
    const user = userEvent.setup();
    const created = makeProfile({ id: 'created', label: 'New Sonnet' });
    apiMock.createModel.mockResolvedValue(created);
    render(<App />);
    await snapshot([makeAgent()]);
    await user.click(screen.getByRole('button', { name: 'Model profiles' }));
    await user.click(await screen.findByRole('button', { name: 'New profile' }));
    await user.type(screen.getByLabelText('Name'), 'New Sonnet');
    await user.type(screen.getByLabelText('Model'), 'claude-sonnet-4-6');
    await user.click(screen.getByRole('button', { name: 'Add profile' }));
    await waitFor(() => expect(useAppStore.getState().models).toEqual([created]));
  });

  it('edits a model profile from the dialog and replaces only its row', async () => {
    const user = userEvent.setup();
    const other = makeProfile({ id: 'm2', label: 'GPT' });
    apiMock.listModels.mockResolvedValue([makeProfile(), other]);
    const updated = makeProfile({ label: 'Renamed' });
    apiMock.updateModel.mockResolvedValue(updated);
    render(<App />);
    await snapshot([makeAgent()]);
    await waitFor(() => expect(useAppStore.getState().models).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'Model profiles' }));
    const [firstEdit] = await screen.findAllByRole('button', { name: 'Edit' });
    await user.click(firstEdit!);
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(apiMock.updateModel).toHaveBeenCalledWith('m1', {
      label: 'Renamed',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      extraEnv: [],
    });
    await waitFor(() => expect(useAppStore.getState().models).toEqual([updated, other]));
  });

  it('deletes a model profile from the dialog and removes its row', async () => {
    const user = userEvent.setup();
    apiMock.listModels.mockResolvedValue([makeProfile()]);
    apiMock.deleteModel.mockResolvedValue({ ok: true });
    render(<App />);
    await snapshot([makeAgent()]);
    await waitFor(() => expect(useAppStore.getState().models).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Model profiles' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(apiMock.deleteModel).toHaveBeenCalledWith('m1');
    await waitFor(() => expect(useAppStore.getState().models).toEqual([]));
  });

  it('switches the selected agent model from the Settings tab', async () => {
    const user = userEvent.setup();
    apiMock.listModels.mockResolvedValue([makeProfile({ id: 'm2', label: 'GPT' })]);
    render(<App />);
    await snapshot([makeAgent()]);
    await waitFor(() => expect(useAppStore.getState().models).toHaveLength(1));
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.selectOptions(screen.getByLabelText('Model profile'), 'm2');
    expect(apiMock.setAgentModel).toHaveBeenCalledWith('a1', 'm2');
  });

  it('opens the profiles dialog from the Settings tab', async () => {
    const user = userEvent.setup();
    render(<App />);
    await snapshot([makeAgent()]);
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Manage profiles' }));
    expect(await screen.findByRole('dialog', { name: 'Model profiles' })).toBeInTheDocument();
  });

  it('files the selected agent into a folder from the Settings tab', async () => {
    const user = userEvent.setup();
    render(<App />);
    await snapshot([makeAgent()], [], [makeProject()], 100, [{ id: 'f1', name: 'backend work' }]);
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.selectOptions(screen.getByLabelText('Folder'), 'f1');
    expect(apiMock.setAgentFolder).toHaveBeenCalledWith('a1', 'f1');
  });

  it('views the debug context for a session from the Settings tab, then closes it', async () => {
    const user = userEvent.setup();
    apiMock.debugContext.mockResolvedValue([{ kind: 'request', parts: [{ part_kind: 'user-prompt', content: 'hi' }] }]);
    render(<App />);
    await snapshot([makeAgent()]);
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'View' }));
    const dialog = await screen.findByRole('dialog', { name: 'Debug context' });
    expect(apiMock.debugContext).toHaveBeenCalledWith('a1', 'main');
    expect(await within(dialog).findByText('hi')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Debug context' })).toBeNull());
  });

  it('picks the debug context session label from the agent when picking a non-main session', async () => {
    const user = userEvent.setup();
    apiMock.debugContext.mockResolvedValue(null);
    render(<App />);
    const twoSessions = [
      { id: 'main', acpSessionId: null, label: 'Main', isMain: true, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 },
      { id: 'side', acpSessionId: null, label: 'Side chat', isMain: false, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 },
    ];
    await snapshot([makeAgent({ sessions: twoSessions })]);
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.selectOptions(screen.getByLabelText('Session'), 'side');
    await user.click(screen.getByRole('button', { name: 'View' }));
    const dialog = await screen.findByRole('dialog', { name: 'Debug context' });
    expect(apiMock.debugContext).toHaveBeenCalledWith('a1', 'side');
    expect(within(dialog).getByText(/for .Side chat./)).toBeInTheDocument();
  });

  it('falls back to the raw session id as the label if the picked session no longer belongs to the selected agent', async () => {
    const user = userEvent.setup();
    apiMock.debugContext.mockResolvedValue(null);
    render(<App />);
    const withSide = [
      { id: 'main', acpSessionId: null, label: 'Main', isMain: true, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 },
      { id: 'side-x', acpSessionId: null, label: 'Side X', isMain: false, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 },
    ];
    await snapshot([makeAgent({ sessions: withSide }), makeAgent({ id: 'a2', name: 'Beta' })]);
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.selectOptions(screen.getByLabelText('Session'), 'side-x');
    await user.click(screen.getByRole('button', { name: 'View' }));
    await screen.findByRole('dialog', { name: 'Debug context' });

    // Switching agents doesn't close the open dialog; agent Beta has no session
    // called "side-x", so the label falls back to the raw id instead of crashing.
    const sidebar = screen.getByRole('navigation', { name: 'Agents' });
    await user.click(within(sidebar).getByText('Beta'));
    const dialog = screen.getByRole('dialog', { name: 'Debug context' });
    expect(within(dialog).getByText(/for .side-x./)).toBeInTheDocument();
  });

  it('opens the folders dialog from the Settings tab, adds and removes a folder, and closes it', async () => {
    const user = userEvent.setup();
    const folder = { id: 'f9', name: 'brand-new' };
    apiMock.createFolder.mockResolvedValue(folder);
    apiMock.deleteFolder.mockResolvedValue({ ok: true });
    render(<App />);
    await snapshot([makeAgent()]);

    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Manage folders' }));
    const dialog = await screen.findByRole('dialog', { name: 'Folders' });

    await user.click(within(dialog).getByRole('button', { name: 'New folder' }));
    await user.type(within(dialog).getByPlaceholderText('Q3 launch'), 'brand-new');
    await user.click(within(dialog).getByRole('button', { name: 'Add folder' }));
    expect(apiMock.createFolder).toHaveBeenCalledWith('brand-new');
    expect(await within(dialog).findByText('brand-new')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(apiMock.deleteFolder).toHaveBeenCalledWith('f9');

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Folders' })).toBeNull());
  });

  it('opens the profiles dialog from the new-agent dialog', async () => {
    const user = userEvent.setup();
    render(<App />);
    await snapshot([makeAgent()]);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('button', { name: 'Manage model profiles' }));
    expect(await screen.findByRole('dialog', { name: 'Model profiles' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'New agent' })).toBeNull();
  });

  it('creates an agent with both a project and a model profile', async () => {
    const user = userEvent.setup();
    apiMock.listModels.mockResolvedValue([makeProfile({ id: 'm2', label: 'GPT' })]);
    apiMock.createAgent.mockResolvedValue(makeAgent({ id: 'b1', name: 'Builder' }));
    render(<App />);
    await snapshot([makeAgent()]);
    await waitFor(() => expect(useAppStore.getState().models).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.type(screen.getByPlaceholderText('fix-auth-bug'), 'Builder');
    await user.selectOptions(screen.getByLabelText('Model'), 'm2');
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(apiMock.createAgent).toHaveBeenCalledWith({
      name: 'Builder',
      projectId: 'project-1',
      useWorktree: true,
      approvalMode: 'always_ask',
      modelProfileId: 'm2',
    });
  });

  it('loads GitHub settings on mount and stores them', async () => {
    apiMock.githubSettings.mockResolvedValue({ hasToken: true, pollIntervalSecs: 300 });
    render(<App />);
    await waitFor(() =>
      expect(useAppStore.getState().githubSettings).toEqual({ hasToken: true, pollIntervalSecs: 300 }),
    );
    expect(apiMock.githubSettings).toHaveBeenCalledTimes(1);
  });

  it('ignores a failed GitHub settings fetch', async () => {
    apiMock.githubSettings.mockRejectedValue(new Error('offline'));
    render(<App />);
    await snapshot([makeAgent()]);
    expect(useAppStore.getState().githubSettings).toEqual({ hasToken: false, pollIntervalSecs: 300 });
  });

  it('opens and closes GitHub settings from the header button', async () => {
    const user = userEvent.setup();
    render(<App />);
    await snapshot([makeAgent()]);
    await user.click(screen.getByRole('button', { name: 'GitHub settings' }));
    expect(await screen.findByRole('dialog', { name: 'GitHub settings' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'GitHub settings' })).toBeNull());
  });

  it('saves a GitHub token from the GitHub settings dialog and stores the updated settings', async () => {
    const user = userEvent.setup();
    apiMock.githubSettings.mockResolvedValue({ hasToken: false, pollIntervalSecs: 300 });
    apiMock.setGithubToken.mockResolvedValue({ hasToken: true, pollIntervalSecs: 300 });
    render(<App />);
    await snapshot([makeAgent()]);
    await waitFor(() =>
      expect(useAppStore.getState().githubSettings).toEqual({ hasToken: false, pollIntervalSecs: 300 }),
    );
    await user.click(screen.getByRole('button', { name: 'GitHub settings' }));
    await user.type(screen.getByLabelText('Personal access token'), 'ghp_secret');
    await user.click(screen.getByRole('button', { name: 'Save token' }));
    expect(apiMock.setGithubToken).toHaveBeenCalledWith('ghp_secret');
    await waitFor(() =>
      expect(useAppStore.getState().githubSettings).toEqual({ hasToken: true, pollIntervalSecs: 300 }),
    );
  });

  it('clears a GitHub token from the GitHub settings dialog and stores the updated settings', async () => {
    const user = userEvent.setup();
    apiMock.githubSettings.mockResolvedValue({ hasToken: true, pollIntervalSecs: 300 });
    apiMock.clearGithubToken.mockResolvedValue({ hasToken: false, pollIntervalSecs: 300 });
    render(<App />);
    await snapshot([makeAgent()]);
    await waitFor(() =>
      expect(useAppStore.getState().githubSettings).toEqual({ hasToken: true, pollIntervalSecs: 300 }),
    );
    await user.click(screen.getByRole('button', { name: 'GitHub settings' }));
    await user.click(screen.getByRole('button', { name: 'Clear token' }));
    expect(apiMock.clearGithubToken).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(useAppStore.getState().githubSettings).toEqual({ hasToken: false, pollIntervalSecs: 300 }),
    );
  });

  it('saves the GitHub poll interval from the GitHub settings dialog and stores the updated settings', async () => {
    const user = userEvent.setup();
    apiMock.githubSettings.mockResolvedValue({ hasToken: false, pollIntervalSecs: 300 });
    apiMock.setGithubPollInterval.mockResolvedValue({ hasToken: false, pollIntervalSecs: 150 });
    render(<App />);
    await snapshot([makeAgent()]);
    await waitFor(() =>
      expect(useAppStore.getState().githubSettings).toEqual({ hasToken: false, pollIntervalSecs: 300 }),
    );
    await user.click(screen.getByRole('button', { name: 'GitHub settings' }));
    const field = screen.getByLabelText('Poll interval (minutes)');
    await user.clear(field);
    await user.type(field, '2.5');
    await user.click(screen.getByRole('button', { name: 'Save interval' }));
    expect(apiMock.setGithubPollInterval).toHaveBeenCalledWith(150);
    await waitFor(() =>
      expect(useAppStore.getState().githubSettings).toEqual({ hasToken: false, pollIntervalSecs: 150 }),
    );
  });

  it('opens GitHub settings from the new-agent dialog when no token is configured', async () => {
    const user = userEvent.setup();
    apiMock.githubSettings.mockResolvedValue({ hasToken: false, pollIntervalSecs: 300 });
    render(<App />);
    await snapshot([makeAgent()]);
    await waitFor(() =>
      expect(useAppStore.getState().githubSettings).toEqual({ hasToken: false, pollIntervalSecs: 300 }),
    );
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByLabelText('Import from a GitHub issue'));
    await user.click(screen.getByRole('button', { name: 'Configure GitHub' }));
    expect(await screen.findByRole('dialog', { name: 'GitHub settings' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'New agent' })).toBeNull();
  });

  it('sets an autonomous CI tracking target from the settings tab', async () => {
    const user = userEvent.setup();
    apiMock.setCiTracking.mockResolvedValue(makeAgent());
    render(<App />);
    await snapshot([makeAgent()]);
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Track a PR' }));
    await user.type(screen.getByLabelText('Pull request'), 'o/r#1');
    await user.click(screen.getByRole('button', { name: 'Start tracking' }));
    expect(apiMock.setCiTracking).toHaveBeenCalledWith('a1', 'o/r#1');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Track a PR' })).toBeNull());
  });

  it('clears CI tracking from the settings tab', async () => {
    const user = userEvent.setup();
    apiMock.clearCiTracking.mockResolvedValue({ ok: true });
    render(<App />);
    await snapshot([makeAgent({ ciTracking: { prRef: 'o/r#1', lastState: 'failure' } })]);
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Stop tracking' }));
    expect(apiMock.clearCiTracking).toHaveBeenCalledWith('a1');
  });

  it('creates an agent with an initial prompt fetched from a GitHub issue', async () => {
    const user = userEvent.setup();
    apiMock.githubSettings.mockResolvedValue({ hasToken: true, pollIntervalSecs: 300 });
    apiMock.fetchGithubIssue.mockResolvedValue({
      title: 'Fix the flaky test',
      body: 'It fails on CI about once a week.',
      url: 'https://github.com/o/r/issues/7',
      prompt: 'Work on this GitHub issue:\n\n# Fix the flaky test\n\n...',
    });
    apiMock.createAgent.mockResolvedValue(makeAgent({ id: 'b1', name: 'Fix the flaky test' }));
    render(<App />);
    await snapshot([makeAgent()]);
    await waitFor(() =>
      expect(useAppStore.getState().githubSettings).toEqual({ hasToken: true, pollIntervalSecs: 300 }),
    );
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByLabelText('Import from a GitHub issue'));
    await user.type(screen.getByLabelText('Issue'), 'o/r#7');
    await user.click(screen.getByRole('button', { name: 'Fetch issue' }));
    await screen.findByText('Fix the flaky test');
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(apiMock.fetchGithubIssue).toHaveBeenCalledWith('o/r#7');
    expect(apiMock.createAgent).toHaveBeenCalledWith({
      name: 'Fix the flaky test',
      projectId: 'project-1',
      useWorktree: true,
      approvalMode: 'always_ask',
      initialPrompt: 'Work on this GitHub issue:\n\n# Fix the flaky test\n\n...',
    });
  });

  it('closes the websocket connection on unmount', () => {
    const { unmount } = render(<App />);
    expect(ws.close).not.toHaveBeenCalled();
    unmount();
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it('reflects the server-configured agent cap instead of a fixed guess', async () => {
    render(<App />);
    await snapshot([makeAgent(), makeAgent({ id: 'a2', name: 'Beta' })], [], [makeProject()], 2);
    expect(screen.getByRole('button', { name: 'New' })).toBeDisabled();
  });

  it('surfaces a failed write action as a notification instead of losing it', async () => {
    const user = userEvent.setup();
    apiMock.prompt.mockRejectedValue(new Error('agent unreachable'));
    render(<App />);
    await snapshot([makeAgent()]);
    await user.type(screen.getByLabelText('Prompt'), 'do the thing');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('agent unreachable');
  });

  it('dismisses a notification on demand', async () => {
    const user = userEvent.setup();
    apiMock.cancel.mockRejectedValue(new Error('cannot cancel'));
    render(<App />);
    await snapshot([makeAgent({ status: 'working' })]);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('alert');
    await user.click(screen.getByLabelText('Dismiss'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('surfaces an agentError event as a notification', async () => {
    render(<App />);
    await snapshot([makeAgent()]);
    await act(async () => {
      handlers().onEvent({ type: 'agentError', agentId: 'a1', message: 'process exited unexpectedly' });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('process exited unexpectedly');
  });
});
