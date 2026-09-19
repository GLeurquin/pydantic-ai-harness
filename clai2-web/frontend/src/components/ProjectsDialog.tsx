import { useState } from 'react';

import type { ProjectSummary } from '../api/types';
import { errorMessage } from '../errors';

export interface ProjectsDialogProps {
  projects: ProjectSummary[];
  onCreateProject: (name: string, path: string) => Promise<ProjectSummary>;
  onDeleteProject: (projectId: string) => Promise<void>;
  onClose: () => void;
}

type Editing = { kind: 'list' } | { kind: 'new' };

export function ProjectsDialog({ projects, onCreateProject, onDeleteProject, onClose }: ProjectsDialogProps) {
  const [editing, setEditing] = useState<Editing>({ kind: 'list' });
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const add = async () => {
    if (!name.trim() || !path.trim()) {
      setError('Give the project a name and an absolute path.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreateProject(name.trim(), path.trim());
      setName('');
      setPath('');
      setEditing({ kind: 'list' });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (project: ProjectSummary) => {
    setError(null);
    setDeletingId(project.id);
    try {
      await onDeleteProject(project.id);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog wide" role="dialog" aria-label="Projects" onClick={(click) => click.stopPropagation()}>
        <h2>Projects</h2>
        {error ? <div className="form-error">{error}</div> : null}
        {editing.kind === 'list' ? (
          <>
            {projects.length === 0 ? <div className="hint">No projects yet.</div> : null}
            <ul className="model-list">
              {projects.map((project) => (
                <li key={project.id} className="model-list-row">
                  <span className="model-list-name">
                    {project.name}
                    <span className="model-list-meta">{project.repoRoot}</span>
                  </span>
                  <button className="danger" onClick={() => void remove(project)} disabled={deletingId === project.id}>
                    {deletingId === project.id ? 'Removing...' : 'Remove'}
                  </button>
                </li>
              ))}
            </ul>
            <div className="dialog-actions">
              <button onClick={onClose}>Close</button>
              <button className="primary" onClick={() => setEditing({ kind: 'new' })}>
                New project
              </button>
            </div>
          </>
        ) : (
          <>
            <label>
              Project name
              <input autoFocus value={name} onChange={(change) => setName(change.target.value)} placeholder="my-other-repo" />
            </label>
            <label>
              Repository path (absolute)
              <input
                value={path}
                onChange={(change) => setPath(change.target.value)}
                placeholder="/Users/you/code/my-other-repo"
              />
            </label>
            <div className="dialog-actions">
              <button
                onClick={() => {
                  setEditing({ kind: 'list' });
                  setError(null);
                }}
              >
                Cancel
              </button>
              <button className="primary" onClick={() => void add()} disabled={busy}>
                {busy ? 'Adding...' : 'Add project'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
