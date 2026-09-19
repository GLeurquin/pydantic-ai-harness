import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { GoalDialog } from './GoalDialog';

function renderDialog(overrides: Partial<Parameters<typeof GoalDialog>[0]> = {}) {
  const props = {
    agentName: 'fix-auth-bug',
    onSubmit: vi.fn<(goal: string, maxTurns: number) => Promise<void>>().mockResolvedValue(undefined),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<GoalDialog {...props} />), props };
}

describe('GoalDialog', () => {
  it('shows the dialog and mentions the agent by name', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Set a goal' })).toBeInTheDocument();
    expect(screen.getByText(/fix-auth-bug will keep working/)).toBeInTheDocument();
  });

  it('defaults max turns to 10', () => {
    renderDialog();
    expect(screen.getByLabelText('Max turns')).toHaveValue(10);
  });

  it('requires a goal', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Start working toward it' }));
    expect(screen.getByText('Describe what the agent should accomplish.')).toHaveClass('form-error');
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('rejects a max turns below 1', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.type(screen.getByPlaceholderText('Fix the failing auth tests and open a PR'), 'do the thing');
    await user.clear(screen.getByLabelText('Max turns'));
    await user.type(screen.getByLabelText('Max turns'), '0');
    await user.click(screen.getByRole('button', { name: 'Start working toward it' }));
    expect(screen.getByText('Max turns must be a whole number of at least 1.')).toHaveClass('form-error');
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('rejects a non-integer max turns', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.type(screen.getByPlaceholderText('Fix the failing auth tests and open a PR'), 'do the thing');
    await user.clear(screen.getByLabelText('Max turns'));
    await user.type(screen.getByLabelText('Max turns'), '2.5');
    await user.click(screen.getByRole('button', { name: 'Start working toward it' }));
    expect(screen.getByText('Max turns must be a whole number of at least 1.')).toHaveClass('form-error');
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('submits the trimmed goal and parsed max turns, then closes', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.type(screen.getByPlaceholderText('Fix the failing auth tests and open a PR'), '  ship the feature  ');
    await user.clear(screen.getByLabelText('Max turns'));
    await user.type(screen.getByLabelText('Max turns'), '7');
    await user.click(screen.getByRole('button', { name: 'Start working toward it' }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).toHaveBeenCalledWith('ship the feature', 7);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the error and stays open when onSubmit rejects', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog({
      onSubmit: vi.fn<(goal: string, maxTurns: number) => Promise<void>>().mockRejectedValue(new Error('cap reached')),
    });
    await user.type(screen.getByPlaceholderText('Fix the failing auth tests and open a PR'), 'do it');
    await user.click(screen.getByRole('button', { name: 'Start working toward it' }));
    expect(await screen.findByText('cap reached')).toHaveClass('form-error');
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start working toward it' })).toBeEnabled();
  });

  it('shows the busy label while submitting', async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const { props } = renderDialog({
      onSubmit: vi.fn<(goal: string, maxTurns: number) => Promise<void>>(
        () =>
          new Promise<void>((res) => {
            resolve = res;
          }),
      ),
    });
    await user.type(screen.getByPlaceholderText('Fix the failing auth tests and open a PR'), 'do it');
    await user.click(screen.getByRole('button', { name: 'Start working toward it' }));
    expect(screen.getByRole('button', { name: 'Starting...' })).toBeDisabled();
    resolve();
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
  });

  it('closes on backdrop click but not on clicks inside the dialog', async () => {
    const user = userEvent.setup();
    const { container, props } = renderDialog();
    await user.click(screen.getByRole('dialog', { name: 'Set a goal' }));
    expect(props.onClose).not.toHaveBeenCalled();
    await user.click(container.querySelector('.dialog-backdrop') as Element);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
