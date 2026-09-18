import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import type { CreateAgentRequest } from '../api/types';
import { NewAgentDialog } from './NewAgentDialog';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('NewAgentDialog', () => {
  it('shows a validation error on an empty name without creating', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn<(request: CreateAgentRequest) => Promise<void>>();
    const onClose = vi.fn();
    render(<NewAgentDialog onCreate={onCreate} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(screen.getByText('Give the agent a name.')).toHaveClass('form-error');
    expect(onCreate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('builds the request with a trimmed name and base branch, then closes', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn<(request: CreateAgentRequest) => Promise<void>>().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<NewAgentDialog onCreate={onCreate} onClose={onClose} />);
    await user.type(screen.getByPlaceholderText('fix-auth-bug'), '  my agent  ');
    await user.type(screen.getByPlaceholderText('main'), '  develop  ');
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(onCreate.mock.calls).toStrictEqual([
      [{ name: 'my agent', useWorktree: true, baseBranch: 'develop', approvalMode: 'always_ask' }],
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('omits baseBranch when it is blank', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn<(request: CreateAgentRequest) => Promise<void>>().mockResolvedValue(undefined);
    render(<NewAgentDialog onCreate={onCreate} onClose={vi.fn()} />);
    await user.type(screen.getByPlaceholderText('fix-auth-bug'), 'agent');
    await user.type(screen.getByPlaceholderText('main'), '   ');
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(onCreate.mock.calls).toStrictEqual([[{ name: 'agent', useWorktree: true, approvalMode: 'always_ask' }]]);
  });

  it('hides the base branch field and omits it when the worktree is unchecked', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn<(request: CreateAgentRequest) => Promise<void>>().mockResolvedValue(undefined);
    render(<NewAgentDialog onCreate={onCreate} onClose={vi.fn()} />);
    await user.type(screen.getByPlaceholderText('main'), 'develop');
    await user.click(screen.getByLabelText('Create an isolated worktree and branch'));
    expect(screen.queryByPlaceholderText('main')).toBeNull();
    await user.type(screen.getByPlaceholderText('fix-auth-bug'), 'agent');
    await user.selectOptions(screen.getByRole('combobox'), 'accept_edits');
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(onCreate.mock.calls).toStrictEqual([[{ name: 'agent', useWorktree: false, approvalMode: 'accept_edits' }]]);
  });

  it('shows the error and stays open when onCreate rejects', async () => {
    const user = userEvent.setup();
    const onCreate = vi
      .fn<(request: CreateAgentRequest) => Promise<void>>()
      .mockRejectedValue(new Error('too many agents'));
    const onClose = vi.fn();
    render(<NewAgentDialog onCreate={onCreate} onClose={onClose} />);
    await user.type(screen.getByPlaceholderText('fix-auth-bug'), 'agent');
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(await screen.findByText('too many agents')).toHaveClass('form-error');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start agent' })).toBeEnabled();
  });

  it('stringifies non-Error failures', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn<(request: CreateAgentRequest) => Promise<void>>().mockRejectedValue('plain refusal');
    render(<NewAgentDialog onCreate={onCreate} onClose={vi.fn()} />);
    await user.type(screen.getByPlaceholderText('fix-auth-bug'), 'agent');
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(await screen.findByText('plain refusal')).toBeInTheDocument();
  });

  it('shows the busy label while creation is pending', async () => {
    const user = userEvent.setup();
    const gate = deferred();
    const onCreate = vi.fn<(request: CreateAgentRequest) => Promise<void>>(() => gate.promise);
    const onClose = vi.fn();
    render(<NewAgentDialog onCreate={onCreate} onClose={onClose} />);
    await user.type(screen.getByPlaceholderText('fix-auth-bug'), 'agent');
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(screen.getByRole('button', { name: 'Starting...' })).toBeDisabled();
    gate.resolve();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('closes on backdrop click and Cancel, but not on clicks inside', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(<NewAgentDialog onCreate={vi.fn()} onClose={onClose} />);
    await user.click(screen.getByRole('dialog', { name: 'New agent' }));
    expect(onClose).not.toHaveBeenCalled();
    const backdrop = container.querySelector('.dialog-backdrop');
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
