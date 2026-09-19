import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { CiTrackingDialog } from './CiTrackingDialog';

function renderDialog(overrides: Partial<Parameters<typeof CiTrackingDialog>[0]> = {}) {
  const props = {
    agentName: 'fix-auth-bug',
    onSubmit: vi.fn<(prRef: string) => Promise<void>>().mockResolvedValue(undefined),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<CiTrackingDialog {...props} />), props };
}

describe('CiTrackingDialog', () => {
  it('shows the dialog and mentions the agent by name', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Track a PR' })).toBeInTheDocument();
    expect(screen.getByText(/fix-auth-bug will get a prompt/)).toBeInTheDocument();
  });

  it('requires a pull request reference', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Start tracking' }));
    expect(screen.getByText('Give the pull request to track.')).toHaveClass('form-error');
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('submits the trimmed reference and closes', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.type(screen.getByLabelText('Pull request'), '  o/r#42  ');
    await user.click(screen.getByRole('button', { name: 'Start tracking' }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).toHaveBeenCalledWith('o/r#42');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the error and stays open when onSubmit rejects', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog({
      onSubmit: vi.fn<(prRef: string) => Promise<void>>().mockRejectedValue(new Error('could not parse')),
    });
    await user.type(screen.getByLabelText('Pull request'), 'not-a-pr');
    await user.click(screen.getByRole('button', { name: 'Start tracking' }));
    expect(await screen.findByText('could not parse')).toHaveClass('form-error');
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start tracking' })).toBeEnabled();
  });

  it('shows the busy label while submitting', async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const { props } = renderDialog({
      onSubmit: vi.fn<(prRef: string) => Promise<void>>(
        () =>
          new Promise<void>((res) => {
            resolve = res;
          }),
      ),
    });
    await user.type(screen.getByLabelText('Pull request'), 'o/r#1');
    await user.click(screen.getByRole('button', { name: 'Start tracking' }));
    expect(screen.getByRole('button', { name: 'Starting...' })).toBeDisabled();
    resolve();
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
  });

  it('closes on backdrop click but not on clicks inside the dialog', async () => {
    const user = userEvent.setup();
    const { container, props } = renderDialog();
    await user.click(screen.getByRole('dialog', { name: 'Track a PR' }));
    expect(props.onClose).not.toHaveBeenCalled();
    await user.click(container.querySelector('.dialog-backdrop') as Element);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Cancel', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
