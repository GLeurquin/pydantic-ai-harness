import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, vi } from 'vitest';

import { App } from './App';
import type { AgentSummary, ApprovalView, RedactedProfile, TranscriptItem } from './api/types';
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
  pendingApprovals: vi.fn(),
  resolveApproval: vi.fn(),
  transcript: vi.fn(),
  diff: vi.fn(),
  listModels: vi.fn(),
  createModel: vi.fn(),
  updateModel: vi.fn(),
  deleteModel: vi.fn(),
  setAgentModel: vi.fn(),
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
    label: 'Claude Sonnet',
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

async function snapshot(agents: AgentSummary[], approvals: ApprovalView[] = []) {
  await act(async () => {
    handlers().onSnapshot({ agents, approvals });
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
    transcripts: {},
    selectedAgentId: null,
    view: { kind: 'session', sessionId: 'main' },
  });
  apiMock.transcript.mockResolvedValue([]);
  apiMock.prompt.mockResolvedValue({ ok: true });
  apiMock.resolveApproval.mockResolvedValue({ ok: true });
  apiMock.setApprovalMode.mockResolvedValue(makeAgent());
  apiMock.archiveAgent.mockResolvedValue(makeAgent({ status: 'archived' }));
  apiMock.listModels.mockResolvedValue([]);
  apiMock.setAgentModel.mockResolvedValue(makeAgent());
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

  it('loads the model profiles into the store on mount', async () => {
    apiMock.listModels.mockResolvedValue([makeProfile()]);
    render(<App />);
    await waitFor(() => expect(useAppStore.getState().models).toEqual([makeProfile()]));
    expect(apiMock.listModels).toHaveBeenCalledTimes(1);
  });

  it('ignores a failed model profile load', async () => {
    apiMock.listModels.mockRejectedValue(new Error('offline'));
    render(<App />);
    await snapshot([makeAgent()]);
    expect(useAppStore.getState().models).toEqual([]);
  });

  it('opens the Models dialog from the header', async () => {
    const user = userEvent.setup();
    apiMock.listModels.mockResolvedValue([]);
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Model profiles' }));
    expect(await screen.findByRole('dialog', { name: 'Model profiles' })).toBeInTheDocument();
  });

  it('passes the chosen model profile to createAgent', async () => {
    const user = userEvent.setup();
    apiMock.listModels.mockResolvedValue([makeProfile({ id: 'm1', label: 'Claude Sonnet' })]);
    apiMock.createAgent.mockResolvedValue(makeAgent({ id: 'b1', name: 'Builder' }));
    render(<App />);
    await snapshot([makeAgent()]);
    await waitFor(() => expect(useAppStore.getState().models).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.type(screen.getByPlaceholderText('fix-auth-bug'), 'Builder');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'm1');
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(apiMock.createAgent).toHaveBeenCalledWith({
      name: 'Builder',
      useWorktree: true,
      approvalMode: 'always_ask',
      modelProfileId: 'm1',
    });
  });

  it('sets the agent model from the Settings tab', async () => {
    const user = userEvent.setup();
    apiMock.listModels.mockResolvedValue([makeProfile({ id: 'm1', label: 'Claude Sonnet' })]);
    render(<App />);
    await snapshot([makeAgent()]);
    await waitFor(() => expect(useAppStore.getState().models).toHaveLength(1));
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.selectOptions(screen.getByLabelText('Model profile'), 'm1');
    expect(apiMock.setAgentModel).toHaveBeenCalledWith('a1', 'm1');
    await user.selectOptions(screen.getByLabelText('Model profile'), 'Default (server environment)');
    expect(apiMock.setAgentModel).toHaveBeenLastCalledWith('a1', null);
  });

  it('switches from the New agent dialog to the Models dialog', async () => {
    const user = userEvent.setup();
    apiMock.listModels.mockResolvedValue([]);
    render(<App />);
    await snapshot([makeAgent()]);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('button', { name: 'Manage model profiles' }));
    expect(await screen.findByRole('dialog', { name: 'Model profiles' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'New agent' })).toBeNull();
  });

  it('opens the Models dialog from the Settings tab', async () => {
    const user = userEvent.setup();
    apiMock.listModels.mockResolvedValue([]);
    render(<App />);
    await snapshot([makeAgent()]);
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Manage profiles' }));
    expect(await screen.findByRole('dialog', { name: 'Model profiles' })).toBeInTheDocument();
  });

  it('updates the store when a profile is created in the Models dialog', async () => {
    const user = userEvent.setup();
    apiMock.listModels.mockResolvedValue([]);
    apiMock.createModel.mockResolvedValue(makeProfile({ id: 'new1', label: 'New Model' }));
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Model profiles' }));
    const dialog = await screen.findByRole('dialog', { name: 'Model profiles' });
    await user.click(within(dialog).getByRole('button', { name: 'New profile' }));
    await user.type(screen.getByPlaceholderText('Vertex Gemini'), 'New Model');
    await user.type(screen.getByPlaceholderText('claude-sonnet-4-6'), 'claude-sonnet-4-6');
    await user.click(screen.getByRole('button', { name: 'Add profile' }));
    await waitFor(() =>
      expect(useAppStore.getState().models).toEqual([makeProfile({ id: 'new1', label: 'New Model' })]),
    );
  });

  it('closes the Models dialog from its Close button', async () => {
    const user = userEvent.setup();
    apiMock.listModels.mockResolvedValue([]);
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Model profiles' }));
    const dialog = await screen.findByRole('dialog', { name: 'Model profiles' });
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Model profiles' })).toBeNull();
  });

  it('closes the websocket connection on unmount', () => {
    const { unmount } = render(<App />);
    expect(ws.close).not.toHaveBeenCalled();
    unmount();
    expect(ws.close).toHaveBeenCalledTimes(1);
  });
});
