import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import type { FolderSummary } from '../api/types';
import { FoldersDialog } from './FoldersDialog';

const folders: FolderSummary[] = [
  { id: 'f1', name: 'Q3 launch' },
  { id: 'f2', name: 'On hold' },
];

function renderDialog(props: Partial<Parameters<typeof FoldersDialog>[0]> = {}) {
  const defaults = {
    folders,
    onCreateFolder: vi.fn<(name: string) => Promise<FolderSummary>>(),
    onDeleteFolder: vi.fn<(folderId: string) => Promise<void>>().mockResolvedValue(undefined),
    onClose: vi.fn(),
  };
  const merged = { ...defaults, ...props };
  return { ...render(<FoldersDialog {...merged} />), props: merged };
}

describe('FoldersDialog', () => {
  it('lists every folder', () => {
    renderDialog();
    expect(screen.getByText('Q3 launch')).toBeInTheDocument();
    expect(screen.getByText('On hold')).toBeInTheDocument();
  });

  it('shows the empty state with no folders', () => {
    renderDialog({ folders: [] });
    expect(screen.getByText('No folders yet.')).toBeInTheDocument();
  });

  it('fires onClose from the Close button and on a backdrop click but not inside', async () => {
    const user = userEvent.setup();
    const { props, container } = renderDialog();
    await user.click(screen.getByRole('dialog', { name: 'Folders' }));
    expect(props.onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    const backdrop = container.querySelector('.dialog-backdrop');
    await user.click(backdrop as Element);
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('adds a folder and returns to the list', async () => {
    const user = userEvent.setup();
    const created: FolderSummary = { id: 'f3', name: 'fresh' };
    const onCreateFolder = vi.fn<(name: string) => Promise<FolderSummary>>().mockResolvedValue(created);
    renderDialog({ onCreateFolder });
    await user.click(screen.getByRole('button', { name: 'New folder' }));
    await user.type(screen.getByPlaceholderText('Q3 launch'), 'fresh');
    await user.click(screen.getByRole('button', { name: 'Add folder' }));
    expect(onCreateFolder).toHaveBeenCalledWith('fresh');
    expect(await screen.findByRole('button', { name: 'New folder' })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Q3 launch')).toBeNull();
  });

  it('validates the add form before creating', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'New folder' }));
    await user.click(screen.getByRole('button', { name: 'Add folder' }));
    expect(screen.getByText('Give the folder a name.')).toHaveClass('form-error');
    expect(props.onCreateFolder).not.toHaveBeenCalled();
  });

  it('shows the create error and keeps the form open when onCreateFolder rejects', async () => {
    const user = userEvent.setup();
    renderDialog({ onCreateFolder: vi.fn().mockRejectedValue(new Error('bad name')) });
    await user.click(screen.getByRole('button', { name: 'New folder' }));
    await user.type(screen.getByPlaceholderText('Q3 launch'), 'fresh');
    await user.click(screen.getByRole('button', { name: 'Add folder' }));
    expect(await screen.findByText('bad name')).toHaveClass('form-error');
    expect(screen.getByPlaceholderText('Q3 launch')).toBeInTheDocument();
  });

  it('stringifies a non-Error create failure', async () => {
    const user = userEvent.setup();
    renderDialog({ onCreateFolder: vi.fn().mockRejectedValue('rejected') });
    await user.click(screen.getByRole('button', { name: 'New folder' }));
    await user.type(screen.getByPlaceholderText('Q3 launch'), 'fresh');
    await user.click(screen.getByRole('button', { name: 'Add folder' }));
    expect(await screen.findByText('rejected')).toHaveClass('form-error');
  });

  it('cancels the add form, clearing any prior error', async () => {
    const user = userEvent.setup();
    renderDialog({ onCreateFolder: vi.fn().mockRejectedValue(new Error('bad name')) });
    await user.click(screen.getByRole('button', { name: 'New folder' }));
    await user.click(screen.getByRole('button', { name: 'Add folder' }));
    expect(screen.getByText('Give the folder a name.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('Q3 launch')).toBeNull();
    expect(screen.queryByText('Give the folder a name.')).toBeNull();
  });

  it('removes a folder', async () => {
    const user = userEvent.setup();
    const onDeleteFolder = vi.fn<(folderId: string) => Promise<void>>().mockResolvedValue(undefined);
    renderDialog({ onDeleteFolder });
    const [firstRemove] = screen.getAllByRole('button', { name: 'Remove' });
    await user.click(firstRemove!);
    expect(onDeleteFolder).toHaveBeenCalledWith('f1');
  });

  it('shows the delete error when onDeleteFolder rejects', async () => {
    const user = userEvent.setup();
    renderDialog({ onDeleteFolder: vi.fn().mockRejectedValue(new Error('cannot delete')) });
    const [firstRemove] = screen.getAllByRole('button', { name: 'Remove' });
    await user.click(firstRemove!);
    expect(await screen.findByText('cannot delete')).toHaveClass('form-error');
  });

  it('stringifies a non-Error delete failure', async () => {
    const user = userEvent.setup();
    renderDialog({ onDeleteFolder: vi.fn().mockRejectedValue('conflict') });
    const [firstRemove] = screen.getAllByRole('button', { name: 'Remove' });
    await user.click(firstRemove!);
    expect(await screen.findByText('conflict')).toHaveClass('form-error');
  });

  it('shows a busy label on the folder being removed', async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const gate = new Promise<void>((res) => {
      resolve = res;
    });
    renderDialog({ onDeleteFolder: vi.fn(() => gate) });
    const [firstRemove] = screen.getAllByRole('button', { name: 'Remove' });
    await user.click(firstRemove!);
    expect(await screen.findByRole('button', { name: 'Removing...' })).toBeDisabled();
    resolve();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Removing...' })).toBeNull());
  });
});
