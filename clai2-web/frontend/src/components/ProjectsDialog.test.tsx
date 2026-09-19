import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import type { ProjectSummary } from '../api/types';
import { ProjectsDialog } from './ProjectsDialog';

const projects: ProjectSummary[] = [
  { id: 'p1', name: 'clai', repoRoot: '/repo' },
  { id: 'p2', name: 'other-repo', repoRoot: '/other' },
];

function renderDialog(props: Partial<Parameters<typeof ProjectsDialog>[0]> = {}) {
  const defaults = {
    projects,
    onCreateProject: vi.fn<(name: string, path: string) => Promise<ProjectSummary>>(),
    onDeleteProject: vi.fn<(projectId: string) => Promise<void>>().mockResolvedValue(undefined),
    onClose: vi.fn(),
  };
  const merged = { ...defaults, ...props };
  return { ...render(<ProjectsDialog {...merged} />), props: merged };
}

describe('ProjectsDialog', () => {
  it('lists every project with its repo root', () => {
    renderDialog();
    expect(screen.getByText('clai')).toBeInTheDocument();
    expect(screen.getByText('/repo')).toBeInTheDocument();
    expect(screen.getByText('other-repo')).toBeInTheDocument();
    expect(screen.getByText('/other')).toBeInTheDocument();
  });

  it('shows the empty state with no projects', () => {
    renderDialog({ projects: [] });
    expect(screen.getByText('No projects yet.')).toBeInTheDocument();
  });

  it('fires onClose from the Close button and on a backdrop click but not inside', async () => {
    const user = userEvent.setup();
    const { props, container } = renderDialog();
    await user.click(screen.getByRole('dialog', { name: 'Projects' }));
    expect(props.onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    const backdrop = container.querySelector('.dialog-backdrop');
    await user.click(backdrop as Element);
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('adds a project and returns to the list', async () => {
    const user = userEvent.setup();
    const created: ProjectSummary = { id: 'p3', name: 'fresh', repoRoot: '/fresh' };
    const onCreateProject = vi.fn<(name: string, path: string) => Promise<ProjectSummary>>().mockResolvedValue(created);
    renderDialog({ onCreateProject });
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.type(screen.getByPlaceholderText('my-other-repo'), 'fresh');
    await user.type(screen.getByPlaceholderText('/Users/you/code/my-other-repo'), '/fresh');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    expect(onCreateProject).toHaveBeenCalledWith('fresh', '/fresh');
    expect(await screen.findByRole('button', { name: 'New project' })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('my-other-repo')).toBeNull();
  });

  it('validates the add form before creating', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    expect(screen.getByText('Give the project a name and an absolute path.')).toHaveClass('form-error');
    expect(props.onCreateProject).not.toHaveBeenCalled();
  });

  it('shows the create error and keeps the form open when onCreateProject rejects', async () => {
    const user = userEvent.setup();
    renderDialog({ onCreateProject: vi.fn().mockRejectedValue(new Error('bad path')) });
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.type(screen.getByPlaceholderText('my-other-repo'), 'fresh');
    await user.type(screen.getByPlaceholderText('/Users/you/code/my-other-repo'), '/fresh');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    expect(await screen.findByText('bad path')).toHaveClass('form-error');
    expect(screen.getByPlaceholderText('my-other-repo')).toBeInTheDocument();
  });

  it('stringifies a non-Error create failure', async () => {
    const user = userEvent.setup();
    renderDialog({ onCreateProject: vi.fn().mockRejectedValue('rejected') });
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.type(screen.getByPlaceholderText('my-other-repo'), 'fresh');
    await user.type(screen.getByPlaceholderText('/Users/you/code/my-other-repo'), '/fresh');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    expect(await screen.findByText('rejected')).toHaveClass('form-error');
  });

  it('cancels the add form, clearing any prior error', async () => {
    const user = userEvent.setup();
    renderDialog({ onCreateProject: vi.fn().mockRejectedValue(new Error('bad path')) });
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    expect(screen.getByText('Give the project a name and an absolute path.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('my-other-repo')).toBeNull();
    expect(screen.queryByText('Give the project a name and an absolute path.')).toBeNull();
  });

  it('removes a project', async () => {
    const user = userEvent.setup();
    const onDeleteProject = vi.fn<(projectId: string) => Promise<void>>().mockResolvedValue(undefined);
    renderDialog({ onDeleteProject });
    const [firstRemove] = screen.getAllByRole('button', { name: 'Remove' });
    await user.click(firstRemove!);
    expect(onDeleteProject).toHaveBeenCalledWith('p1');
  });

  it('shows the delete error when onDeleteProject rejects', async () => {
    const user = userEvent.setup();
    renderDialog({ onDeleteProject: vi.fn().mockRejectedValue(new Error('project in use')) });
    const [firstRemove] = screen.getAllByRole('button', { name: 'Remove' });
    await user.click(firstRemove!);
    expect(await screen.findByText('project in use')).toHaveClass('form-error');
  });

  it('stringifies a non-Error delete failure', async () => {
    const user = userEvent.setup();
    renderDialog({ onDeleteProject: vi.fn().mockRejectedValue('conflict') });
    const [firstRemove] = screen.getAllByRole('button', { name: 'Remove' });
    await user.click(firstRemove!);
    expect(await screen.findByText('conflict')).toHaveClass('form-error');
  });

  it('shows a busy label on the project being removed', async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const gate = new Promise<void>((res) => {
      resolve = res;
    });
    renderDialog({ onDeleteProject: vi.fn(() => gate) });
    const [firstRemove] = screen.getAllByRole('button', { name: 'Remove' });
    await user.click(firstRemove!);
    expect(await screen.findByRole('button', { name: 'Removing...' })).toBeDisabled();
    resolve();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Removing...' })).toBeNull());
  });
});
