import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, vi } from 'vitest';

import { App } from './App';
import type { AgentSummary, ApprovalView, ProjectSummary, TranscriptItem } from './api/types';
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
  pendingApprovals: vi.fn(),
  resolveApproval: vi.fn(),
  transcript: vi.fn(),
  diff: vi.fn(),
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
    sessions: [{ id: 'main', acpSessionId: null, label: 'Main', isMain: true }],
    pendingApprovals: 0,
    forkedFrom: null,
    lastError: null,
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
) {
  await act(async () => {
    handlers().onSnapshot({ agents, approvals, projects, maxAgents });
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
    await user.click(screen.getByRole('button', { name: 'Fork' }));
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
        { id: 'main', acpSessionId: null, label: 'Main', isMain: true },
        { id: 's2', acpSessionId: null, label: 'Approach chat', isMain: false },
      ],
    });
    apiMock.openSideSession.mockResolvedValue(updated);
    render(<App />);
    await snapshot([makeAgent()]);
    await user.click(screen.getByRole('button', { name: 'Side conversation' }));
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
