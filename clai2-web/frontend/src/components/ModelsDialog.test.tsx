import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, vi } from 'vitest';

import { api } from '../api/client';
import type { RedactedProfile } from '../api/types';
import { ModelsDialog } from './ModelsDialog';

vi.mock('../api/client', () => ({
  api: {
    listModels: vi.fn(),
    createModel: vi.fn(),
    updateModel: vi.fn(),
    deleteModel: vi.fn(),
  },
}));

const listModels = vi.mocked(api.listModels);
const createModel = vi.mocked(api.createModel);
const updateModel = vi.mocked(api.updateModel);
const deleteModel = vi.mocked(api.deleteModel);

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

beforeEach(() => {
  vi.clearAllMocks();
  listModels.mockResolvedValue([]);
});

describe('ModelsDialog', () => {
  it('lists the profiles returned by listModels', async () => {
    listModels.mockResolvedValue([
      makeProfile(),
      makeProfile({ id: 'p2', label: 'GPT', provider: 'openai', model: 'gpt-6' }),
    ]);
    render(<ModelsDialog onClose={vi.fn()} />);
    expect(await screen.findByText('Claude Sonnet')).toBeInTheDocument();
    expect(screen.getByText('Anthropic · claude-sonnet-4-6')).toBeInTheDocument();
    expect(screen.getByText('GPT')).toBeInTheDocument();
    expect(screen.getByText('OpenAI · gpt-6')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2);
  });

  it('shows the empty state once loaded with no profiles', async () => {
    render(<ModelsDialog onClose={vi.fn()} />);
    expect(await screen.findByText('No profiles yet.')).toBeInTheDocument();
  });

  it('shows the load error when listModels rejects', async () => {
    listModels.mockRejectedValue(new Error('server down'));
    render(<ModelsDialog onClose={vi.fn()} />);
    expect(await screen.findByText('server down')).toHaveClass('form-error');
  });

  it('stringifies a non-Error load failure', async () => {
    listModels.mockRejectedValue('nope');
    render(<ModelsDialog onClose={vi.fn()} />);
    expect(await screen.findByText('nope')).toHaveClass('form-error');
  });

  it('creates a profile, appends it to the list, and notifies onChanged', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const created = makeProfile({ id: 'new1', label: 'New Sonnet' });
    createModel.mockResolvedValue(created);
    render(<ModelsDialog onClose={vi.fn()} onChanged={onChanged} />);
    await screen.findByText('No profiles yet.');
    await user.click(screen.getByRole('button', { name: 'New profile' }));
    await user.type(screen.getByLabelText('Name'), 'New Sonnet');
    await user.type(screen.getByLabelText('Model'), 'claude-sonnet-4-6');
    await user.click(screen.getByRole('button', { name: 'Add profile' }));
    await waitFor(() => expect(createModel).toHaveBeenCalledTimes(1));
    expect(createModel).toHaveBeenCalledWith({
      label: 'New Sonnet',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      extraEnv: [],
    });
    expect(await screen.findByText('New Sonnet')).toBeInTheDocument();
    expect(onChanged).toHaveBeenLastCalledWith([created]);
  });

  it('edits a profile through updateModel and replaces only its row', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const other = makeProfile({ id: 'p2', label: 'GPT', provider: 'openai', model: 'gpt-6' });
    listModels.mockResolvedValue([makeProfile(), other]);
    const updated = makeProfile({ label: 'Renamed' });
    updateModel.mockResolvedValue(updated);
    render(<ModelsDialog onClose={vi.fn()} onChanged={onChanged} />);
    const [firstEdit] = await screen.findAllByRole('button', { name: 'Edit' });
    await user.click(firstEdit!);
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateModel).toHaveBeenCalledTimes(1));
    expect(updateModel).toHaveBeenCalledWith('p1', {
      label: 'Renamed',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      extraEnv: [],
    });
    expect(await screen.findByText('Renamed')).toBeInTheDocument();
    expect(onChanged).toHaveBeenLastCalledWith([updated, other]);
  });

  it('deletes a profile and removes its row', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    listModels.mockResolvedValue([makeProfile()]);
    deleteModel.mockResolvedValue({ ok: true });
    render(<ModelsDialog onClose={vi.fn()} onChanged={onChanged} />);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteModel).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(screen.queryByText('Claude Sonnet')).toBeNull());
    expect(onChanged).toHaveBeenLastCalledWith([]);
  });

  it('shows the delete error when deleteModel rejects', async () => {
    const user = userEvent.setup();
    listModels.mockResolvedValue([makeProfile()]);
    deleteModel.mockRejectedValue(new Error('model in use'));
    render(<ModelsDialog onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('model in use')).toHaveClass('form-error');
    expect(screen.getByText('Claude Sonnet')).toBeInTheDocument();
  });

  it('stringifies a non-Error delete failure', async () => {
    const user = userEvent.setup();
    listModels.mockResolvedValue([makeProfile()]);
    deleteModel.mockRejectedValue('conflict');
    render(<ModelsDialog onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('conflict')).toHaveClass('form-error');
  });

  it('returns to the list when the form is cancelled', async () => {
    const user = userEvent.setup();
    render(<ModelsDialog onClose={vi.fn()} />);
    await screen.findByText('No profiles yet.');
    await user.click(screen.getByRole('button', { name: 'New profile' }));
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.getByRole('button', { name: 'New profile' })).toBeInTheDocument();
  });

  it('fires onClose from the Close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ModelsDialog onClose={onClose} />);
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop click but not on a click inside the dialog', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(<ModelsDialog onClose={onClose} />);
    await user.click(screen.getByRole('dialog', { name: 'Model profiles' }));
    expect(onClose).not.toHaveBeenCalled();
    const backdrop = container.querySelector('.dialog-backdrop');
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('lets onChanged be optional', async () => {
    const user = userEvent.setup();
    listModels.mockResolvedValue([makeProfile()]);
    deleteModel.mockResolvedValue({ ok: true });
    render(<ModelsDialog onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('Claude Sonnet')).toBeNull());
  });
});
