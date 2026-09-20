import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';

import type { WorktreeDiff } from '../api/types';
import { defaultCommitMessage, DiffPanel } from './DiffPanel';

const noopCommit = () => undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('DiffPanel', () => {
  it('shows loading, then the diff with add/del line classes', async () => {
    const gate = deferred<WorktreeDiff>();
    const loadDiff = vi.fn(() => gate.promise);
    const { container } = render(<DiffPanel agentId="a1" loadDiff={loadDiff} onCommit={noopCommit} />);
    expect(screen.getByText('Loading diff...')).toBeInTheDocument();
    expect(loadDiff).toHaveBeenCalledWith('a1');
    gate.resolve({ diff: '+added\n-removed\n context', untrackedDiff: '', status: '' });
    await screen.findByLabelText('Changes');
    const spans = Array.from(container.querySelectorAll('pre span'));
    expect(spans.map((span) => [span.className, span.textContent])).toEqual([
      ['diff-line-add', '+added\n'],
      ['diff-line-del', '-removed\n'],
      ['', ' context\n'],
    ]);
  });

  it('renders the untracked diff and the status block', async () => {
    const loadDiff = vi.fn(() =>
      Promise.resolve({ diff: '', untrackedDiff: '+new file line', status: 'M src/a.ts' }),
    );
    const { container } = render(<DiffPanel agentId="a1" loadDiff={loadDiff} onCommit={noopCommit} />);
    expect(await screen.findByText('M src/a.ts')).toHaveClass('diff-meta');
    const add = container.querySelector('.diff-line-add');
    expect(add).toHaveTextContent('+new file line');
    expect(screen.queryByText('No changes against the base branch.')).toBeNull();
  });

  it('says no changes when both diffs are empty', async () => {
    const loadDiff = vi.fn(() => Promise.resolve({ diff: '', untrackedDiff: '', status: '' }));
    const { container } = render(<DiffPanel agentId="a1" loadDiff={loadDiff} onCommit={noopCommit} />);
    expect(await screen.findByText('No changes against the base branch.')).toBeInTheDocument();
    expect(container.querySelector('.diff-meta')).toBeNull();
  });

  it('shows the error message when loading rejects', async () => {
    const loadDiff = vi.fn(() => Promise.reject(new Error('diff failed')));
    render(<DiffPanel agentId="a1" loadDiff={loadDiff} onCommit={noopCommit} />);
    const error = await screen.findByText('diff failed');
    expect(error).toHaveClass('block-error');
  });

  it('stringifies non-Error rejections', async () => {
    const loadDiff = vi.fn(() => Promise.reject('plain failure'));
    render(<DiffPanel agentId="a1" loadDiff={loadDiff} onCommit={noopCommit} />);
    expect(await screen.findByText('plain failure')).toBeInTheDocument();
  });

  it('reloads when the agentId changes', async () => {
    const loadDiff = vi
      .fn<(agentId: string) => Promise<WorktreeDiff>>()
      .mockResolvedValueOnce({ diff: '+first', untrackedDiff: '', status: '' })
      .mockResolvedValueOnce({ diff: '+second', untrackedDiff: '', status: '' });
    const { rerender } = render(<DiffPanel agentId="a1" loadDiff={loadDiff} onCommit={noopCommit} />);
    await screen.findByText('+first');
    rerender(<DiffPanel agentId="a2" loadDiff={loadDiff} onCommit={noopCommit} />);
    expect(screen.getByText('Loading diff...')).toBeInTheDocument();
    await screen.findByText('+second');
    expect(loadDiff.mock.calls).toEqual([['a1'], ['a2']]);
    expect(screen.queryByText('+first')).toBeNull();
  });

  it('disables Commit... when the worktree is clean', async () => {
    const loadDiff = vi.fn(() => Promise.resolve({ diff: '+x', untrackedDiff: '', status: '' }));
    render(<DiffPanel agentId="a1" loadDiff={loadDiff} onCommit={noopCommit} />);
    expect(await screen.findByRole('button', { name: 'Commit...' })).toBeDisabled();
  });

  it('enables Commit... and passes a computed default message when there are changes', async () => {
    const loadDiff = vi.fn(() => Promise.resolve({ diff: '', untrackedDiff: '', status: ' M src/a.ts\n?? src/b.ts' }));
    const onCommit = vi.fn();
    render(<DiffPanel agentId="a1" loadDiff={loadDiff} onCommit={onCommit} />);
    const button = await screen.findByRole('button', { name: 'Commit...' });
    expect(button).toBeEnabled();
    button.click();
    expect(onCommit).toHaveBeenCalledWith('Update 2 files');
  });
});

describe('defaultCommitMessage', () => {
  it('returns blank for an empty status', () => {
    expect(defaultCommitMessage('')).toBe('');
  });

  it('names the single changed file', () => {
    expect(defaultCommitMessage(' M src/a.ts')).toBe('Update src/a.ts');
  });

  it('counts multiple changed files', () => {
    expect(defaultCommitMessage(' M src/a.ts\n?? src/b.ts\n D src/c.ts')).toBe('Update 3 files');
  });
});
