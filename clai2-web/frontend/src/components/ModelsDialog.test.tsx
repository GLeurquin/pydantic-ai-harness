import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import type { RedactedProfile } from '../api/types';
import { ModelsDialog } from './ModelsDialog';

function makeProfile(overrides: Partial<RedactedProfile> = {}): RedactedProfile {
  return {
    id: 'p1',
    label: 'Claude Sonnet',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    hasApiKey: true,
    projectId: null,
    region: null,
    hasCredentials: false,
    extraEnv: [],
    ...overrides,
  };
}

function renderDialog(props: Partial<Parameters<typeof ModelsDialog>[0]> = {}) {
  const defaults = {
    profiles: [] as RedactedProfile[],
    onCreate: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn<(profileId: string) => Promise<void>>().mockResolvedValue(undefined),
    onClose: vi.fn(),
  };
  const merged = { ...defaults, ...props };
  return { ...render(<ModelsDialog {...merged} />), props: merged };
}

describe('ModelsDialog', () => {
  it('lists the given profiles', () => {
    renderDialog({
      profiles: [makeProfile(), makeProfile({ id: 'p2', label: 'GPT', provider: 'openai', model: 'gpt-6' })],
    });
    expect(screen.getByText('Claude Sonnet')).toBeInTheDocument();
    expect(screen.getByText('Anthropic · claude-sonnet-4-6')).toBeInTheDocument();
    expect(screen.getByText('GPT')).toBeInTheDocument();
    expect(screen.getByText('OpenAI · gpt-6')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2);
  });

  it('shows the empty state with no profiles', () => {
    renderDialog();
    expect(screen.getByText('No profiles yet.')).toBeInTheDocument();
  });

  it('creates a profile through onCreate and returns to the list', async () => {
    const user = userEvent.setup();
    const created = makeProfile({ id: 'new1', label: 'New Sonnet' });
    const onCreate = vi.fn().mockResolvedValue(created);
    renderDialog({ onCreate });
    await user.click(screen.getByRole('button', { name: 'New profile' }));
    await user.type(screen.getByLabelText('Name'), 'New Sonnet');
    await user.type(screen.getByLabelText('Model'), 'claude-sonnet-4-6');
    await user.click(screen.getByRole('button', { name: 'Add profile' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith({
      label: 'New Sonnet',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      extraEnv: [],
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'New profile' })).toBeInTheDocument());
  });

  it('edits a profile through onUpdate', async () => {
    const user = userEvent.setup();
    const other = makeProfile({ id: 'p2', label: 'GPT', provider: 'openai', model: 'gpt-6' });
    const updated = makeProfile({ label: 'Renamed' });
    const onUpdate = vi.fn().mockResolvedValue(updated);
    renderDialog({ profiles: [makeProfile(), other], onUpdate });
    const [firstEdit] = screen.getAllByRole('button', { name: 'Edit' });
    await user.click(firstEdit!);
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate).toHaveBeenCalledWith('p1', {
      label: 'Renamed',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      extraEnv: [],
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'New profile' })).toBeInTheDocument());
  });

  it('deletes a profile through onDelete', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn<(profileId: string) => Promise<void>>().mockResolvedValue(undefined);
    renderDialog({ profiles: [makeProfile()], onDelete });
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('p1'));
  });

  it('shows the delete error when onDelete rejects', async () => {
    const user = userEvent.setup();
    renderDialog({ profiles: [makeProfile()], onDelete: vi.fn().mockRejectedValue(new Error('model in use')) });
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('model in use')).toHaveClass('form-error');
    expect(screen.getByText('Claude Sonnet')).toBeInTheDocument();
  });

  it('stringifies a non-Error delete failure', async () => {
    const user = userEvent.setup();
    renderDialog({ profiles: [makeProfile()], onDelete: vi.fn().mockRejectedValue('conflict') });
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('conflict')).toHaveClass('form-error');
  });

  it('returns to the list when the form is cancelled', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'New profile' }));
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.getByRole('button', { name: 'New profile' })).toBeInTheDocument();
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
    await user.click(screen.getByRole('dialog', { name: 'Model profiles' }));
    expect(props.onClose).not.toHaveBeenCalled();
    const backdrop = container.querySelector('.dialog-backdrop');
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as Element);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
