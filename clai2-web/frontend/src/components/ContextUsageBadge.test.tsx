import { act, render, screen } from '@testing-library/react';
import { vi } from 'vitest';

import type { ContextUsage } from '../api/types';
import { ContextUsageBadge } from './ContextUsageBadge';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ContextUsageBadge', () => {
  it('renders nothing before the first reading arrives', () => {
    const gate = deferred<ContextUsage>();
    const { container } = render(
      <ContextUsageBadge agentId="a1" sessionId="main" loadContextUsage={() => gate.promise} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when no request has happened yet (null reading)', async () => {
    const { container } = render(
      <ContextUsageBadge agentId="a1" sessionId="main" loadContextUsage={() => Promise.resolve(null)} />,
    );
    await act(() => Promise.resolve());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the rounded percentage once a reading resolves', async () => {
    const usage: ContextUsage = { usedTokens: 42_000, windowTokens: 200_000, resolved: true, fraction: 0.21 };
    render(<ContextUsageBadge agentId="a1" sessionId="main" loadContextUsage={() => Promise.resolve(usage)} />);
    expect(await screen.findByText('context: 21%')).toHaveClass('tabs-context');
    expect(screen.getByText('context: 21%')).not.toHaveClass('warning');
  });

  it('adds the warning class at or above the compaction trigger fraction', async () => {
    const usage: ContextUsage = { usedTokens: 178_000, windowTokens: 200_000, resolved: true, fraction: 0.85 };
    render(<ContextUsageBadge agentId="a1" sessionId="main" loadContextUsage={() => Promise.resolve(usage)} />);
    expect(await screen.findByText('context: 85%')).toHaveClass('tabs-context', 'warning');
  });

  it('marks an unresolved window with a trailing asterisk and a different title', async () => {
    const usage: ContextUsage = { usedTokens: 5_000, windowTokens: 200_000, resolved: false, fraction: 0.025 };
    render(<ContextUsageBadge agentId="a1" sessionId="main" loadContextUsage={() => Promise.resolve(usage)} />);
    const badge = await screen.findByText('context: 3%*');
    expect(badge).toHaveAttribute('title', 'Context window used (window size is a guess for this model)');
  });

  it('polls again after the interval and reflects the new reading', async () => {
    vi.useFakeTimers();
    const loadContextUsage = vi
      .fn<(agentId: string, sessionId: string) => Promise<ContextUsage>>()
      .mockResolvedValueOnce({ usedTokens: 1, windowTokens: 100, resolved: true, fraction: 0.1 })
      .mockResolvedValueOnce({ usedTokens: 2, windowTokens: 100, resolved: true, fraction: 0.2 });
    render(<ContextUsageBadge agentId="a1" sessionId="main" loadContextUsage={loadContextUsage} />);
    await act(() => Promise.resolve());
    expect(screen.getByText('context: 10%')).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByText('context: 20%')).toBeInTheDocument();
    expect(loadContextUsage).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('stops polling once unmounted', async () => {
    vi.useFakeTimers();
    const loadContextUsage = vi
      .fn<(agentId: string, sessionId: string) => Promise<ContextUsage>>()
      .mockResolvedValue({ usedTokens: 1, windowTokens: 100, resolved: true, fraction: 0.1 });
    const { unmount } = render(
      <ContextUsageBadge agentId="a1" sessionId="main" loadContextUsage={loadContextUsage} />,
    );
    await act(() => Promise.resolve());
    expect(loadContextUsage).toHaveBeenCalledTimes(1);

    unmount();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(loadContextUsage).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('re-fetches and clears the old reading when the session changes', async () => {
    const loadContextUsage = vi
      .fn<(agentId: string, sessionId: string) => Promise<ContextUsage>>()
      .mockResolvedValueOnce({ usedTokens: 1, windowTokens: 100, resolved: true, fraction: 0.1 })
      .mockResolvedValueOnce({ usedTokens: 4, windowTokens: 100, resolved: true, fraction: 0.4 });
    const { rerender } = render(
      <ContextUsageBadge agentId="a1" sessionId="main" loadContextUsage={loadContextUsage} />,
    );
    expect(await screen.findByText('context: 10%')).toBeInTheDocument();

    rerender(<ContextUsageBadge agentId="a1" sessionId="side" loadContextUsage={loadContextUsage} />);
    expect(screen.queryByText('context: 10%')).toBeNull();
    expect(await screen.findByText('context: 40%')).toBeInTheDocument();
    expect(loadContextUsage.mock.calls).toEqual([
      ['a1', 'main'],
      ['a1', 'side'],
    ]);
  });

  it('discards a stale in-flight response from before a session change', async () => {
    const first = deferred<ContextUsage>();
    const second = deferred<ContextUsage>();
    const loadContextUsage = vi
      .fn<(agentId: string, sessionId: string) => Promise<ContextUsage>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { rerender } = render(
      <ContextUsageBadge agentId="a1" sessionId="main" loadContextUsage={loadContextUsage} />,
    );
    rerender(<ContextUsageBadge agentId="a1" sessionId="side" loadContextUsage={loadContextUsage} />);

    second.resolve({ usedTokens: 4, windowTokens: 100, resolved: true, fraction: 0.4 });
    first.resolve({ usedTokens: 1, windowTokens: 100, resolved: true, fraction: 0.1 });
    expect(await screen.findByText('context: 40%')).toBeInTheDocument();
    expect(screen.queryByText('context: 10%')).toBeNull();
  });

  it('keeps the last good reading when a poll rejects', async () => {
    vi.useFakeTimers();
    const loadContextUsage = vi
      .fn<(agentId: string, sessionId: string) => Promise<ContextUsage>>()
      .mockResolvedValueOnce({ usedTokens: 1, windowTokens: 100, resolved: true, fraction: 0.1 })
      .mockRejectedValueOnce(new Error('offline'));
    render(<ContextUsageBadge agentId="a1" sessionId="main" loadContextUsage={loadContextUsage} />);
    await act(() => Promise.resolve());
    expect(screen.getByText('context: 10%')).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByText('context: 10%')).toBeInTheDocument();
    vi.useRealTimers();
  });
});
