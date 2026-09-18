import { useState } from 'react';

import type { ApprovalMode, CreateAgentRequest, ProjectSummary } from '../api/types';
import { MODE_LABELS } from './SettingsPanel';

export interface NewAgentDialogProps {
  projects: ProjectSummary[];
  /** The sidebar's active project filter, if any, to preselect. */
  defaultProjectId?: string;
  onCreate: (request: CreateAgentRequest) => Promise<void>;
  onCreateProject: (name: string, path: string) => Promise<ProjectSummary>;
  onClose: () => void;
}

export function NewAgentDialog({ projects, defaultProjectId, onCreate, onCreateProject, onClose }: NewAgentDialogProps) {
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
      setProjectError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setProjectBusy(false);
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
    setBusy(true);
    setError(null);
    try {
      const request: CreateAgentRequest = { name: name.trim(), projectId, useWorktree, approvalMode };
      if (useWorktree && baseBranch.trim()) {
        request.baseBranch = baseBranch.trim();
      }
      await onCreate(request);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
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
