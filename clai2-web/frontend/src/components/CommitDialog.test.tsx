import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import type { CreatedPullRequest } from '../api/types';
import { CommitDialog } from './CommitDialog';

function renderDialog(overrides: Partial<Parameters<typeof CommitDialog>[0]> = {}) {
  const props = {
    agentName: 'fix-auth-bug',
    defaultMessage: 'Update src/auth.py',
    onCommit: vi.fn<(message: string) => Promise<void>>().mockResolvedValue(undefined),
    onOpenPullRequest: vi
      .fn<(title: string, body: string) => Promise<CreatedPullRequest>>()
      .mockResolvedValue({ url: 'https://github.com/o/r/pull/9', number: 9 }),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<CommitDialog {...props} />), props };
}

describe('CommitDialog', () => {
  it('shows the dialog pre-filled with the default message', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Commit changes in fix-auth-bug' })).toBeInTheDocument();
    expect(screen.getByLabelText('Commit message')).toHaveValue('Update src/auth.py');
  });

  it('hides the pull request fields until the toggle is checked', () => {
    renderDialog();
    expect(screen.queryByLabelText('Pull request title')).toBeNull();
    expect(screen.queryByLabelText('Description')).toBeNull();
  });

  it('reveals pull request fields, pre-filled from the commit message, once toggled', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByLabelText('Also open a pull request'));
    expect(screen.getByLabelText('Pull request title')).toHaveValue('Update src/auth.py');
    expect(screen.getByLabelText('Description')).toHaveValue('');
  });

  it('requires a non-blank commit message', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog({ defaultMessage: '' });
    await user.click(screen.getByRole('button', { name: 'Commit' }));
    expect(screen.getByText('Describe what changed.')).toHaveClass('form-error');
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it('commits the trimmed message and closes when the PR toggle is off', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.type(screen.getByLabelText('Commit message'), '  ');
    await user.click(screen.getByRole('button', { name: 'Commit' }));
    expect(props.onCommit).toHaveBeenCalledWith('Update src/auth.py');
    expect(props.onOpenPullRequest).not.toHaveBeenCalled();
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
  });

  it('requires a pull request title when the toggle is on', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.click(screen.getByLabelText('Also open a pull request'));
    await user.clear(screen.getByLabelText('Pull request title'));
    await user.click(screen.getByRole('button', { name: 'Commit and open PR' }));
    expect(screen.getByText('Give the pull request a title.')).toHaveClass('form-error');
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it('commits, opens the pull request, and shows its link instead of closing', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.click(screen.getByLabelText('Also open a pull request'));
    await user.type(screen.getByLabelText('Description'), 'Closes #1');
    await user.click(screen.getByRole('button', { name: 'Commit and open PR' }));
    expect(props.onCommit).toHaveBeenCalledWith('Update src/auth.py');
    await waitFor(() => expect(props.onOpenPullRequest).toHaveBeenCalledWith('Update src/auth.py', 'Closes #1'));
    expect(await screen.findByText('Pull request opened')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: '#9 on GitHub' });
    expect(link).toHaveAttribute('href', 'https://github.com/o/r/pull/9');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(props.onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the error and stays open when the commit rejects', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog({
      onCommit: vi.fn<(message: string) => Promise<void>>().mockRejectedValue(new Error('nothing to commit')),
    });
    await user.click(screen.getByRole('button', { name: 'Commit' }));
    expect(await screen.findByText('nothing to commit')).toHaveClass('form-error');
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Commit' })).toBeEnabled();
  });

  it('shows the error and stays open when opening the pull request rejects', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog({
      onOpenPullRequest: vi.fn<(title: string, body: string) => Promise<CreatedPullRequest>>().mockRejectedValue(new Error('no token')),
    });
    await user.click(screen.getByLabelText('Also open a pull request'));
    await user.click(screen.getByRole('button', { name: 'Commit and open PR' }));
    expect(await screen.findByText('no token')).toHaveClass('form-error');
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('shows the busy label while working', async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const { props } = renderDialog({
      onCommit: vi.fn<(message: string) => Promise<void>>(
        () =>
          new Promise<void>((res) => {
            resolve = res;
          }),
      ),
    });
    await user.click(screen.getByRole('button', { name: 'Commit' }));
    expect(screen.getByRole('button', { name: 'Working...' })).toBeDisabled();
    resolve();
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
  });

  it('closes on backdrop click but not on clicks inside the dialog', async () => {
    const user = userEvent.setup();
    const { container, props } = renderDialog();
    await user.click(screen.getByRole('dialog', { name: 'Commit changes in fix-auth-bug' }));
    expect(props.onClose).not.toHaveBeenCalled();
    await user.click(container.querySelector('.dialog-backdrop') as Element);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes the success view on backdrop click too', async () => {
    const user = userEvent.setup();
    const { container, props } = renderDialog();
    await user.click(screen.getByLabelText('Also open a pull request'));
    await user.click(screen.getByRole('button', { name: 'Commit and open PR' }));
    await screen.findByText('Pull request opened');
    await user.click(container.querySelector('.dialog-backdrop') as Element);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
