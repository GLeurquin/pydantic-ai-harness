import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, vi } from 'vitest';

import type { AgentSummary, ApprovalView, StopReason, TranscriptItem } from '../api/types';
import { Conversation } from './Conversation';

beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollTo', { value: vi.fn(), writable: true });
});

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

function renderConversation(props: Partial<Parameters<typeof Conversation>[0]> = {}) {
  const defaults = {
    agent: makeAgent(),
    sessionId: 'main',
    items: [] as TranscriptItem[],
    approvals: [] as ApprovalView[],
    onPrompt: vi.fn(),
    onCancel: vi.fn(),
    onResolveApproval: vi.fn(),
  };
  const merged = { ...defaults, ...props };
  return { ...render(<Conversation {...merged} />), props: merged };
}

describe('Conversation', () => {
  it('renders every transcript block kind', () => {
    const items: TranscriptItem[] = [
      { type: 'userMessage', text: 'do the thing' },
      { type: 'thoughtChunk', text: 'thinking...' },
      { type: 'messageChunk', text: 'on it' },
      {
        type: 'toolCall',
        toolCall: { toolCallId: 'tc1', title: 'Read file', kind: 'read', status: 'completed', content: [], locations: [] },
      },
      { type: 'plan', entries: [{ content: 'write tests', priority: 'high', status: 'in_progress' }] },
      { type: 'turnEnded', stopReason: 'end_turn' },
      { type: 'error', message: 'agent crashed' },
    ];
    const { container } = renderConversation({ items });
    expect(container.querySelector('.block-user')).toHaveTextContent('do the thing');
    expect(container.querySelector('.block-thought')).toHaveTextContent('thinking...');
    expect(container.querySelector('.block-assistant')).toHaveTextContent('on it');
    expect(container.querySelector('.tool-card .tool-title')).toHaveTextContent('Read file');
    const plan = container.querySelector('.plan-entry');
    expect(plan?.querySelector('.plan-status')).toHaveTextContent('[in_progress]');
    expect(plan).toHaveTextContent('write tests');
    expect(container.querySelector('.block-turn-end')).toHaveTextContent('turn finished');
    expect(container.querySelector('.block-error')).toHaveTextContent('agent crashed');
  });

  const STOP_CASES: [StopReason, string][] = [
    ['end_turn', 'turn finished'],
    ['max_tokens', 'stopped: token limit'],
    ['max_turn_requests', 'stopped: request limit'],
    ['refusal', 'stopped: refused'],
    ['cancelled', 'cancelled'],
  ];

  it.each(STOP_CASES)('labels the %s stop reason', (stopReason, label) => {
    const { container } = renderConversation({ items: [{ type: 'turnEnded', stopReason }] });
    expect(container.querySelector('.block-turn-end')).toHaveTextContent(label);
  });

  it('sends the typed prompt and clears the draft', async () => {
    const user = userEvent.setup();
    const { props } = renderConversation();
    const textarea = screen.getByLabelText('Prompt');
    await user.type(textarea, 'hello agent');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(props.onPrompt).toHaveBeenCalledTimes(1);
    expect(props.onPrompt).toHaveBeenCalledWith('hello agent');
    expect(textarea).toHaveValue('');
  });

  it('submits on Enter but not Shift+Enter', async () => {
    const user = userEvent.setup();
    const { props } = renderConversation();
    const textarea = screen.getByLabelText('Prompt');
    await user.type(textarea, 'line one');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(props.onPrompt).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(props.onPrompt).toHaveBeenCalledTimes(1);
    expect(props.onPrompt).toHaveBeenCalledWith('line one');
  });

  it('does not send a blank draft on Enter', async () => {
    const user = userEvent.setup();
    const { props } = renderConversation();
    await user.type(screen.getByLabelText('Prompt'), '   ');
    await user.keyboard('{Enter}');
    expect(props.onPrompt).not.toHaveBeenCalled();
  });

  it('disables Send for a blank draft', async () => {
    const user = userEvent.setup();
    renderConversation();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.type(screen.getByLabelText('Prompt'), 'x');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it.each(['working', 'waiting_approval'] as const)('replaces Send with Cancel while %s', async (status) => {
    const user = userEvent.setup();
    const { props } = renderConversation({ agent: makeAgent({ status }) });
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.getByLabelText('Prompt')).toHaveAttribute('placeholder', 'Agent is working...');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveClass('danger');
    await user.click(cancel);
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows the agent-name placeholder while idle', () => {
    renderConversation();
    expect(screen.getByLabelText('Prompt')).toHaveAttribute('placeholder', 'Message Alpha');
  });

  it('renders only approvals for this agent and session and resolves them', async () => {
    const user = userEvent.setup();
    const approvals = [
      makeApproval(),
      makeApproval({ id: 'ap2', agentId: 'other-agent' }),
      makeApproval({ id: 'ap3', sessionId: 'side' }),
    ];
    const { props } = renderConversation({ approvals });
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(props.onResolveApproval).toHaveBeenCalledWith('ap1', 'allow-once');
  });
});
