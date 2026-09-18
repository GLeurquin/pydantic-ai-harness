import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { NameDialog } from './NameDialog';

function renderDialog(overrides: Partial<Parameters<typeof NameDialog>[0]> = {}) {
  const props = {
    title: 'Fork Alpha',
    placeholder: 'Alpha fork',
    submitLabel: 'Fork agent',
    onSubmit: vi.fn<(name: string) => Promise<void>>().mockResolvedValue(undefined),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<NameDialog {...props} />), props };
}

describe('NameDialog', () => {
  it('shows the title, placeholder, and submit label', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Fork Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Fork Alpha' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Alpha fork')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fork agent' })).toBeInTheDocument();
  });

  it('requires a name', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Fork agent' }));
    expect(screen.getByText('A name is required.')).toHaveClass('form-error');
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('submits the trimmed name and closes', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.type(screen.getByPlaceholderText('Alpha fork'), '  branch two  ');
    await user.click(screen.getByRole('button', { name: 'Fork agent' }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).toHaveBeenCalledWith('branch two');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the error and stays open when onSubmit rejects', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog({
      onSubmit: vi.fn<(name: string) => Promise<void>>().mockRejectedValue(new Error('fork failed')),
    });
    await user.type(screen.getByPlaceholderText('Alpha fork'), 'x');
    await user.click(screen.getByRole('button', { name: 'Fork agent' }));
    expect(await screen.findByText('fork failed')).toHaveClass('form-error');
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Fork agent' })).toBeEnabled();
  });

  it('stringifies non-Error failures', async () => {
    const user = userEvent.setup();
    renderDialog({ onSubmit: vi.fn<(name: string) => Promise<void>>().mockRejectedValue('plain failure') });
    await user.type(screen.getByPlaceholderText('Alpha fork'), 'x');
    await user.click(screen.getByRole('button', { name: 'Fork agent' }));
    expect(await screen.findByText('plain failure')).toBeInTheDocument();
  });

  it('shows the busy label while submitting', async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const { props } = renderDialog({
      onSubmit: vi.fn<(name: string) => Promise<void>>(
        () =>
          new Promise<void>((res) => {
            resolve = res;
          }),
      ),
    });
    await user.type(screen.getByPlaceholderText('Alpha fork'), 'x');
    await user.click(screen.getByRole('button', { name: 'Fork agent' }));
    expect(screen.getByRole('button', { name: 'Working...' })).toBeDisabled();
    resolve();
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
  });

  it('closes on backdrop click but not on clicks inside the dialog', async () => {
    const user = userEvent.setup();
    const { container, props } = renderDialog();
    await user.click(screen.getByRole('dialog', { name: 'Fork Alpha' }));
    expect(props.onClose).not.toHaveBeenCalled();
    await user.click(container.querySelector('.dialog-backdrop') as Element);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
