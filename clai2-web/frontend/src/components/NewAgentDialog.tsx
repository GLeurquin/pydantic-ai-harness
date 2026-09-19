import { useState } from 'react';

import type {
  ApprovalMode,
  CreateAgentRequest,
  FetchedIssue,
  ProjectSummary,
  RedactedGithubSettings,
  RedactedProfile,
} from '../api/types';
import { errorMessage } from '../errors';
import { MODE_LABELS } from './SettingsPanel';

export interface NewAgentDialogProps {
  models: RedactedProfile[];
  projects: ProjectSummary[];
  /** The sidebar's active project filter, if any, to preselect. */
  defaultProjectId?: string;
  githubSettings: RedactedGithubSettings;
  onCreate: (request: CreateAgentRequest) => Promise<void>;
  onCreateProject: (name: string, path: string) => Promise<ProjectSummary>;
  onFetchGithubIssue: (issueRef: string) => Promise<FetchedIssue>;
  onSetGithubToken: (token: string) => Promise<void>;
  onClose: () => void;
  onManageModels: () => void;
}

export function NewAgentDialog({
  models,
  projects,
  defaultProjectId,
  githubSettings,
  onCreate,
  onCreateProject,
  onFetchGithubIssue,
  onSetGithubToken,
  onClose,
  onManageModels,
}: NewAgentDialogProps) {
  const [name, setName] = useState('');
  const [newProject, setNewProject] = useState<ProjectSummary | null>(null);
  const options = newProject && !projects.some((project) => project.id === newProject.id) ? [...projects, newProject] : projects;
  const [projectId, setProjectId] = useState(() => defaultProjectId ?? projects[0]?.id ?? '');
  const [addingProject, setAddingProject] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  const [useWorktree, setUseWorktree] = useState(true);
  const [baseBranch, setBaseBranch] = useState('');
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('always_ask');
  const [modelProfileId, setModelProfileId] = useState('');
  const [fromGithub, setFromGithub] = useState(false);
  const [issueRef, setIssueRef] = useState('');
  const [issue, setIssue] = useState<FetchedIssue | null>(null);
  const [issueBusy, setIssueBusy] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const addProject = async () => {
    if (!projectName.trim() || !projectPath.trim()) {
      setProjectError('Give the project a name and an absolute path.');
      return;
    }
    setProjectBusy(true);
    setProjectError(null);
    try {
      const project = await onCreateProject(projectName.trim(), projectPath.trim());
      setNewProject(project);
      setProjectId(project.id);
      setAddingProject(false);
      setProjectName('');
      setProjectPath('');
    } catch (failure) {
      setProjectError(errorMessage(failure));
    } finally {
      setProjectBusy(false);
    }
  };

  const saveToken = async () => {
    setTokenBusy(true);
    setTokenError(null);
    try {
      await onSetGithubToken(tokenDraft.trim());
      setTokenDraft('');
    } catch (failure) {
      setTokenError(errorMessage(failure));
    } finally {
      setTokenBusy(false);
    }
  };

  const fetchIssue = async () => {
    setIssueBusy(true);
    setIssueError(null);
    try {
      const fetched = await onFetchGithubIssue(issueRef.trim());
      setIssue(fetched);
      if (!name.trim()) {
        setName(fetched.title.slice(0, 80));
      }
    } catch (failure) {
      setIssueError(errorMessage(failure));
    } finally {
      setIssueBusy(false);
    }
  };

  const submit = async () => {
    if (!name.trim()) {
      setError('Give the agent a name.');
      return;
    }
    if (!projectId) {
      setError('Choose or add a project.');
      return;
    }
    if (fromGithub && !issue) {
      setError('Fetch the issue first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const request: CreateAgentRequest = { name: name.trim(), projectId, useWorktree, approvalMode };
      if (useWorktree && baseBranch.trim()) {
        request.baseBranch = baseBranch.trim();
      }
      if (modelProfileId) {
        request.modelProfileId = modelProfileId;
      }
      if (fromGithub && issue) {
        request.initialPrompt = issue.prompt;
      }
      await onCreate(request);
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="New agent" onClick={(click) => click.stopPropagation()}>
        <h2>New agent</h2>
        <label>
          Name
          <input
            autoFocus
            value={name}
            onChange={(change) => setName(change.target.value)}
            placeholder="fix-auth-bug"
          />
        </label>
        <label>
          Project
          <select value={projectId} onChange={(change) => setProjectId(change.target.value)} aria-label="Project">
            {options.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        {addingProject ? (
          <>
            <label>
              Project name
              <input value={projectName} onChange={(change) => setProjectName(change.target.value)} placeholder="my-other-repo" />
            </label>
            <label>
              Repository path (absolute)
              <input
                value={projectPath}
                onChange={(change) => setProjectPath(change.target.value)}
                placeholder="/Users/you/code/my-other-repo"
              />
            </label>
            {projectError ? <div className="form-error">{projectError}</div> : null}
            <div className="dialog-actions">
              <button onClick={() => setAddingProject(false)}>Cancel</button>
              <button className="primary" onClick={() => void addProject()} disabled={projectBusy}>
                {projectBusy ? 'Adding...' : 'Add project'}
              </button>
            </div>
          </>
        ) : (
          <button onClick={() => setAddingProject(true)}>+ New project</button>
        )}
        {addingProject ? null : (
          <>
            <div className="dialog-row">
              <input
                id="from-github"
                type="checkbox"
                checked={fromGithub}
                onChange={(change) => {
                  setFromGithub(change.target.checked);
                  setIssue(null);
                  setIssueError(null);
                }}
              />
              <label htmlFor="from-github">Import from a GitHub issue</label>
            </div>
            {fromGithub ? (
              <div className="github-import">
                {githubSettings.hasToken ? (
                  <>
                    <label>
                      Issue
                      <input
                        value={issueRef}
                        onChange={(change) => {
                          setIssueRef(change.target.value);
                          setIssue(null);
                        }}
                        placeholder="owner/repo#123 or a github.com issue URL"
                      />
                    </label>
                    {issueError ? <div className="form-error">{issueError}</div> : null}
                    {issue ? (
                      <div className="issue-preview">
                        <strong>{issue.title}</strong>
                        <p>{issue.body.length > 280 ? `${issue.body.slice(0, 280)}...` : issue.body}</p>
                        <a href={issue.url} target="_blank" rel="noreferrer">
                          {issue.url}
                        </a>
                      </div>
                    ) : null}
                    <div className="dialog-row">
                      <button onClick={() => void fetchIssue()} disabled={issueBusy || !issueRef.trim()}>
                        {issueBusy ? 'Fetching...' : issue ? 'Fetch again' : 'Fetch issue'}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <label>
                      GitHub personal access token
                      <input
                        type="password"
                        value={tokenDraft}
                        onChange={(change) => setTokenDraft(change.target.value)}
                        placeholder="ghp_..."
                      />
                    </label>
                    {tokenError ? <div className="form-error">{tokenError}</div> : null}
                    <div className="dialog-row">
                      <button onClick={() => void saveToken()} disabled={tokenBusy || !tokenDraft.trim()}>
                        {tokenBusy ? 'Saving...' : 'Save token'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : null}
            <div className="dialog-row">
              <input
                id="use-worktree"
                type="checkbox"
                checked={useWorktree}
                onChange={(change) => setUseWorktree(change.target.checked)}
              />
              <label htmlFor="use-worktree">Create an isolated worktree and branch</label>
            </div>
            {useWorktree ? (
              <label>
                Base branch (blank for the current branch)
                <input value={baseBranch} onChange={(change) => setBaseBranch(change.target.value)} placeholder="main" />
              </label>
            ) : null}
            <label>
              Approval mode
              <select value={approvalMode} onChange={(change) => setApprovalMode(change.target.value as ApprovalMode)}>
                {Object.entries(MODE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model
              <select value={modelProfileId} onChange={(change) => setModelProfileId(change.target.value)}>
                <option value="">Default (server environment)</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
            <button className="link-button" onClick={onManageModels}>
              Manage model profiles
            </button>
            {error ? <div className="form-error">{error}</div> : null}
            <div className="dialog-actions">
              <button onClick={onClose}>Cancel</button>
              <button className="primary" onClick={() => void submit()} disabled={busy}>
                {busy ? 'Starting...' : 'Start agent'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
