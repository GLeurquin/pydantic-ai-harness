import { useState } from 'react';

import type { FolderSummary } from '../api/types';
import { errorMessage } from '../errors';

export interface FoldersDialogProps {
  folders: FolderSummary[];
  onCreateFolder: (name: string) => Promise<FolderSummary>;
  onDeleteFolder: (folderId: string) => Promise<void>;
  onClose: () => void;
}

type Editing = { kind: 'list' } | { kind: 'new' };

export function FoldersDialog({ folders, onCreateFolder, onDeleteFolder, onClose }: FoldersDialogProps) {
  const [editing, setEditing] = useState<Editing>({ kind: 'list' });
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const add = async () => {
    if (!name.trim()) {
      setError('Give the folder a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreateFolder(name.trim());
      setName('');
      setEditing({ kind: 'list' });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (folder: FolderSummary) => {
    setError(null);
    setDeletingId(folder.id);
    try {
      await onDeleteFolder(folder.id);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="Folders" onClick={(click) => click.stopPropagation()}>
        <h2>Folders</h2>
        <p className="hint">Group agents in the sidebar. Removing a folder just unfiles its agents.</p>
        {error ? <div className="form-error">{error}</div> : null}
        {editing.kind === 'list' ? (
          <>
            {folders.length === 0 ? <div className="hint">No folders yet.</div> : null}
            <ul className="model-list">
              {folders.map((folder) => (
                <li key={folder.id} className="model-list-row">
                  <span className="model-list-name">{folder.name}</span>
                  <button className="danger" onClick={() => void remove(folder)} disabled={deletingId === folder.id}>
                    {deletingId === folder.id ? 'Removing...' : 'Remove'}
                  </button>
                </li>
              ))}
            </ul>
            <div className="dialog-actions">
              <button onClick={onClose}>Close</button>
              <button className="primary" onClick={() => setEditing({ kind: 'new' })}>
                New folder
              </button>
            </div>
          </>
        ) : (
          <>
            <label>
              Folder name
              <input autoFocus value={name} onChange={(change) => setName(change.target.value)} placeholder="Q3 launch" />
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
                {busy ? 'Adding...' : 'Add folder'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
