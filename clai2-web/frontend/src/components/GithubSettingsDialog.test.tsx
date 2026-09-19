import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import type { RedactedGithubSettings } from '../api/types';
import { GithubSettingsDialog } from './GithubSettingsDialog';

function renderDialog(props: Partial<Parameters<typeof GithubSettingsDialog>[0]> = {}) {
  const defaults = {
    settings: { hasToken: false, pollIntervalSecs: 300 } as RedactedGithubSettings,
    onSaveToken: vi.fn<(token: string) => Promise<void>>().mockResolvedValue(undefined),
    onClearToken: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onSavePollInterval: vi.fn<(pollIntervalSecs: number) => Promise<void>>().mockResolvedValue(undefined),
    onClose: vi.fn(),
  };
  const merged = { ...defaults, ...props };
  return { ...render(<GithubSettingsDialog {...merged} />), props: merged };
}

describe('GithubSettingsDialog', () => {
  it('shows the poll interval in minutes, converted from the given seconds', () => {
    renderDialog({ settings: { hasToken: false, pollIntervalSecs: 150 } });
    expect(screen.getByLabelText('Poll interval (minutes)')).toHaveValue(2.5);
    expect(screen.getByLabelText('Personal access token')).toHaveAttribute('placeholder', 'ghp_...');
    expect(screen.queryByRole('button', { name: 'Clear token' })).toBeNull();
  });

  it('shows an unchanged placeholder and a Clear token button when a token is already set', () => {
    renderDialog({ settings: { hasToken: true, pollIntervalSecs: 300 } });
    expect(screen.getByRole('button', { name: 'Clear token' })).toBeInTheDocument();
    expect(screen.getByLabelText('Personal access token')).toHaveAttribute('placeholder', 'unchanged');
  });

  it('requires a token before saving', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Save token' }));
    expect(screen.getByText('Enter a token.')).toHaveClass('form-error');
    expect(props.onSaveToken).not.toHaveBeenCalled();
  });

  it('saves a trimmed token and clears the draft', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.type(screen.getByLabelText('Personal access token'), '  ghp_secret  ');
    await user.click(screen.getByRole('button', { name: 'Save token' }));
    expect(props.onSaveToken).toHaveBeenCalledWith('ghp_secret');
    await waitFor(() => expect(screen.getByLabelText('Personal access token')).toHaveValue(''));
  });

  it('shows the busy label while saving a token', async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const onSaveToken = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolve = res;
        }),
    );
    renderDialog({ onSaveToken });
    await user.type(screen.getByLabelText('Personal access token'), 'ghp_secret');
    await user.click(screen.getByRole('button', { name: 'Save token' }));
    expect(screen.getByRole('button', { name: 'Save token' })).toBeDisabled();
    resolve();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save token' })).toBeEnabled());
  });

  it('shows an error and keeps the draft when saving a token fails', async () => {
    const user = userEvent.setup();
    renderDialog({ onSaveToken: vi.fn().mockRejectedValue(new Error('bad token')) });
    await user.type(screen.getByLabelText('Personal access token'), 'ghp_bad');
    await user.click(screen.getByRole('button', { name: 'Save token' }));
    expect(await screen.findByText('bad token')).toHaveClass('form-error');
    expect(screen.getByLabelText('Personal access token')).toHaveValue('ghp_bad');
  });

  it('stringifies a non-Error save-token failure', async () => {
    const user = userEvent.setup();
    renderDialog({ onSaveToken: vi.fn().mockRejectedValue('nope') });
    await user.type(screen.getByLabelText('Personal access token'), 'ghp_bad');
    await user.click(screen.getByRole('button', { name: 'Save token' }));
    expect(await screen.findByText('nope')).toHaveClass('form-error');
  });

  it('clears the token through onClearToken', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog({ settings: { hasToken: true, pollIntervalSecs: 300 } });
    await user.click(screen.getByRole('button', { name: 'Clear token' }));
    await waitFor(() => expect(props.onClearToken).toHaveBeenCalledTimes(1));
  });

  it('shows an error when clearing the token fails', async () => {
    const user = userEvent.setup();
    renderDialog({
      settings: { hasToken: true, pollIntervalSecs: 300 },
      onClearToken: vi.fn().mockRejectedValue(new Error('cannot clear')),
    });
    await user.click(screen.getByRole('button', { name: 'Clear token' }));
    expect(await screen.findByText('cannot clear')).toHaveClass('form-error');
  });

  it('stringifies a non-Error clear-token failure', async () => {
    const user = userEvent.setup();
    renderDialog({
      settings: { hasToken: true, pollIntervalSecs: 300 },
      onClearToken: vi.fn().mockRejectedValue('nope'),
    });
    await user.click(screen.getByRole('button', { name: 'Clear token' }));
    expect(await screen.findByText('nope')).toHaveClass('form-error');
  });

  it('rejects a non-positive poll interval without calling onSavePollInterval', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    const field = screen.getByLabelText('Poll interval (minutes)');
    await user.clear(field);
    await user.type(field, '0');
    await user.click(screen.getByRole('button', { name: 'Save interval' }));
    expect(screen.getByText('Poll interval must be a positive number of minutes.')).toHaveClass('form-error');
    expect(props.onSavePollInterval).not.toHaveBeenCalled();
  });

  it('rejects a blank poll interval without calling onSavePollInterval', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    const field = screen.getByLabelText('Poll interval (minutes)');
    await user.clear(field);
    await user.click(screen.getByRole('button', { name: 'Save interval' }));
    expect(screen.getByText('Poll interval must be a positive number of minutes.')).toHaveClass('form-error');
    expect(props.onSavePollInterval).not.toHaveBeenCalled();
  });

  it('saves the poll interval converted from minutes to seconds', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    const field = screen.getByLabelText('Poll interval (minutes)');
    await user.clear(field);
    await user.type(field, '2.5');
    await user.click(screen.getByRole('button', { name: 'Save interval' }));
    expect(props.onSavePollInterval).toHaveBeenCalledWith(150);
  });

  it('shows an error when saving the poll interval fails', async () => {
    const user = userEvent.setup();
    renderDialog({ onSavePollInterval: vi.fn().mockRejectedValue(new Error('interval too small')) });
    const field = screen.getByLabelText('Poll interval (minutes)');
    await user.clear(field);
    await user.type(field, '1');
    await user.click(screen.getByRole('button', { name: 'Save interval' }));
    expect(await screen.findByText('interval too small')).toHaveClass('form-error');
  });

  it('stringifies a non-Error save-interval failure', async () => {
    const user = userEvent.setup();
    renderDialog({ onSavePollInterval: vi.fn().mockRejectedValue('nope') });
    const field = screen.getByLabelText('Poll interval (minutes)');
    await user.clear(field);
    await user.type(field, '1');
    await user.click(screen.getByRole('button', { name: 'Save interval' }));
    expect(await screen.findByText('nope')).toHaveClass('form-error');
  });

  it('fires onClose from the Close button', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop click but not on a click inside the dialog', async () => {
    const user = userEvent.setup();
    const { props, container } = renderDialog();
    await user.click(screen.getByRole('dialog', { name: 'GitHub settings' }));
    expect(props.onClose).not.toHaveBeenCalled();
    await user.click(container.querySelector('.dialog-backdrop') as Element);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
