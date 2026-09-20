import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import type { DebugContext, DebugMessage } from '../api/types';
import { DebugContextDialog } from './DebugContextDialog';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderDialog(overrides: Partial<Parameters<typeof DebugContextDialog>[0]> = {}) {
  const props = {
    agentId: 'a1',
    sessionId: 'main',
    agentName: 'triage-issues',
    sessionLabel: 'Main',
    loadDebugContext: vi.fn<(agentId: string, sessionId: string) => Promise<DebugContext>>().mockResolvedValue(null),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<DebugContextDialog {...props} />), props };
}

describe('DebugContextDialog', () => {
  it('shows loading, then mentions the agent and session', async () => {
    const gate = deferred<DebugContext>();
    renderDialog({ loadDebugContext: vi.fn(() => gate.promise) });
    expect(screen.getByRole('dialog', { name: 'Debug context' })).toBeInTheDocument();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.getByText(/triage-issues last sent to the model for .Main./)).toBeInTheDocument();
    gate.resolve(null);
    await screen.findByText(/No snapshot yet/);
  });

  it('says no snapshot yet when the agent has not made a model request', async () => {
    renderDialog();
    expect(await screen.findByText(/No snapshot yet -- triage-issues hasn't made a model request/)).toBeInTheDocument();
  });

  it('shows the error message when loading rejects', async () => {
    renderDialog({ loadDebugContext: vi.fn(() => Promise.reject(new Error('debug context failed'))) });
    expect(await screen.findByText('debug context failed')).toHaveClass('form-error');
  });

  it('renders system-prompt, user-prompt, text, and thinking parts under their labels', async () => {
    const data: DebugMessage[] = [
      { kind: 'request', parts: [{ part_kind: 'system-prompt', content: 'be nice' }, { part_kind: 'user-prompt', content: 'hi' }] },
      { kind: 'response', parts: [{ part_kind: 'thinking', content: 'pondering' }, { part_kind: 'text', content: 'hello' }] },
    ];
    renderDialog({ loadDebugContext: vi.fn().mockResolvedValue(data) });
    expect(await screen.findByText('#1 · request')).toBeInTheDocument();
    expect(screen.getByText('#2 · response')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.getByText('be nice')).toBeInTheDocument();
    expect(screen.getByText('User')).toBeInTheDocument();
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.getByText('pondering')).toBeInTheDocument();
    expect(screen.getByText('Assistant')).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('renders tool-call args and tool-return content under the tool name', async () => {
    const data: DebugMessage[] = [
      {
        kind: 'response',
        parts: [{ part_kind: 'tool-call', tool_name: 'search', args: { q: 'x' }, tool_call_id: 'tc1' }],
      },
      {
        kind: 'request',
        parts: [{ part_kind: 'tool-return', tool_name: 'search', content: 'result', tool_call_id: 'tc1' }],
      },
    ];
    renderDialog({ loadDebugContext: vi.fn().mockResolvedValue(data) });
    expect(await screen.findByText('Tool call: search')).toBeInTheDocument();
    expect(screen.getByText(/"q": "x"/)).toBeInTheDocument();
    expect(screen.getByText('Tool result: search')).toBeInTheDocument();
    expect(screen.getByText('result')).toBeInTheDocument();
  });

  it('falls back to a raw JSON dump of the part for an unrecognized part_kind', async () => {
    const data: DebugMessage[] = [{ kind: 'request', parts: [{ part_kind: 'mystery-part', foo: 'bar' }] }];
    renderDialog({ loadDebugContext: vi.fn().mockResolvedValue(data) });
    expect(await screen.findByText('mystery-part')).toBeInTheDocument();
    expect(screen.getByText(/"foo": "bar"/)).toBeInTheDocument();
  });

  it('truncates long content with a Show more toggle that expands and collapses', async () => {
    const long = 'x'.repeat(850);
    const data: DebugMessage[] = [{ kind: 'request', parts: [{ part_kind: 'user-prompt', content: long }] }];
    const user = userEvent.setup();
    renderDialog({ loadDebugContext: vi.fn().mockResolvedValue(data) });
    await screen.findByText('User');
    expect(screen.getByText(`${'x'.repeat(800)}...`)).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Show 50 more characters' });
    await user.click(toggle);
    expect(screen.getByText(long)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.getByText(`${'x'.repeat(800)}...`)).toBeInTheDocument();
  });

  it('does not show a truncation toggle for short content', async () => {
    const data: DebugMessage[] = [{ kind: 'request', parts: [{ part_kind: 'user-prompt', content: 'short' }] }];
    renderDialog({ loadDebugContext: vi.fn().mockResolvedValue(data) });
    await screen.findByText('short');
    expect(screen.queryByRole('button', { name: /more characters/ })).toBeNull();
  });

  it('toggles between the formatted list and raw JSON', async () => {
    const data: DebugMessage[] = [{ kind: 'request', parts: [{ part_kind: 'user-prompt', content: 'hi' }] }];
    const user = userEvent.setup();
    renderDialog({ loadDebugContext: vi.fn().mockResolvedValue(data) });
    await screen.findByText('hi');
    await user.click(screen.getByRole('button', { name: 'Show raw JSON' }));
    expect(screen.queryByText('User')).toBeNull();
    expect(screen.getByText(/"part_kind": "user-prompt"/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show formatted' }));
    expect(screen.getByText('User')).toBeInTheDocument();
  });

  it('fires onClose from the Close button', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await screen.findByText(/No snapshot yet/);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onClose when the backdrop is clicked, but not when the dialog body is clicked', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.click(screen.getByRole('dialog', { name: 'Debug context' }));
    expect(props.onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('dialog', { name: 'Debug context' }).parentElement!);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('calls loadDebugContext with the agent and session ids', async () => {
    const loadDebugContext = vi.fn<(agentId: string, sessionId: string) => Promise<DebugContext>>().mockResolvedValue(null);
    renderDialog({ agentId: 'a9', sessionId: 'side-1', loadDebugContext });
    await screen.findByText(/No snapshot yet/);
    expect(loadDebugContext).toHaveBeenCalledWith('a9', 'side-1');
  });

  it('reloads when the session changes, discarding a stale in-flight response', async () => {
    const first = deferred<DebugContext>();
    const second = deferred<DebugContext>();
    const loadDebugContext = vi
      .fn<(agentId: string, sessionId: string) => Promise<DebugContext>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { rerender } = renderDialog({ sessionId: 'main', loadDebugContext });
    rerender(
      <DebugContextDialog
        agentId="a1"
        sessionId="side"
        agentName="triage-issues"
        sessionLabel="Side chat"
        loadDebugContext={loadDebugContext}
        onClose={vi.fn()}
      />,
    );
    first.resolve([{ kind: 'request', parts: [{ part_kind: 'user-prompt', content: 'stale' }] }]);
    second.resolve([{ kind: 'request', parts: [{ part_kind: 'user-prompt', content: 'fresh' }] }]);
    await screen.findByText('fresh');
    expect(screen.queryByText('stale')).toBeNull();
    expect(loadDebugContext.mock.calls).toEqual([
      ['a1', 'main'],
      ['a1', 'side'],
    ]);
  });
});
