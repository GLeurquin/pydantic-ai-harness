import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import type { CreateAgentRequest, FetchedIssue, ProjectSummary, RedactedProfile } from '../api/types';
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

function makeProfile(overrides: Partial<RedactedProfile> = {}): RedactedProfile {
  return {
    id: 'm1',
    label: 'Sonnet',
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

const models: RedactedProfile[] = [makeProfile(), makeProfile({ id: 'm2', label: 'GPT', provider: 'openai', model: 'gpt-6' })];

function renderDialog(props: Partial<Parameters<typeof NewAgentDialog>[0]> = {}) {
  const defaults = {
    models,
    projects,
    githubSettings: { hasToken: false },
    onCreate: vi.fn<(request: CreateAgentRequest) => Promise<void>>().mockResolvedValue(undefined),
    onCreateProject: vi.fn<(name: string, path: string) => Promise<ProjectSummary>>(),
    onFetchGithubIssue: vi.fn<(issueRef: string) => Promise<FetchedIssue>>(),
    onSetGithubToken: vi.fn<(token: string) => Promise<void>>().mockResolvedValue(undefined),
    onClose: vi.fn(),
    onManageModels: vi.fn(),
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

  it('defaults the model select to the server environment and lists every profile', () => {
    renderDialog();
    const select = screen.getByLabelText('Model');
    expect(select).toHaveValue('');
    const options = within(select).getAllByRole('option');
    expect(options.map((option) => [option.getAttribute('value'), option.textContent])).toEqual([
      ['', 'Default (server environment)'],
      ['m1', 'Sonnet'],
      ['m2', 'GPT'],
    ]);
  });

  it('includes the chosen model profile in the created request', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn<(request: CreateAgentRequest) => Promise<void>>().mockResolvedValue(undefined);
    renderDialog({ onCreate });
    await user.type(screen.getByPlaceholderText('fix-auth-bug'), 'agent');
    await user.selectOptions(screen.getByLabelText('Model'), 'm2');
    await user.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(onCreate.mock.calls).toStrictEqual([
      [{ name: 'agent', projectId: 'p1', useWorktree: true, approvalMode: 'always_ask', modelProfileId: 'm2' }],
    ]);
  });

  it('fires onManageModels from the Manage model profiles button', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Manage model profiles' }));
    expect(props.onManageModels).toHaveBeenCalledTimes(1);
  });

  describe('GitHub import', () => {
    function makeIssue(overrides: Partial<FetchedIssue> = {}): FetchedIssue {
      return {
        title: 'Auth tokens expire mid-session',
        body: 'Users get logged out unexpectedly.',
        url: 'https://github.com/o/r/issues/42',
        prompt: 'Work on this GitHub issue:\n\n# Auth tokens expire mid-session\n\n...',
        ...overrides,
      };
    }

    it('hides the import section until the checkbox is checked', () => {
      renderDialog();
      expect(screen.queryByLabelText('Issue')).toBeNull();
      expect(screen.queryByLabelText('GitHub personal access token')).toBeNull();
    });

    it('shows a token field when no token is configured', async () => {
      const user = userEvent.setup();
      renderDialog({ githubSettings: { hasToken: false } });
      await user.click(screen.getByLabelText('Import from a GitHub issue'));
      expect(screen.getByLabelText('GitHub personal access token')).toBeInTheDocument();
      expect(screen.queryByLabelText('Issue')).toBeNull();
    });

    it('disables Save token until a token is typed', async () => {
      const user = userEvent.setup();
      renderDialog({ githubSettings: { hasToken: false } });
      await user.click(screen.getByLabelText('Import from a GitHub issue'));
      expect(screen.getByRole('button', { name: 'Save token' })).toBeDisabled();
      await user.type(screen.getByLabelText('GitHub personal access token'), 'ghp_secret');
      expect(screen.getByRole('button', { name: 'Save token' })).toBeEnabled();
    });

    it('saves a trimmed token and clears the draft', async () => {
      const user = userEvent.setup();
      const onSetGithubToken = vi.fn<(token: string) => Promise<void>>().mockResolvedValue(undefined);
      renderDialog({ githubSettings: { hasToken: false }, onSetGithubToken });
      await user.click(screen.getByLabelText('Import from a GitHub issue'));
      await user.type(screen.getByLabelText('GitHub personal access token'), '  ghp_secret  ');
      await user.click(screen.getByRole('button', { name: 'Save token' }));
      expect(onSetGithubToken).toHaveBeenCalledWith('ghp_secret');
      await waitFor(() => expect(screen.getByLabelText('GitHub personal access token')).toHaveValue(''));
    });

    it('shows the busy label while saving a token', async () => {
      const user = userEvent.setup();
      const gate = deferred<void>();
      renderDialog({
        githubSettings: { hasToken: false },
        onSetGithubToken: vi.fn<(token: string) => Promise<void>>(() => gate.promise),
      });
      await user.click(screen.getByLabelText('Import from a GitHub issue'));
      await user.type(screen.getByLabelText('GitHub personal access token'), 'ghp_secret');
      await user.click(screen.getByRole('button', { name: 'Save token' }));
      expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
      gate.resolve();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Save token' })).toBeInTheDocument());
    });

    it('shows an error and keeps the draft when saving a token fails', async () => {
      const user = userEvent.setup();
      renderDialog({
        githubSettings: { hasToken: false },
        onSetGithubToken: vi.fn<(token: string) => Promise<void>>().mockRejectedValue(new Error('bad token')),
      });
      await user.click(screen.getByLabelText('Import from a GitHub issue'));
      await user.type(screen.getByLabelText('GitHub personal access token'), 'ghp_bad');
      await user.click(screen.getByRole('button', { name: 'Save token' }));
      expect(await screen.findByText('bad token')).toHaveClass('form-error');
      expect(screen.getByLabelText('GitHub personal access token')).toHaveValue('ghp_bad');
    });

    it('shows the issue field directly when a token is already configured', async () => {
      const user = userEvent.setup();
      renderDialog({ githubSettings: { hasToken: true } });
      await user.click(screen.getByLabelText('Import from a GitHub issue'));
      expect(screen.getByLabelText('Issue')).toBeInTheDocument();
      expect(screen.queryByLabelText('GitHub personal access token')).toBeNull();
      expect(screen.getByRole('button', { name: 'Fetch issue' })).toBeDisabled();
    });

    it('fetches an issue, shows a preview, and prefills a blank name', async () => {
      const user = userEvent.setup();
      const onFetchGithubIssue = vi.fn<(issueRef: string) => Promise<FetchedIssue>>().mockResolvedValue(makeIssue());
      renderDialog({ githubSettings: { hasToken: true }, onFetchGithubIssue });
      await user.click(screen.getByLabelText('Import from a GitHub issue'));
      await user.type(screen.getByLabelText('Issue'), '  o/r#42  ');
      await user.click(screen.getByRole('button', { name: 'Fetch issue' }));
      expect(onFetchGithubIssue).toHaveBeenCalledWith('o/r#42');
      expect(await screen.findByText('Auth tokens expire mid-session')).toBeInTheDocument();
      expect(screen.getByText('Users get logged out unexpectedly.')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('fix-auth-bug')).toHaveValue('Auth tokens expire mid-session');
      expect(screen.getByRole('button', { name: 'Fetch again' })).toBeInTheDocument();
    });

    it('does not overwrite an existing name when fetching an issue', async () => {
      const user = userEvent.setup();
      const onFetchGithubIssue = vi.fn<(issueRef: string) => Promise<FetchedIssue>>().mockResolvedValue(makeIssue());
      renderDialog({ githubSettings: { hasToken: true }, onFetchGithubIssue });
      await user.type(screen.getByPlaceholderText('fix-auth-bug'), 'my custom name');
      await user.click(screen.getByLabelText('Import from a GitHub issue'));
      await user.type(screen.getByLabelText('Issue'), 'o/r#42');
      await user.click(screen.getByRole('button', { name: 'Fetch issue' }));
      await screen.findByText('Auth tokens expire mid-session');
      expect(screen.getByPlaceholderText('fix-auth-bug')).toHaveValue('my custom name');
    });

    it('truncates a long issue body in the preview', async () => {
      const user = userEvent.setup();
      const longBody = 'x'.repeat(300);
      renderDialog({
        githubSettings: { hasToken: true },
        onFetchGithubIssue: vi.fn<(issueRef: string) => Promise<FetchedIssue>>().mockResolvedValue(makeIssue({ body: longBody })),
      });
      await user.click(screen.getByLabelText('Import from a GitHub issue'));
      await user.type(screen.getByLabelText('Issue'), 'o/r#42');
      await user.click(screen.getByRole('button', { name: 'Fetch issue' }));
      expect(await screen.findByText(`${'x'.repeat(280)}...`)).toBeInTheDocument();
    });

    it('shows a short issue body in full', async () => {
      const user = userEvent.setup();
      renderDialog({
        githubSettings: { hasToken: true },
        onFetchGithubIssue: vi
          .fn<(issueRef: string) => Promise<FetchedIssue>>()
          .mockResolvedValue(makeIssue({ body: 'short body' })),
      });
      await user.click(screen.getByLabelText('Import from a GitHub issue'));
      await user.type(screen.getByLabelText('Issue'), 'o/r#42');
      await user.click(screen.getByRole('button', { name: 'Fetch issue' }));
      expect(await screen.findByText('short body')).toBeInTheDocument();
    });

    it('shows the busy label while fetching an issue', async () => {
      const user = userEvent.setup();
      const gate = deferred<FetchedIssue>();
      renderDialog({
        githubSettings: { hasToken: true },
        onFetchGithubIssue: vi.fn<(issueRef: string) => Promise<FetchedIssue>>(() => gate.promise),
      });
      await user.click(screen.getByLabelText('Import from a GitHub issue'));
      await user.type(screen.getByLabelText('Issue'), 'o/r#42');
      await user.click(screen.getByRole('button', { name: 'Fetch issue' }));
      expect(screen.getByRole('button', { name: 'Fetching...' })).toBeDisabled();
      gate.resolve(makeIssue());
      await waitFor(() => expect(screen.getByRole('button', { name: 'Fetch again' })).toBeInTheDocument());
    });

    it('shows an error and no preview when fetching an issue fails', async () => {
      const user = userEvent.setup();
      renderDialog({
        githubSettings: { hasToken: true },
        onFetchGithubIssue: vi.fn<(issueRef: string) => Promise<FetchedIssue>>().mockRejectedValue(new Error('not found')),
      });
      await user.click(screen.getByLabelText('Import from a GitHub issue'));
      await user.type(screen.getByLabelText('Issue'), 'o/r#404');
      await user.click(screen.getByRole('button', { name: 'Fetch issue' }));
      expect(await screen.findByText('not found')).toHaveClass('form-error');
      expect(screen.getByRole('button', { name: 'Fetch issue' })).toBeInTheDocument();
    });

    it('clears a fetched preview when the issue reference is edited', async () => {
      const user = userEvent.setup();
      renderDialog({
        githubSettings: { hasToken: true },
        onFetchGithubIssue: vi.fn<(issueRef: string) => Promise<FetchedIssue>>().mockResolvedValue(makeIssue()),
      });
      await user.click(screen.getByLabelText('Import from a GitHub issue'));
      await user.type(screen.getByLabelText('Issue'), 'o/r#42');
      await user.click(screen.getByRole('button', { name: 'Fetch issue' }));
      await screen.findByText('Auth tokens expire mid-session');
      await user.type(screen.getByLabelText('Issue'), '3');
      expect(screen.queryByText('Auth tokens expire mid-session')).toBeNull();
      expect(screen.getByRole('button', { name: 'Fetch issue' })).toBeInTheDocument();
    });

    it('clears the fetched preview and any error when the checkbox is toggled off', async () => {
      const user = userEvent.setup();
      renderDialog({
        githubSettings: { hasToken: true },
        onFetchGithubIssue: vi.fn<(issueRef: string) => Promise<FetchedIssue>>().mockResolvedValue(makeIssue()),
      });
      await user.click(screen.getByLabelText('Import from a GitHub issue'));
      await user.type(screen.getByLabelText('Issue'), 'o/r#42');
      await user.click(screen.getByRole('button', { name: 'Fetch issue' }));
      await screen.findByText('Auth tokens expire mid-session');
      await user.click(screen.getByLabelText('Import from a GitHub issue'));
      await user.click(screen.getByLabelText('Import from a GitHub issue'));
      expect(screen.queryByText('Auth tokens expire mid-session')).toBeNull();
      expect(screen.getByRole('button', { name: 'Fetch issue' })).toBeInTheDocument();
    });

    it('blocks submission until an issue is fetched', async () => {
      const user = userEvent.setup();
      const { props } = renderDialog({ githubSettings: { hasToken: true } });
      await user.type(screen.getByPlaceholderText('fix-auth-bug'), 'agent');
      await user.click(screen.getByLabelText('Import from a GitHub issue'));
      await user.click(screen.getByRole('button', { name: 'Start agent' }));
      expect(screen.getByText('Fetch the issue first.')).toHaveClass('form-error');
      expect(props.onCreate).not.toHaveBeenCalled();
    });

    it('includes the fetched issue prompt as the initial prompt on submit', async () => {
      const user = userEvent.setup();
      const onCreate = vi.fn<(request: CreateAgentRequest) => Promise<void>>().mockResolvedValue(undefined);
      const issue = makeIssue();
      renderDialog({
        githubSettings: { hasToken: true },
        onCreate,
        onFetchGithubIssue: vi.fn<(issueRef: string) => Promise<FetchedIssue>>().mockResolvedValue(issue),
      });
      await user.click(screen.getByLabelText('Import from a GitHub issue'));
      await user.type(screen.getByLabelText('Issue'), 'o/r#42');
      await user.click(screen.getByRole('button', { name: 'Fetch issue' }));
      await screen.findByText('Auth tokens expire mid-session');
      await user.click(screen.getByRole('button', { name: 'Start agent' }));
      expect(onCreate.mock.calls).toStrictEqual([
        [
          {
            name: 'Auth tokens expire mid-session',
            projectId: 'p1',
            useWorktree: true,
            approvalMode: 'always_ask',
            initialPrompt: issue.prompt,
          },
        ],
      ]);
    });
  });
});
