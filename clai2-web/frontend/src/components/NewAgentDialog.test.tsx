import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import type { CreateAgentRequest, ProjectSummary } from '../api/types';
import { NewAgentDialog } from './NewAgentDialog';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const projects: ProjectSummary[] = [
  { id: 'p1', name: 'clai', repoRoot: '/repo' },
  { id: 'p2', name: 'other-repo', repoRoot: '/other' },
];

function renderDialog(props: Partial<Parameters<typeof NewAgentDialog>[0]> = {}) {
  const defaults = {
    projects,
    onCreate: vi.fn<(request: CreateAgentRequest) => Promise<void>>().mockResolvedValue(undefined),
    onCreateProject: vi.fn<(name: string, path: string) => Promise<ProjectSummary>>(),
    onClose: vi.fn(),
  };
  const merged = { ...defaults, ...props };
  return { ...render(<NewAgentDialog {...merged} />), props: merged };
}

describe('NewAgentDialog', () => {
  it('shows a validation error on an empty name without creating', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(screen.getByText('Give the agent a name.')).toHaveClass('form-error');
    expect(props.onCreate).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('defaults the project select to the first project', () => {
    renderDialog();
    expect(screen.getByLabelText('Project')).toHaveValue('p1');
  });

  it('preselects defaultProjectId when given', () => {
    renderDialog({ defaultProjectId: 'p2' });
    expect(screen.getByLabelText('Project')).toHaveValue('p2');
  });

  it('lists every project as an option', () => {
    renderDialog();
    const options = within(screen.getByLabelText('Project')).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['clai', 'other-repo']);
  });

  it('builds the request with a trimmed name, the chosen project, and base branch, then closes', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn<(request: CreateAgentRequest) => Promise<void>>().mockResolvedValue(undefined);
    const { props } = renderDialog({ onCreate });
    await user.type(screen.getByPlaceholderText('fix-auth-bug'), '  my agent  ');
    await user.selectOptions(screen.getByLabelText('Project'), 'p2');
    await user.type(screen.getByPlaceholderText('main'), '  develop  ');
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(onCreate.mock.calls).toStrictEqual([
      [{ name: 'my agent', projectId: 'p2', useWorktree: true, baseBranch: 'develop', approvalMode: 'always_ask' }],
    ]);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('omits baseBranch when it is blank', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn<(request: CreateAgentRequest) => Promise<void>>().mockResolvedValue(undefined);
    renderDialog({ onCreate });
    await user.type(screen.getByPlaceholderText('fix-auth-bug'), 'agent');
    await user.type(screen.getByPlaceholderText('main'), '   ');
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(onCreate.mock.calls).toStrictEqual([
      [{ name: 'agent', projectId: 'p1', useWorktree: true, approvalMode: 'always_ask' }],
    ]);
  });

  it('hides the base branch field and omits it when the worktree is unchecked', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn<(request: CreateAgentRequest) => Promise<void>>().mockResolvedValue(undefined);
    renderDialog({ onCreate });
    await user.type(screen.getByPlaceholderText('main'), 'develop');
    await user.click(screen.getByLabelText('Create an isolated worktree and branch'));
    expect(screen.queryByPlaceholderText('main')).toBeNull();
    await user.type(screen.getByPlaceholderText('fix-auth-bug'), 'agent');
    await user.selectOptions(screen.getByLabelText('Approval mode'), 'accept_edits');
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(onCreate.mock.calls).toStrictEqual([
      [{ name: 'agent', projectId: 'p1', useWorktree: false, approvalMode: 'accept_edits' }],
    ]);
  });

  it('rejects submission with no project available', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog({ projects: [] });
    await user.type(screen.getByPlaceholderText('fix-auth-bug'), 'agent');
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(screen.getByText('Choose or add a project.')).toHaveClass('form-error');
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it('shows the error and stays open when onCreate rejects', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog({
      onCreate: vi.fn<(request: CreateAgentRequest) => Promise<void>>().mockRejectedValue(new Error('too many agents')),
    });
    await user.type(screen.getByPlaceholderText('fix-auth-bug'), 'agent');
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(await screen.findByText('too many agents')).toHaveClass('form-error');
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start agent' })).toBeEnabled();
  });

  it('stringifies non-Error failures', async () => {
    const user = userEvent.setup();
    renderDialog({ onCreate: vi.fn<(request: CreateAgentRequest) => Promise<void>>().mockRejectedValue('plain refusal') });
    await user.type(screen.getByPlaceholderText('fix-auth-bug'), 'agent');
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(await screen.findByText('plain refusal')).toBeInTheDocument();
  });

  it('shows the busy label while creation is pending', async () => {
    const user = userEvent.setup();
    const gate = deferred<void>();
    const { props } = renderDialog({ onCreate: vi.fn<(request: CreateAgentRequest) => Promise<void>>(() => gate.promise) });
    await user.type(screen.getByPlaceholderText('fix-auth-bug'), 'agent');
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(screen.getByRole('button', { name: 'Starting...' })).toBeDisabled();
    gate.resolve();
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
  });

  it('closes on backdrop click and Cancel, but not on clicks inside', async () => {
    const user = userEvent.setup();
    const { props, container } = renderDialog();
    await user.click(screen.getByRole('dialog', { name: 'New agent' }));
    expect(props.onClose).not.toHaveBeenCalled();
    const backdrop = container.querySelector('.dialog-backdrop');
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as Element);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('adds a project inline and selects it', async () => {
    const user = userEvent.setup();
    const newProject: ProjectSummary = { id: 'p3', name: 'fresh', repoRoot: '/fresh' };
    const { props } = renderDialog({ onCreateProject: vi.fn().mockResolvedValue(newProject) });
    await user.click(screen.getByRole('button', { name: '+ New project' }));
    await user.type(screen.getByPlaceholderText('my-other-repo'), 'fresh');
    await user.type(screen.getByPlaceholderText('/Users/you/code/my-other-repo'), '/fresh');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    expect(props.onCreateProject).toHaveBeenCalledWith('fresh', '/fresh');
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue('p3'));
    expect(within(screen.getByLabelText('Project')).getByText('fresh')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('my-other-repo')).toBeNull();
  });

  it('validates the inline project form before creating', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.click(screen.getByRole('button', { name: '+ New project' }));
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    expect(screen.getByText('Give the project a name and an absolute path.')).toHaveClass('form-error');
    expect(props.onCreateProject).not.toHaveBeenCalled();
  });

  it('shows the error and keeps the inline form open when onCreateProject rejects', async () => {
    const user = userEvent.setup();
    renderDialog({ onCreateProject: vi.fn().mockRejectedValue(new Error('bad path')) });
    await user.click(screen.getByRole('button', { name: '+ New project' }));
    await user.type(screen.getByPlaceholderText('my-other-repo'), 'fresh');
    await user.type(screen.getByPlaceholderText('/Users/you/code/my-other-repo'), '/fresh');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    expect(await screen.findByText('bad path')).toHaveClass('form-error');
    expect(screen.getByPlaceholderText('my-other-repo')).toBeInTheDocument();
  });

  it('stringifies a non-Error project-creation failure', async () => {
    const user = userEvent.setup();
    renderDialog({ onCreateProject: vi.fn().mockRejectedValue('rejected') });
    await user.click(screen.getByRole('button', { name: '+ New project' }));
    await user.type(screen.getByPlaceholderText('my-other-repo'), 'fresh');
    await user.type(screen.getByPlaceholderText('/Users/you/code/my-other-repo'), '/fresh');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    expect(await screen.findByText('rejected')).toHaveClass('form-error');
  });

  it('cancels the inline project form', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: '+ New project' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('my-other-repo')).toBeNull();
    expect(screen.getByRole('button', { name: '+ New project' })).toBeInTheDocument();
  });
});
