import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, vi } from 'vitest';

import { api } from '../api/client';
import { GithubSettingsDialog } from './GithubSettingsDialog';

vi.mock('../api/client', () => ({
  api: {
    githubSettings: vi.fn(),
    setGithubToken: vi.fn(),
    clearGithubToken: vi.fn(),
    setGithubPollInterval: vi.fn(),
  },
}));

const githubSettings = vi.mocked(api.githubSettings);
const setGithubToken = vi.mocked(api.setGithubToken);
const clearGithubToken = vi.mocked(api.clearGithubToken);
const setGithubPollInterval = vi.mocked(api.setGithubPollInterval);

beforeEach(() => {
  vi.clearAllMocks();
  githubSettings.mockResolvedValue({ hasToken: false, pollIntervalSecs: 300 });
});

describe('GithubSettingsDialog', () => {
  it('loads the current settings and shows the poll interval in minutes', async () => {
    githubSettings.mockResolvedValue({ hasToken: false, pollIntervalSecs: 150 });
    render(<GithubSettingsDialog onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Poll interval (minutes)')).toHaveValue(2.5));
    expect(screen.getByLabelText('Personal access token')).toHaveAttribute('placeholder', 'ghp_...');
    expect(screen.queryByRole('button', { name: 'Clear token' })).toBeNull();
  });

  it('shows an unchanged placeholder and a Clear token button when a token is already set', async () => {
    githubSettings.mockResolvedValue({ hasToken: true, pollIntervalSecs: 300 });
    render(<GithubSettingsDialog onClose={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Clear token' })).toBeInTheDocument();
    expect(screen.getByLabelText('Personal access token')).toHaveAttribute('placeholder', 'unchanged');
  });

  it('shows the load error when githubSettings rejects', async () => {
    githubSettings.mockRejectedValue(new Error('server down'));
    render(<GithubSettingsDialog onClose={vi.fn()} />);
    expect(await screen.findByText('server down')).toHaveClass('form-error');
  });

  it('stringifies a non-Error load failure', async () => {
    githubSettings.mockRejectedValue('nope');
    render(<GithubSettingsDialog onClose={vi.fn()} />);
    expect(await screen.findByText('nope')).toHaveClass('form-error');
  });

  it('requires a token before saving', async () => {
    const user = userEvent.setup();
    render(<GithubSettingsDialog onClose={vi.fn()} />);
    await screen.findByLabelText('Personal access token');
    await user.click(screen.getByRole('button', { name: 'Save token' }));
    expect(screen.getByText('Enter a token.')).toHaveClass('form-error');
    expect(setGithubToken).not.toHaveBeenCalled();
  });

  it('saves a trimmed token, clears the draft, and notifies onChanged', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    setGithubToken.mockResolvedValue({ hasToken: true, pollIntervalSecs: 300 });
    render(<GithubSettingsDialog onClose={vi.fn()} onChanged={onChanged} />);
    await user.type(await screen.findByLabelText('Personal access token'), '  ghp_secret  ');
    await user.click(screen.getByRole('button', { name: 'Save token' }));
    expect(setGithubToken).toHaveBeenCalledWith('ghp_secret');
    await waitFor(() => expect(screen.getByLabelText('Personal access token')).toHaveValue(''));
    expect(onChanged).toHaveBeenCalledWith({ hasToken: true, pollIntervalSecs: 300 });
    expect(await screen.findByRole('button', { name: 'Clear token' })).toBeInTheDocument();
  });

  it('shows the busy label while saving a token', async () => {
    const user = userEvent.setup();
    let resolve!: (value: { hasToken: boolean; pollIntervalSecs: number }) => void;
    setGithubToken.mockImplementation(
      () =>
        new Promise((res) => {
          resolve = res;
        }),
    );
    render(<GithubSettingsDialog onClose={vi.fn()} />);
    await user.type(await screen.findByLabelText('Personal access token'), 'ghp_secret');
    await user.click(screen.getByRole('button', { name: 'Save token' }));
    expect(screen.getByRole('button', { name: 'Save token' })).toBeDisabled();
    resolve({ hasToken: true, pollIntervalSecs: 300 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save token' })).toBeEnabled());
  });

  it('shows an error and keeps the draft when saving a token fails', async () => {
    const user = userEvent.setup();
    setGithubToken.mockRejectedValue(new Error('bad token'));
    render(<GithubSettingsDialog onClose={vi.fn()} />);
    await user.type(await screen.findByLabelText('Personal access token'), 'ghp_bad');
    await user.click(screen.getByRole('button', { name: 'Save token' }));
    expect(await screen.findByText('bad token')).toHaveClass('form-error');
    expect(screen.getByLabelText('Personal access token')).toHaveValue('ghp_bad');
  });

  it('clears the token and notifies onChanged', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    githubSettings.mockResolvedValue({ hasToken: true, pollIntervalSecs: 300 });
    clearGithubToken.mockResolvedValue({ hasToken: false, pollIntervalSecs: 300 });
    render(<GithubSettingsDialog onClose={vi.fn()} onChanged={onChanged} />);
    await user.click(await screen.findByRole('button', { name: 'Clear token' }));
    await waitFor(() => expect(clearGithubToken).toHaveBeenCalledTimes(1));
    expect(onChanged).toHaveBeenCalledWith({ hasToken: false, pollIntervalSecs: 300 });
    expect(screen.queryByRole('button', { name: 'Clear token' })).toBeNull();
  });

  it('shows an error when clearing the token fails', async () => {
    const user = userEvent.setup();
    githubSettings.mockResolvedValue({ hasToken: true, pollIntervalSecs: 300 });
    clearGithubToken.mockRejectedValue(new Error('cannot clear'));
    render(<GithubSettingsDialog onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Clear token' }));
    expect(await screen.findByText('cannot clear')).toHaveClass('form-error');
  });

  it('rejects a non-positive poll interval without calling the API', async () => {
    const user = userEvent.setup();
    render(<GithubSettingsDialog onClose={vi.fn()} />);
    const field = await screen.findByLabelText('Poll interval (minutes)');
    await user.clear(field);
    await user.type(field, '0');
    await user.click(screen.getByRole('button', { name: 'Save interval' }));
    expect(screen.getByText('Poll interval must be a positive number of minutes.')).toHaveClass('form-error');
    expect(setGithubPollInterval).not.toHaveBeenCalled();
  });

  it('rejects a blank poll interval without calling the API', async () => {
    const user = userEvent.setup();
    render(<GithubSettingsDialog onClose={vi.fn()} />);
    const field = await screen.findByLabelText('Poll interval (minutes)');
    await user.clear(field);
    await user.click(screen.getByRole('button', { name: 'Save interval' }));
    expect(screen.getByText('Poll interval must be a positive number of minutes.')).toHaveClass('form-error');
    expect(setGithubPollInterval).not.toHaveBeenCalled();
  });

  it('saves the poll interval converted from minutes to seconds', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    setGithubPollInterval.mockResolvedValue({ hasToken: false, pollIntervalSecs: 150 });
    render(<GithubSettingsDialog onClose={vi.fn()} onChanged={onChanged} />);
    const field = await screen.findByLabelText('Poll interval (minutes)');
    await user.clear(field);
    await user.type(field, '2.5');
    await user.click(screen.getByRole('button', { name: 'Save interval' }));
    expect(setGithubPollInterval).toHaveBeenCalledWith(150);
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ hasToken: false, pollIntervalSecs: 150 }));
  });

  it('shows an error when saving the poll interval fails', async () => {
    const user = userEvent.setup();
    setGithubPollInterval.mockRejectedValue(new Error('interval too small'));
    render(<GithubSettingsDialog onClose={vi.fn()} />);
    const field = await screen.findByLabelText('Poll interval (minutes)');
    await user.clear(field);
    await user.type(field, '1');
    await user.click(screen.getByRole('button', { name: 'Save interval' }));
    expect(await screen.findByText('interval too small')).toHaveClass('form-error');
  });

  it('fires onClose from the Close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<GithubSettingsDialog onClose={onClose} />);
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop click but not on a click inside the dialog', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(<GithubSettingsDialog onClose={onClose} />);
    await user.click(screen.getByRole('dialog', { name: 'GitHub settings' }));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(container.querySelector('.dialog-backdrop') as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('lets onChanged be optional', async () => {
    const user = userEvent.setup();
    setGithubPollInterval.mockResolvedValue({ hasToken: false, pollIntervalSecs: 60 });
    render(<GithubSettingsDialog onClose={vi.fn()} />);
    const field = await screen.findByLabelText('Poll interval (minutes)');
    await user.clear(field);
    await user.type(field, '1');
    await user.click(screen.getByRole('button', { name: 'Save interval' }));
    await waitFor(() => expect(setGithubPollInterval).toHaveBeenCalledWith(60));
  });
});
